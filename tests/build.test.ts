import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile, readdir, symlink, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { temporaryDirectory } from '../../whalelife/tests/temporary-directory.ts';

const source = fileURLToPath(new URL('..', import.meta.url));
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const root = await temporaryDirectory('whale-qzone-build-');
  for (const dir of ['src', 'sub', 'scripts']) await cp(join(source, dir), join(root, dir), { recursive: true });
  for (const file of ['package.json', 'package-lock.json', 'plugin.yaml', 'README.md', 'LICENSE', 'LICENSE-ADDITIONAL', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md'])
    await cp(join(source, file), join(root, file));
  await symlink(join(source, 'node_modules'), join(root, 'node_modules'), 'junction');
  const caller = join(root, 'caller'); await mkdir(caller);
  const build = () => execFileSync(process.execPath, [join(root, 'scripts/build.mjs')], {
    cwd: caller, env: { ...process.env, npm_config_offline: 'true', npm_config_update_notifier: 'false' }, windowsHide: true, timeout: 60000, stdio: 'pipe',
  });
  return { root, caller, target: join(root, 'dist/qzone'), build };
}

test('clean and repeated release builds use the source lock, discard stale output and preserve the last build on failure', { timeout: 90000 }, async () => {
  const f = await fixture(), lockBytes = await readFile(join(f.root, 'package-lock.json'));
  const lock = JSON.parse(lockBytes.toString());
  f.build(); assert.deepEqual(await readdir(f.caller), [], 'the caller directory is never the build destination');
  const manifestBytes = await readFile(join(f.target, 'BUILD.json'));
  const manifest = JSON.parse(manifestBytes.toString());
  assert.equal(manifest.sourceLockSha256, digest(lockBytes)); assert.equal(manifest.version, lock.version);
  const paths = new Set(manifest.files.map((entry: any) => entry.path));
  for (const name of ['index.ts', 'sub/gallery/index.ts', 'package-lock.json', 'LICENSE', 'LICENSE-ADDITIONAL', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md']) assert.ok(paths.has(name));
  for (const entry of manifest.files) {
    const bytes = await readFile(join(f.target, entry.path));
    assert.equal(bytes.length, entry.bytes); assert.equal(digest(bytes), entry.sha256);
    if (entry.path.startsWith('node_modules/') && entry.path.endsWith('/package.json')) {
      const key = entry.path.slice(0, -'/package.json'.length);
      assert.equal(JSON.parse(bytes.toString()).version, lock.packages[key].version);
      assert.notEqual(lock.packages[key].dev, true);
    }
  }
  assert.equal(JSON.parse(await readFile(join(f.target, 'node_modules/semver/package.json'), 'utf8')).version, lock.packages['node_modules/semver'].version);
  const { validatePackage } = await import(new URL('../scripts/build.mjs', import.meta.url).href);
  assert.deepEqual(await validatePackage(f.target, lock), manifest.files);
  await mkdir(join(f.target, 'data')); await writeFile(join(f.target, 'data/synthetic.txt'), 'SYNTHETIC_ONLY');
  await writeFile(join(f.target, 'obsolete-entry.js'), 'SYNTHETIC_ONLY');
  await assert.rejects(validatePackage(f.target, lock), /Unexpected package/);
  f.build();
  assert.deepEqual(await readFile(join(f.target, 'BUILD.json')), manifestBytes, 'same source and lock yield identical file hashes');
  assert.ok(!(await readdir(f.target)).some(name => name === 'data' || name === 'obsolete-entry.js'));
  assert.deepEqual(await readFile(join(f.root, 'package-lock.json')), lockBytes, 'building never rewrites the source lock');
  await writeFile(join(f.root, 'src/index.ts'), 'this is a synthetic compile failure @');
  assert.throws(f.build);
  assert.deepEqual(await readFile(join(f.target, 'BUILD.json')), manifestBytes);
  assert.deepEqual(await readdir(join(f.root, 'dist')), ['qzone'], 'failed builds remove only their own staging and lock');
});

test('build refuses linked output and an occupied build lock without touching either destination', { timeout: 30000 }, async () => {
  const f = await fixture(), outside = await temporaryDirectory('whale-qzone-build-external-');
  await writeFile(join(outside, 'keep.txt'), 'SYNTHETIC_USER_DATA');
  await mkdir(join(f.root, 'dist')); await symlink(outside, f.target, 'junction');
  assert.throws(f.build, /Build directory must not be a link/);
  assert.deepEqual(await readdir(outside), ['keep.txt']);
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'SYNTHETIC_USER_DATA');
  await unlink(f.target); // Remove this fixture's junction, never its destination.
  const lockPath = join(f.root, 'dist/.qzone-build.lock'); await writeFile(lockPath, 'SYNTHETIC_OTHER_BUILD');
  assert.throws(f.build, /EEXIST/);
  assert.equal(await readFile(lockPath, 'utf8'), 'SYNTHETIC_OTHER_BUILD');
  assert.deepEqual(await readdir(join(f.root, 'dist')), ['.qzone-build.lock']);
});

test('a manifest or dependency mismatch fails before replacing the previous output', { timeout: 30000 }, async () => {
  const f = await fixture(); await mkdir(f.target, { recursive: true });
  await writeFile(join(f.target, 'keep.txt'), 'PREVIOUS_OUTPUT');
  const path = join(f.root, 'package.json'), pkg = JSON.parse(await readFile(path, 'utf8'));
  pkg.dependencies.sharp = '0.0.0-synthetic'; await writeFile(path, JSON.stringify(pkg));
  assert.throws(f.build, /Package, manifest and source lock must agree/);
  assert.equal(await readFile(join(f.target, 'keep.txt'), 'utf8'), 'PREVIOUS_OUTPUT');
  assert.deepEqual(await readdir(join(f.root, 'dist')), ['qzone']);
  assert.ok(resolve(f.target).startsWith(resolve(f.root)));
});
