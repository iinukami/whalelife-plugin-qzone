import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import type { ToolSession } from 'whalelife';
import { temporaryDirectory } from '../../whalelife/tests/temporary-directory.ts';
import { Collector } from '../src/collector.ts';
import { collectionExtension } from '../src/extensions.ts';
import { defaultConfig } from '../src/policy.ts';
import type { QQSpaceTransport, MediaCollector, PostTarget } from '../src/types.ts';
import { fixture, until } from '../../whalelife-plugin-qq/tests/fixture.ts';

const session: ToolSession = { id: 'collection-session', permission: 'full', personaId: 'a' };
const selection = { actionId: 'select-one', ref: 'PRIVATE_ENCRYPTED_REF', index: 0 };
const assetId = 'a'.repeat(64), foreign = 'FOREIGN_POST_COMMENT_DO_NOT_STORE';
async function unit() {
  const root = await temporaryDirectory('whale-qzone-collect-');
  const config = { ...defaultConfig, enabled: true, interactionWhitelist: [] as string[] };
  const target: PostTarget = { accountId: '100001', authorId: '300003', tid: 'original_tid', kind: 'original', typeId: '0', timestamp: '1700000000', interactive: true, comments: [] };
  let resolves = 0, reads = 0, handoffs = 0, identity = { accountId: '100001', online: true };
  const qq: QQSpaceTransport = { qzoneApiVersion: '1.0.0', qzoneStatus: async () => identity,
    qzonePublish: async () => { throw Error('not used'); },
    qzoneResolve: async input => { resolves++; assert.equal(input.sessionId, session.id); assert.equal(input.ref, selection.ref); return target; },
    qzoneReadImage: async input => { reads++; assert.equal(input.index, 0); return { mime: 'image/png', base64: 'SELECTED_ORIGINAL_BYTES' }; } };
  const provider = collectionExtension(), lifecycle = new AbortController();
  let handler: MediaCollector = async input => {
    assert.equal(input.base64, 'SELECTED_ORIGINAL_BYTES'); assert.equal(input.session.transientContext, true);
    assert.deepEqual(input.purposes, ['image']); return { status: 'saved', assetId, jobId: 'job-one', archived: false };
  };
  provider.register(async (input, options) => { handoffs++; return handler(input, options); }, { signal: lifecycle.signal });
  const create = () => new Collector(qq, () => config, provider, root);
  return { root, config, target, qq, provider, lifecycle, create, c: create(), counts: () => ({ resolves, reads, handoffs }),
    identity: (id: string) => { identity = { accountId: id, online: true }; }, handler: (h: MediaCollector) => { handler = h; } };
}

test('selected original collection is local, session-scoped, metadata-only and deduplicated across restart', async () => {
  const f = await unit();
  const [a, b] = await Promise.all([f.c.collect(selection, session), f.c.collect(selection, session)]);
  assert.equal(a.status, 'saved'); assert.equal(a.assetId, assetId); assert.equal(b.duplicate, true);
  assert.equal(a.authorId, '300003'); assert.deepEqual(f.counts(), { resolves: 1, reads: 1, handoffs: 1 });
  assert.equal((await f.create().collect(selection, session)).duplicate, true);
  for (const change of [{ index: 1 }, { ref: 'different-ref' }, { purposes: ['meme'] }]) await assert.rejects(f.c.collect({ ...selection, ...change }, session), /同一收藏动作/);
  assert.equal((await f.create().delivery({ actionId: selection.actionId, accountId: '100001' }, session)).status, 'saved');
  assert.equal((await f.create().delivery({ actionId: a.actionIdHash, accountId: '100001' }, session)).status, 'saved');
  assert.equal((await f.create().delivery({ actionId: selection.actionId, accountId: '100001' }, { ...session, id: 'other' })).status, 'not_found');
  const contents = await readFile(join(f.root, (await readdir(f.root))[0]), 'utf8');
  for (const secret of [selection.ref, selection.actionId, 'SELECTED_ORIGINAL_BYTES', foreign]) assert.ok(!contents.includes(secret));
  assert.deepEqual(f.counts(), { resolves: 1, reads: 1, handoffs: 1 });
});

