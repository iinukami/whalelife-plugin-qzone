/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { build } from 'esbuild';
import { mkdir, mkdtemp, copyFile, writeFile, readFile, readdir, lstat, realpath, open, rename, rm, unlink } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const copied = ['plugin.yaml', 'README.md', 'LICENSE', 'LICENSE-ADDITIONAL', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md',
  'sub/gallery/plugin.yaml', 'scripts/qzone-gallery-migration.mjs'];
const required = [...copied, 'index.ts', 'sub/gallery/index.ts', 'package.json', 'package-lock.json'];
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const exists = async path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
async function ordinaryDirectory(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || resolve(await realpath(path)) !== resolve(path))
    throw Error('Build directory must not be a link: ' + path);
}

/** Validate all emitted paths, installed versions and bytes before replacing an output. */
export async function validatePackage(target, lock) {
  const allowed = new Set([...required, 'BUILD.json', 'node_modules/.package-lock.json']);
  const packages = Object.entries(lock.packages).filter(([path, entry]) => path && !entry.dev && !entry.link)
    .map(([path]) => path).sort((a, b) => b.length - a.length);
  const files = [], seen = new Set();
  const walk = async (directory, prefix = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name, path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw Error('Package contains a link: ' + relative);
      if (entry.isDirectory()) {
        const known = [...allowed].some(file => file.startsWith(relative + '/'))
          || packages.some(pkg => pkg === relative || pkg.startsWith(relative + '/') || relative.startsWith(pkg + '/'));
        if (!known) throw Error('Unexpected package directory: ' + relative);
        await walk(path, relative + '/');
      } else if (entry.isFile()) {
        const owner = packages.find(pkg => relative.startsWith(pkg + '/'));
        if (!allowed.has(relative) && !owner) throw Error('Unexpected package file: ' + relative);
        if (owner && relative === owner + '/package.json' && (await json(path)).version !== lock.packages[owner].version)
          throw Error('Installed version differs from source lock: ' + owner);
        seen.add(relative);
        if (relative !== 'BUILD.json') { const bytes = await readFile(path); files.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) }); }
      } else throw Error('Unsupported package entry: ' + relative);
    }
  };
  await ordinaryDirectory(target); await walk(target);
  for (const path of required) if (!seen.has(path)) throw Error('Missing package file: ' + path);
  for (const name of Object.keys(lock.packages[''].dependencies ?? {}))
    if (!seen.has('node_modules/' + name + '/package.json')) throw Error('Missing production dependency: ' + name);
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

export async function buildPackage() {
  // Anchor to this source checkout, never the caller's cwd or an installed plugin.
  const source = fileURLToPath(new URL('..', import.meta.url));
  await ordinaryDirectory(source);
  const pkg = await json(join(source, 'package.json')), lockBytes = await readFile(join(source, 'package-lock.json'));
  const lock = JSON.parse(lockBytes), manifest = await readFile(join(source, 'plugin.yaml'), 'utf8');
  if (pkg.name !== 'whalelife-plugin-qzone' || pkg.scripts?.build !== 'node scripts/build.mjs' || !pkg.devDependencies?.esbuild
    || !await exists(join(source, 'src/index.ts'))) throw Error('Build requires the QZone source checkout');
  if (lock.lockfileVersion !== 3 || lock.name !== pkg.name || lock.version !== pkg.version || lock.packages['']?.version !== pkg.version
    || JSON.stringify(lock.packages[''].dependencies) !== JSON.stringify(pkg.dependencies)
    || !manifest.split(/\r?\n/).includes('version: ' + pkg.version)) throw Error('Package, manifest and source lock must agree');
  const dist = join(source, 'dist'), target = join(dist, 'qzone');
  if (!await exists(dist)) await mkdir(dist);
  await ordinaryDirectory(dist);
  if (await exists(target)) await ordinaryDirectory(target);
  const lockPath = join(dist, '.qzone-build.lock');
  const handle = await open(lockPath, 'wx'); // Exclusive; never steal another build's lock.
  let stage, preserve = false;
  try {
    stage = await mkdtemp(join(dist, '.qzone-build-'));
    const output = join(stage, 'qzone'); await mkdir(join(output, 'sub/gallery'), { recursive: true });
    for (const [entry, out] of [['src/index.ts', 'index.ts'], ['src/gallery.ts', 'sub/gallery/index.ts']])
      await build({ absWorkingDir: source, entryPoints: [entry], outfile: join(output, out), bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external' });
    for (const name of copied) { await mkdir(dirname(join(output, name)), { recursive: true }); await copyFile(join(source, name), join(output, name)); }
    const runtimePackage = { ...pkg }; delete runtimePackage.devDependencies; delete runtimePackage.scripts;
    // Keep the source's exact resolved graph and integrity; only omit development root declarations.
    const runtimeLock = structuredClone(lock); delete runtimeLock.packages[''].devDependencies;
    await writeFile(join(output, 'package.json'), JSON.stringify(runtimePackage, null, 2) + '\n');
    await writeFile(join(output, 'package-lock.json'), JSON.stringify(runtimeLock, null, 2) + '\n');
    const npm = resolve(process.execPath, '..', 'node_modules/npm/bin/npm-cli.js');
    const result = spawnSync(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--bin-links=false', '--no-audit', '--no-fund'],
      { cwd: output, stdio: 'inherit', windowsHide: true });
    if (result.error || result.status !== 0) throw Error('Locked dependency installation failed');
    if (JSON.stringify(await json(join(output, 'package-lock.json'))) !== JSON.stringify(runtimeLock)) throw Error('Dependency installation changed the lock');
    const files = await validatePackage(output, lock);
    await writeFile(join(output, 'BUILD.json'), JSON.stringify({ schema: 1, name: pkg.name, version: pkg.version, sourceLockSha256: sha256(lockBytes), files }, null, 2) + '\n');
    await ordinaryDirectory(dist);
    const previous = join(stage, 'previous'); let moved = false;
    if (await exists(target)) { await ordinaryDirectory(target); await rename(target, previous); moved = true; }
    try { await rename(output, target); }
    catch (error) {
      if (moved) { try { await rename(previous, target); } catch (rollback) { preserve = true; throw new AggregateError([error, rollback], 'Previous build preserved at ' + previous); } }
      throw error;
    }
    console.log('Built ' + target);
  } finally {
    try {
      if (stage && !preserve) {
        await ordinaryDirectory(dist); await ordinaryDirectory(stage);
        if (dirname(resolve(stage)) !== resolve(dist)) throw Error('Refusing cleanup outside owned build directory');
        await rm(stage, { recursive: true, force: true });
      }
    } finally { await handle.close(); await unlink(lockPath); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildPackage();
