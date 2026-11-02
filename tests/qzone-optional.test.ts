import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture, until } from '../../whalelife-plugin-qq/tests/fixture.ts';
import { defaultConfig } from '../src/policy.ts';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0V8AAAAASUVORK5CYII=';
const imageId = createHash('sha256').update(Buffer.from(png, 'base64')).digest('hex');
async function provider(root: string) {
  const dir = join(root, 'plugins/gallery'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'plugin.yaml'), 'id: gallery\nname: gallery\nversion: 1.0.0\ndescription: isolated lifecycle fixture\ndepends: [tools]\n');
  await writeFile(join(dir, 'index.ts'), `export function apply(ctx) {
    let mode='',reads=0,offers=0;
    const wait=signal=>new Promise((_,reject)=>{ if(signal.aborted)return reject(Error('cancelled')); signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}); });
    ctx.provide('gallery', { describe:()=>({archived:false,description:'fixture'}),
      async readMedia(id,{signal}) { reads++; if(mode==='read')await wait(signal); return {id,mime:'image/png',base64:'${png}'}; },
      async offerMedia(input,{signal}) { offers++; if(mode==='offer')await wait(signal); return {mediaRef:'fixture-ref'}; },
      state:()=>({reads,offers}), mode:value=>{mode=value;}, crash:()=>process.exit(19)
    });
    ctx.tools.register({name:'gallery_collect',description:'fixture',schema:{},run:()=>({ok:true,state:'saved',asset:{id:'${imageId}'},job:{id:'fixture-job'},archived:false})});
  }`);
}
async function setup(t: any, { present = true, galleryEnabled }: { present?: boolean; galleryEnabled?: boolean } = {}) {
  const f = await fixture(t, { prepareHost: present ? provider : undefined, preparePlugin: async root => {
    await writeFile(join(root, 'plugin.yaml'), 'id: qq\nname: qq\nversion: 1.0.0\ndescription: isolated transport fixture\nsub: [qzone]\n');
    await mkdir(join(root, 'sub/qzone/data'), { recursive: true });
    await writeFile(join(root, 'sub/qzone/data/config.json'), JSON.stringify({ ...defaultConfig, enabled: true, ...(galleryEnabled === undefined ? {} : { galleryEnabled }) }));
    await writeFile(join(root, 'index.ts'), `export function apply(ctx) { let sent=0; const target={accountId:'100001',authorId:'200002',tid:'fixture_tid',kind:'original',interactive:true,comments:[]};
      ctx.provide('qq',{qzoneApiVersion:'1.0.0',qzoneSocialApiVersion:'1.0.0',qzoneStatus:()=>({accountId:'100001',online:true}),
        qzonePublish:()=>{sent++;return {status:'sent',tid:'own_'+sent};}, qzoneBrowse:()=>({accountId:'100001',posts:[],hasMore:false,skipped:0}),
        qzoneResolve:()=>target,qzoneReadImage:()=>({mime:'image/png',base64:'${png}'}),qzoneDescribeImage:()=> 'fixture image',qzoneInteract:()=>{throw Error('Unexpected interaction');},
        sent:()=>sent,ping:()=> 'private independent'});
    }`);
  } });
  const status = async () => (await f.request('/plugins/qq/qzone/status')).json();
  await until(async () => (await status()).galleryMode === 'builtin');
  if (present && galleryEnabled !== false) await until(async () => (await status()).capabilities.collectImage);
  const sid = await f.app.sessions.create('optional-gallery'), session = { id: sid, personaId: 'a', permission: 'full' as const };
  const call = async (name: string, args: unknown) => (await f.app.tools.call(name, args, session)).result;
  const publish = (actionId: string, image = false) => call('qzone_publish', { actionId, content: 'my own text', ...(image ? { imageIds: [imageId] } : {}) });
  const gallery = () => f.app.runtime.services.get('gallery')!.value;
  const setEnabled = async (enabled: boolean) => {
    const { revision, config } = await (await f.request('/plugins/qq/qzone/config')).json();
    assert.equal((await f.request('/plugins/qq/qzone/config', { revision, config: { ...config, galleryEnabled: enabled } })).status, 200);
  };
  const alive = async (pid: number) => {
    assert.equal(f.app.runtime.records.get('qq/qzone').execution.pid, pid);
    assert.equal(f.app.runtime.records.get('qq/qzone').status, 'active');
    assert.equal(await f.app.runtime.services.get('qq')!.value.ping(), 'private independent');
    assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
    assert.equal(f.app.runtime.records.get('qq/qzone').dependencies.has('gallery'), false);
    assert.equal(f.app.runtime.records.has('qq/qzone/gallery'), false);
  };
  return { f, status, call, publish, gallery, setEnabled, alive };
}

test('builtin gallery: absent, late, stop, crash and recovery retain the same QZone process with no adapter', { timeout: 25000 }, async t => {
  const x = await setup(t, { present: false }), pid = x.f.app.runtime.records.get('qq/qzone').execution.pid;
  assert.equal((await x.status()).gallery, false);
  assert.equal((await x.publish('without')).confirmed, true);
  await provider(x.f.root); assert.equal((await x.f.app.runtime.loadPath('gallery')).status, 'active');
  await until(async () => (await x.status()).gallery); await x.alive(pid);
  assert.equal((await x.publish('with-image', true)).confirmed, true);
  await x.f.app.runtime.action('gallery', 'stop'); await until(async () => !(await x.status()).gallery); await x.alive(pid);
  assert.equal((await x.publish('still-text')).confirmed, true);
  assert.equal((await x.publish('no-image', true)).status, 'blocked');
  await x.f.app.runtime.action('gallery', 'start'); await until(async () => (await x.status()).gallery);
  await assert.rejects(x.gallery().crash());
  await until(async () => x.f.app.runtime.records.get('gallery').status === 'failed' && !(await x.status()).gallery);
  await x.alive(pid); await x.f.app.runtime.records.get('gallery').stopping;
  await x.f.app.runtime.action('gallery', 'start'); await until(async () => (await x.status()).gallery);
  await x.f.app.runtime.action('gallery', 'reload'); await until(async () => (await x.status()).gallery);
  await x.alive(pid); assert.equal(await x.f.app.runtime.services.get('qq')!.value.sent(), 3);
  assert.deepEqual(await x.gallery().state(), { reads: 0, offers: 0 });
});

