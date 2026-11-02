import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture, until } from '../../whalelife-plugin-qq/tests/fixture.ts';
import { boot } from '../../whalelife/core/index.ts';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0V8AAAAASUVORK5CYII=';
const imageId = createHash('sha256').update(Buffer.from(png, 'base64')).digest('hex');
const hasSend = (f: Awaited<ReturnType<typeof fixture>>) => f.app.tools.list().some((x: any) => x.function.name === 'qq_send_gallery');
async function provider(root: string) {
  const dir = join(root, 'plugins/gallery'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'plugin.yaml'), 'id: gallery\nname: gallery\nversion: 1.0.0\ndescription: isolated lifecycle test\n');
  await writeFile(join(dir, 'index.ts'), `export function apply(ctx) {
    let mode='', reads=0, offers=0;
    ctx.provide('gallery', {
      describe:()=>({archived:false,purposes:['image'],description:'fixture'}),
      async readMedia(id,{signal}) {
        reads++; if(mode==='wait') await new Promise((_,reject)=>{
          if(signal.aborted)return reject(Error('cancelled'));
          signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});
        });
        signal.throwIfAborted(); return {id,mime:'image/png',base64:'${png}'};
      },
      offerMedia:()=>{offers++;return {mediaRef:'fixture-ref',expiresInSeconds:86400};},
      state:()=>({reads,offers}),mode:value=>{mode=value;},crash:()=>process.exit(19)
    });
  }`);
}

test('QQ optional gallery absent/late/stopped/crashed/reloaded never adds a bridge or restarts QQ', { timeout: 30000 }, async t => {
  const f = await fixture(t, { config: { permission: 'full' } }); await f.online();
  const pid = f.app.runtime.records.get('qq').execution.pid, connects = f.connects();
  const alive = async () => {
    assert.equal(f.app.runtime.records.get('qq').execution.pid, pid);
    assert.equal(f.app.runtime.records.get('qq').status, 'active');
    assert.equal(f.app.runtime.records.get('qq').dependencies.has('gallery'), false);
    assert.equal(f.app.runtime.records.has('qq/gallery'), false);
    assert.equal(f.connects(), connects);
    assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
    assert.equal(f.app.runtime.records.get('qq/qzone')?.status, 'active');
  };
  assert.equal((await f.status()).mediaBridge.active, false); assert.equal(hasSend(f), false);
  await provider(f.root); await f.app.runtime.loadPath('gallery');
  await until(async () => (await f.status()).mediaBridge.active && hasSend(f)); await alive();
  await f.app.runtime.action('gallery', 'stop');
  await until(async () => !(await f.status()).mediaBridge.active && !hasSend(f)); await alive();
  await f.app.runtime.services.get('qq')!.value.sendText({ userId: '200002', messageId: 'without-gallery', text: 'plain chat' });
  assert.equal(f.calls.filter(c => c.action === 'send_private_msg').length, 1);
  await f.app.runtime.action('gallery', 'start'); await until(() => hasSend(f));
  await assert.rejects(f.app.runtime.services.get('gallery')!.value.crash());
  await until(async () => f.app.runtime.records.get('gallery').status === 'failed' && !(await f.status()).mediaBridge.active && !hasSend(f));
  await alive(); await f.app.runtime.records.get('gallery').stopping;
  await f.app.runtime.action('gallery', 'start'); await until(() => hasSend(f));
  for (let i = 0; i < 2; i++) { await f.app.runtime.action('gallery', 'reload'); await until(() => hasSend(f)); }
  await alive(); assert.equal(f.app.tools.list().filter((x: any) => x.function.name === 'qq_send_gallery').length, 1);
  assert.deepEqual(await f.app.runtime.services.get('gallery')!.value.state(), { reads: 0, offers: 0 });
});

test('QQ gallery choice persists and does not reconnect QQ or alter QZone gallery choice', { timeout: 25000 }, async t => {
  const f = await fixture(t, { config: { galleryEnabled: false }, prepareHost: provider }); await f.online();
  const connects = f.connects();
  const space = async () => (await f.request('/plugins/qq/qzone/status')).json();
  await until(async () => (await space()).gallery);
  assert.equal(hasSend(f), false); assert.equal((await f.status()).mediaBridge.enabled, false);
  await f.app.runtime.action('gallery', 'reload'); assert.equal(hasSend(f), false);
  assert.equal((await f.save({ galleryEnabled: true })).status, 200); await until(() => hasSend(f));
  assert.equal(f.connects(), connects);
  assert.equal((await f.save({ galleryEnabled: false })).status, 200); await until(() => !hasSend(f));
  assert.equal(f.connects(), connects); assert.equal((await space()).gallery, true);
  await f.app.runtime.action('qq', 'reload'); await f.online();
  assert.equal((await f.status()).mediaBridge.enabled, false); assert.equal(hasSend(f), false);
  assert.equal((await f.configFile()).galleryEnabled, false);
  assert.equal((await f.save({ galleryEnabled: 'yes' })).status, 400);
  assert.equal((await f.configFile()).galleryEnabled, false);
  const page = await (await f.request('/plugins/qq/settings')).text();
  assert.match(page, /id="galleryEnabled"/); assert.match(page, /使用图库收藏与发送图片/);
});