test('collection rejects invalid inputs, permissions, disabled/absent bridge and account switches before handoff', async () => {
  const f = await unit();
  for (const bad of [{ description: foreign }, { url: 'https://example.test' }, { index: -1 }, { index: 8 }, { purposes: [] }, { purposes: ['x'] }]) await assert.rejects(f.c.collect({ ...selection, ...bad }, session));
  await assert.rejects(f.c.collect(selection, { ...session, permission: 'ask' }));
  f.config.enabled = false; await assert.rejects(f.c.collect(selection, session)); f.config.enabled = true;
  assert.deepEqual(f.counts(), { resolves: 0, reads: 0, handoffs: 0 });
  f.identity('100002'); await assert.rejects(f.c.collect(selection, session)); f.identity('100001');
  f.qq.qzoneReadImage = async () => { f.config.enabled = false; return { mime: 'image/png', base64: 'x' }; };
  await assert.rejects(f.c.collect(selection, session)); assert.equal(f.counts().handoffs, 0);
  f.config.enabled = true; f.provider.dispose(); await assert.rejects(f.c.collect(selection, session));
  assert.deepEqual(await readdir(f.root), []);
});

for (const failure of ['throw', 'bad-receipt', 'cancel', 'stop'] as const) test(`collection ${failure} remains uncertain without replay`, async () => {
  const f = await unit(), controller = new AbortController();
  f.handler(async (_input, { signal }) => {
    if (failure === 'throw') throw Error(foreign);
    if (failure === 'bad-receipt') return { status: 'saved', assetId: 'invalid' };
    if (failure === 'cancel') controller.abort(); else f.lifecycle.abort();
    signal.throwIfAborted(); throw Error('must be aborted');
  });
  const a = await f.c.collect(selection, { ...session, signal: controller.signal });
  assert.equal(a.status, 'uncertain'); assert.equal(a.retryAutomatically, false);
  assert.equal((await f.create().collect(selection, session)).status, 'uncertain'); assert.equal(f.counts().handoffs, 1);
  assert.ok(!JSON.stringify(a).includes(foreign));
});

test('pending/corrupt/write-failed collection ledgers never trigger a second gallery handoff', async () => {
  const f = await unit(); await f.c.collect(selection, session);
  const path = join(f.root, (await readdir(f.root))[0]), value = JSON.parse(await readFile(path, 'utf8'));
  value.status = 'pending'; delete value.assetId; delete value.archived; delete value.jobId;
  await writeFile(path, JSON.stringify(value)); assert.equal((await f.create().collect(selection, session)).status, 'uncertain');
  await writeFile(path, '{corrupt'); await assert.rejects(f.create().collect(selection, session), /损坏/);
  const occupied = join(f.root, 'not-a-directory'); await writeFile(occupied, 'keep');
  await assert.rejects(new Collector(f.qq, () => f.config, f.provider, occupied).collect(selection, session));
  assert.equal(f.counts().handoffs, 1); assert.equal(await readFile(occupied, 'utf8'), 'keep');
});

async function disk(root: string): Promise<string> {
  try { let out = ''; for (const entry of await readdir(root, { withFileTypes: true })) out += entry.isDirectory() ? await disk(join(root, entry.name)) : await readFile(join(root, entry.name), 'utf8'); return out; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw e; }
}