test('builtin gallery loss cancels in-flight reads/collection and never replays uncertain work', { timeout: 25000 }, async t => {
  const x = await setup(t), pid = x.f.app.runtime.records.get('qq/qzone').execution.pid;
  await x.gallery().mode('read'); const pendingRead = x.publish('pending-image', true);
  await until(async () => (await x.gallery().state()).reads === 1);
  await x.f.app.runtime.action('gallery', 'stop'); assert.equal((await pendingRead).status, 'blocked');
  await x.alive(pid); assert.equal(await x.f.app.runtime.services.get('qq')!.value.sent(), 0);
  await x.f.app.runtime.action('gallery', 'start'); await until(async () => (await x.status()).capabilities.collectImage);
  await x.gallery().mode('offer'); const args = { actionId: 'pending-collection', ref: 'fixture-ref', index: 0 };
  const pendingCollect = x.call('qzone_collect_image', args);
  await until(async () => (await x.gallery().state()).offers === 1);
  await x.f.app.runtime.action('gallery', 'stop'); assert.equal((await pendingCollect).status, 'uncertain'); await x.alive(pid);
  await x.f.app.runtime.action('gallery', 'start'); await until(async () => (await x.status()).gallery);
  assert.equal((await x.call('qzone_collect_image', args)).status, 'uncertain');
  assert.deepEqual(await x.gallery().state(), { reads: 0, offers: 0 });
  assert.equal((await x.publish('recovered-image', true)).confirmed, true);
});

test('space gallery choice is independent, persists on reload, and only enabling it acquires the provider', { timeout: 25000 }, async t => {
  const x = await setup(t, { galleryEnabled: false });
  assert.equal((await x.status()).gallery, false); assert.equal((await x.publish('disabled-image', true)).status, 'blocked');
  assert.equal((await x.publish('disabled-text')).confirmed, true);
  await x.f.app.runtime.action('gallery', 'reload'); assert.equal((await x.status()).gallery, false);
  await x.setEnabled(true); await until(async () => (await x.status()).gallery);
  assert.equal((await x.publish('enabled-image', true)).confirmed, true);
  await x.setEnabled(false); await until(async () => !(await x.status()).gallery);
  await x.f.app.runtime.action('qq/qzone', 'reload');
  assert.equal((await x.status()).galleryEnabled, false); assert.equal((await x.status()).gallery, false);
  await x.f.app.runtime.action('qq/qzone', 'stop'); await x.f.app.runtime.action('gallery', 'reload');
  assert.equal(x.f.app.runtime.records.get('qq/qzone').status, 'stopped');
  assert.equal(x.f.app.runtime.records.has('qq/qzone/gallery'), false);
});

test('installer preserves explicit legacy stop and never overwrites an already migrated gallery choice', async () => {
  const { migrateGalleryChoice } = await import(new URL('../scripts/qzone-gallery-migration.mjs', import.meta.url).href);
  const config = { ...defaultConfig, enabled: true, interactionWhitelist: ['200002'] };
  const legacy = (enabled: boolean) => [{ id: 'qq/qzone/gallery', enabled, status: enabled ? 'blocked' : 'stopped' }];
  assert.deepEqual(migrateGalleryChoice([], config), config);
  for (const enabled of [true, false]) assert.deepEqual(migrateGalleryChoice(legacy(enabled), config), { ...config, galleryEnabled: enabled });
  assert.equal(migrateGalleryChoice(legacy(false), { ...config, galleryEnabled: true }).galleryEnabled, true);
  assert.equal(migrateGalleryChoice(legacy(true), { ...config, galleryEnabled: false }).galleryEnabled, false);
  assert.throws(() => migrateGalleryChoice([{ id: 'qq/qzone/gallery' }], config));
  assert.equal('galleryEnabled' in config, false);
});

test('upgrade CLI uses public enabled state and backs up only QZone config before the first builtin startup', { timeout: 20000 }, async t => {
  const x = await setup(t);
  // Represents a retained old plugin-management entry; the new legacy module cannot register twice.
  await x.f.app.runtime.loadPath('qq/qzone/gallery'); await x.f.app.runtime.action('qq/qzone/gallery', 'stop');
  const directory = join(x.f.root, 'plugins/qq/sub/qzone/data'), path = join(directory, 'config.json');
  const before = await readFile(path, 'utf8');
  const args = ['scripts/qzone-gallery-migration.mjs', '--target', join(x.f.root, 'plugins/qq'), '--base', x.f.url];
  const preview = await promisify(execFile)(process.execPath, args);
  assert.equal(JSON.parse(preview.stdout).galleryEnabled, false);
  assert.equal(await readFile(path, 'utf8'), before);
  await promisify(execFile)(process.execPath, [...args, '--apply']);
  assert.equal(await readFile(join(directory, 'config-before-builtin-gallery.json'), 'utf8'), before);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { ...JSON.parse(before), galleryEnabled: false });
  await x.f.app.runtime.action('qq/qzone', 'reload');
  assert.equal((await x.status()).galleryEnabled, false); assert.equal((await x.status()).gallery, false);
});
