import { readFile, writeFile, rename, lstat, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
// Installer helper: inputs come from authenticated public /api/status and QZone config.
// Never reads the host's private plugin state. Persist the returned config before retiring the old bridge.
export function migrateGalleryChoice(plugins, config) {
  if (!Array.isArray(plugins) || !config || config.version !== 1) throw Error('Invalid migration snapshot');
  if (config.galleryEnabled !== undefined) {
    if (typeof config.galleryEnabled !== 'boolean') throw Error('Invalid gallery choice');
    return { ...config };
  }
  const legacy = plugins.find(plugin => plugin.id === 'qq/qzone/gallery');
  if (!legacy) return { ...config };
  if (typeof legacy.enabled !== 'boolean') throw Error('Missing public legacy enabled state');
  return { ...config, galleryEnabled: legacy.enabled };
}

// Run before replacing/reloading an existing installation; --apply is explicit.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2), option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
  if (!args.includes('--target')) throw Error('Specify --target for the installed QQ directory');
  const target = resolve(option('--target')), base = option('--base') ?? 'http://127.0.0.1:9270';
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password)
    throw Error('Use the authenticated local host API');
  const dir = join(target, 'sub/qzone/data'), path = join(dir, 'config.json');
  for (const root of [target, dir]) if (resolve(await realpath(root)) !== root || (await lstat(root)).isSymbolicLink()) throw Error('Unexpected installation path');
  if ((await lstat(path)).isSymbolicLink()) throw Error('Config must not be a link');
  const login = await fetch(url.origin + '/api/login', { method: 'POST', headers: { Origin: url.origin, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10000) });
  if (!login.ok) throw Error('Authentication failed');
  const cookie = login.headers.getSetCookie().map(s => s.split(';')[0]).join('; ');
  const api = async path => { const r = await fetch(url.origin + path, { headers: { Cookie: cookie, Origin: url.origin }, signal: AbortSignal.timeout(10000) }); if (!r.ok) throw Error('API status ' + r.status); return r.json(); };
  const { plugins } = await api('/api/status'), { config } = await api('/plugins/qq/qzone/config');
  const before = await readFile(path, 'utf8');
  if (JSON.stringify(JSON.parse(before)) !== JSON.stringify(config)) throw Error('Disk and running configuration differ; do not overwrite pending changes');
  const next = migrateGalleryChoice(plugins, config), changed = JSON.stringify(next) !== JSON.stringify(config);
  if (args.includes('--apply') && changed) {
    await writeFile(join(dir, 'config-before-builtin-gallery.json'), before, { flag: 'wx' });
    if (await readFile(path, 'utf8') !== before) throw Error('Config changed; refresh the migration snapshot');
    const pending = join(dir, 'config-builtin-gallery.pending');
    await writeFile(pending, JSON.stringify(next, null, 2), { flag: 'wx' }); await rename(pending, path);
  }
  console.log(JSON.stringify({ changed, applied: args.includes('--apply') && changed, galleryEnabled: next.galleryEnabled ?? true, restartRequired: changed }));
}