test('provider loss aborts original read, removes both tools, and restoration never replays it', { timeout: 25000 }, async t => {
  const f = await fixture(t, { config: { permission: 'full' }, prepareHost: provider }); await f.online(); await until(() => hasSend(f));
  const sessionId = await f.app.sessions.current();
  const call = async (actionId: string) => (await f.app.tools.call('qq_send_gallery', {
    userId: '200002', actionId, parts: [{ type: 'image', id: imageId }],
  }, { id: sessionId, personaId: 'a', permission: 'full' })).result as any;
  const gallery = f.app.runtime.services.get('gallery')!.value;
  await gallery.mode('wait'); const pending = call('interrupted-read');
  await until(async () => (await gallery.state()).reads === 1);
  await f.app.runtime.action('gallery', 'stop');
  assert.equal((await pending).confirmed, false);
  await until(() => !hasSend(f));
  assert.ok(!f.app.tools.list().some((x: any) => x.function.name === 'qq_gallery_delivery'));
  assert.equal(f.calls.filter(c => c.action === 'send_private_msg').length, 0);
  await f.app.runtime.action('gallery', 'start'); await until(() => hasSend(f));
  assert.deepEqual(await f.app.runtime.services.get('gallery')!.value.state(), { reads: 0, offers: 0 });
  assert.equal((await call('new-action')).confirmed, true);
  assert.equal(f.calls.filter(c => c.action === 'send_private_msg').length, 1);
  assert.equal(f.app.runtime.records.has('qq/gallery'), false);
});

test('QQ installer keeps legacy explicit stop, blocked-but-enabled, and previously migrated choices distinct', async () => {
  const { migrateGalleryChoice } = await import(new URL('../../whalelife-plugin-qq/scripts/gallery-migration.mjs', import.meta.url).href);
  const raw = { schemaVersion: 3, accessToken: 'test-only', enabled: true };
  for (const enabled of [false, true]) {
    const state = [{ id: 'qq/gallery', enabled, status: enabled ? 'blocked' : 'stopped' }];
    assert.deepEqual(migrateGalleryChoice(state, raw), { ...raw, galleryEnabled: enabled });
    assert.equal(migrateGalleryChoice(state, { ...raw, galleryEnabled: !enabled }).galleryEnabled, !enabled);
  }
  assert.deepEqual(migrateGalleryChoice([], raw), raw); assert.equal('galleryEnabled' in raw, false);
  assert.throws(() => migrateGalleryChoice([{ id: 'qq/gallery' }], raw));
});

test('upgrade preserves old disabled choice and token; normal host restart retires the cached management entry', { timeout: 25000 }, async t => {
  const f = await fixture(t, { prepareHost: provider, preparePlugin: async root => {
    const path = join(root, 'data/config.json'), raw = JSON.parse(await readFile(path, 'utf8'));
    delete raw.galleryEnabled; await writeFile(path, JSON.stringify(raw));
  } }); await f.online(); await until(() => hasSend(f));
  await f.app.runtime.loadPath('qq/gallery'); await f.app.runtime.action('qq/gallery', 'stop');
  const path = join(f.root, 'plugins/qq/data/config.json'), before = await readFile(path, 'utf8');
  const args = [new URL('../../whalelife-plugin-qq/scripts/gallery-migration.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '--target', join(f.root, 'plugins/qq'), '--base', f.url];
  const preview = await promisify(execFile)(process.execPath, args);
  assert.equal(JSON.parse(preview.stdout).galleryEnabled, false); assert.equal(await readFile(path, 'utf8'), before);
  const migrated = await promisify(execFile)(process.execPath, [...args, '--apply']);
  assert.equal(JSON.parse(migrated.stdout).applied, true); assert.ok(!migrated.stdout.includes('fake-onebot-secret'));
  assert.equal(await readFile(join(f.root, 'plugins/qq/data/config-before-builtin-gallery.json'), 'utf8'), before);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { ...JSON.parse(before), galleryEnabled: false });
  await f.app.runtime.action('qq', 'reload'); await f.online();
  assert.equal((await f.status()).mediaBridge.enabled, false); assert.equal(hasSend(f), false);
  assert.equal(f.app.runtime.records.get('qq/gallery')?.status, 'stopped', 'host retains existing management records until normal restart');
  const again = await promisify(execFile)(process.execPath, [...args, '--apply']);
  assert.equal(JSON.parse(again.stdout).changed, false);
  let restarted: Awaited<ReturnType<typeof boot>> | undefined;
  t.after(async () => { await restarted?.close(); });
  await f.app.close(); restarted = await boot(f.root);
  const qq = restarted.runtime.services.get('qq')!.value;
  await until(async () => (await qq.status()).state === 'online');
  assert.equal((await qq.status()).mediaBridge.enabled, false);
  assert.equal(restarted.runtime.records.has('qq/gallery'), false);
  assert.ok(!restarted.tools.list().some((x: any) => x.function.name === 'qq_send_gallery'));
});