test('real QZone/gallery workers collect selected original only; nested tool results stay transient and lifecycle remains independent', { timeout: 45000 }, async t => {
  const original = await sharp(Buffer.alloc(8 * 16 * 3, 120), { raw: { width: 8, height: 16, channels: 3, pageHeight: 8 } }).gif().toBuffer();
  const f = await fixture(t, { prepareHost: async root => {
    await cp(new URL('../../whalelife-plugin-gallery/dist/gallery', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), join(root, 'plugins/gallery'), { recursive: true });
  }, preparePlugin: async root => {
    await mkdir(join(root, 'sub/qzone/data'), { recursive: true });
    await writeFile(join(root, 'sub/qzone/data/config.json'), JSON.stringify({ ...defaultConfig, enabled: true }));
    await writeFile(join(root, 'index.ts'), `export function apply(ctx) {
      const target={accountId:'100001',authorId:'300003',tid:'actual_tid',kind:'original',interactive:true,typeId:'0',timestamp:'1700000000',comments:[]};
      ctx.provide('qq',{apiVersion:'1.0.0',qzoneApiVersion:'1.0.0',qzoneSocialApiVersion:'1.0.0',qzoneStatus:()=>({accountId:'100001',online:true}),
      qzonePublish:()=>({status:'sent',tid:'own_tid'}),qzoneInteract:()=>{throw Error('Unexpected remote interaction');},
      qzoneBrowse:input=>({accountId:'100001',posts:[{...target,ref:'TEMP_REF_'+input.sessionId,text:${JSON.stringify(foreign)},imageCount:1,hasVideo:false}],hasMore:false,skipped:0}),
      qzoneResolve:input=>{if(input.ref!=='TEMP_REF_'+input.sessionId)throw Error('Wrong session');return target;},
      qzoneReadImage:input=>{if(input.ref!=='TEMP_REF_'+input.sessionId||input.index!==0)throw Error('Invalid selection');return {mime:'image/gif',base64:${JSON.stringify(original.toString('base64'))}};},
      qzoneDescribeImage:()=>${JSON.stringify(foreign)}});
    }`);
  } });
  await until(async () => (await (await f.request('/plugins/qq/qzone/status')).json()).capabilities.collectImage);
  const sid = await f.app.sessions.create('selected-collection'), live = { ...session, id: sid };
  const args = { actionId: 'selected-original', ref: 'TEMP_REF_' + sid, index: 0 };
  const call = async (name: string, input: unknown, s = live): Promise<any> => (await f.app.tools.call(name, input, s)).result;
  const galleryRoot = join(f.root, 'plugins/gallery/data'), before = await disk(galleryRoot);
  assert.equal((await call('qzone_browse', {})).posts[0].canInteract, false);
  await call('qzone_read_image', { ref: args.ref, index: 0 });
  assert.equal(await disk(galleryRoot), before, 'ordinary browsing must never offer or store an image');
  assert.equal((await call('qzone_collect_image', args, { ...live, id: 'other' })).status, 'blocked');
  const events: any[] = []; f.app.runtime.events.on('tool/called', (event: unknown) => events.push(event));
  let round = 0, saved: any;
  f.setGenerate(async input => {
    const tool = (name: string, value: unknown) => ({ id: name, name, arguments: JSON.stringify(value) });
    if (++round === 1) return { text: '', toolCalls: [tool('qzone_browse', {})] };
    if (round === 2) { assert.ok(JSON.stringify(input).includes(foreign)); return { text: '', toolCalls: [tool('qzone_collect_image', args)] }; }
    return { text: foreign, toolCalls: [] };
  });
  await f.app.sessions.chat(sid, '收藏选中图片', () => {}, undefined, 'a', { channel: 'web', account: 'web', peer: sid, persona: 'a', permission: 'full' });
  saved = await call('qzone_delivery', { accountId: '100001', actionId: args.actionId });
  assert.equal(saved.status, 'saved'); assert.ok(saved.assetId); assert.ok(saved.jobId);
  const gallery = f.app.runtime.services.get('gallery')!.value;
  assert.equal((await gallery.readMedia(saved.assetId, { signal: new AbortController().signal })).base64, original.toString('base64'));
  assert.equal((await call('qzone_collect_image', args)).duplicate, true);
  await f.app.runtime.events.drain();
  for (const secret of [foreign, args.ref, original.toString('base64')]) {
    assert.ok(!JSON.stringify(events).includes(secret));
    assert.ok(!JSON.stringify(await f.app.memory.readSession(sid)).includes(secret));
    for (const dir of ['memory', 'logs', 'plugins/qq/sub/qzone/data']) assert.ok(!(await disk(join(f.root, dir))).includes(secret), dir + ' leaked transient data');
  }
  assert.ok(!(await disk(galleryRoot)).includes(foreign), 'gallery metadata must not copy the post or comment');
  await f.app.runtime.action('qq/qzone', 'reload');
  await until(async () => (await (await f.request('/plugins/qq/qzone/status')).json()).capabilities.collectImage);
  assert.equal((await call('qzone_collect_image', args)).duplicate, true);
  await f.app.runtime.action('gallery', 'stop');
  await until(async () => !(await (await f.request('/plugins/qq/qzone/status')).json()).capabilities.collectImage);
  assert.equal((await call('qzone_collect_image', { ...args, actionId: 'new-after-stop' })).status, 'blocked');
  assert.equal((await call('qzone_publish', { actionId: 'text-after-stop', content: 'my own' })).confirmed, true);
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
});
