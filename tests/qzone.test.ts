import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context, ToolSession } from 'whalelife';
import { temporaryDirectory } from '../../whalelife/tests/temporary-directory.ts';
import { Publisher } from '../src/publisher.ts';
import { ReceiptStore } from '../src/store.ts';
import { mediaExtension } from '../src/extensions.ts';
import { defaultConfig, checkInteraction, parseSpaceConfig, publishInput } from '../src/policy.ts';
import { SpaceTransport } from '../../whalelife-plugin-qq/src/space/transport.ts';
import type { QQSpaceTransport, SpacePost, QzoneConfig, TransportReceipt } from '../src/types.ts';

const session: ToolSession = { id: 'isolated', personaId: 'a', permission: 'full' };
async function unit() {
  const dir = await temporaryDirectory('whale-qzone-unit-'), controller = new AbortController();
  const calls: any[] = [], history: any[] = [];
  let config: QzoneConfig = { ...defaultConfig, enabled: true, interactionWhitelist: ['200002'] }, accountId = '100001';
  let handler = async (): Promise<TransportReceipt> => ({ status: 'sent', tid: 'tid_actual' });
  const qq: QQSpaceTransport = { qzoneApiVersion: '1.0.0', qzoneStatus: async () => ({ online: true, accountId }),
    qzonePublish: async (p, o) => { calls.push(p); o.signal.throwIfAborted(); return handler(); } };
  const ctx = { signal: controller.signal, sessions: { context: async () => ({}) }, memory: { recordExperience: async (...args: any[]) => { history.push(args); } } } as unknown as Context;
  const media = mediaExtension(), store = new ReceiptStore(join(dir, 'receipts'));
  const create = () => new Publisher(ctx, qq, () => config, media, store);
  return { dir, calls, history, controller, ctx, media, store, publisher: create(), create,
    setHandler(fn: typeof handler) { handler = fn; }, setConfig(v: QzoneConfig) { config = v; }, setAccount(v: string) { accountId = v; } };
}

test('qzone explicit public configuration, independent empty whitelist, input and mention validation', () => {
  assert.deepEqual(parseSpaceConfig({}), defaultConfig);
  assert.throws(() => parseSpaceConfig({ ...defaultConfig, visibility: 'friends' }));
  assert.throws(() => publishInput({ actionId: 'one', content: 'x', visibility: 'private' }));
  assert.throws(() => publishInput({ actionId: 'one', content: '', imageIds: [] }));
  assert.throws(() => publishInput({ actionId: 'one', content: '@{uin:300003,nick:C}' }));
  assert.throws(() => publishInput({ actionId: 'one', content: 'hi', imageIds: ['file:///private'] }));
  assert.equal(publishInput({ actionId: 'one', content: 'first. second.' }).content, 'first. second.');
});

test('qzone whitelist uses direct author/reply targets; original-only reposts; removal applies immediately', () => {
  const post: SpacePost = { accountId: '100001', authorId: '200002', tid: 'abc', kind: 'original', text: 'foreign text', images: [], hasVideo: false,
    comments: [{ id: 'c', authorId: '300003', text: 'C' }, { id: 'a', authorId: '200002', text: 'A' }] };
  const config: QzoneConfig = { ...defaultConfig, enabled: true, interactionWhitelist: ['200002'] };
  assert.doesNotThrow(() => checkInteraction(post, { kind: 'like' }, config));
  assert.doesNotThrow(() => checkInteraction(post, { kind: 'repost' }, config));
  assert.doesNotThrow(() => checkInteraction({ ...post, kind: 'repost' }, { kind: 'comment', text: 'my comment' }, config));
  assert.throws(() => checkInteraction({ ...post, kind: 'repost' }, { kind: 'repost' }, config));
  assert.throws(() => checkInteraction({ ...post, kind: 'unknown' }, { kind: 'repost' }, config));
  assert.throws(() => checkInteraction(post, { kind: 'comment', reply: { commentId: 'c', authorId: '300003' } }, config));
  assert.throws(() => checkInteraction(post, { kind: 'comment', reply: { commentId: 'c', authorId: '200002' } }, config));
  assert.throws(() => checkInteraction(post, { kind: 'comment', mentions: ['300003'] }, config));
  assert.doesNotThrow(() => checkInteraction(post, { kind: 'comment', reply: { commentId: 'a', authorId: '200002' } }, config));
  assert.throws(() => checkInteraction(post, { kind: 'like' }, { ...config, interactionWhitelist: [] }));
});

test('qzone concurrent same ID shares the result, survives restart and scopes by account/session', async () => {
  const f = await unit(), input = { actionId: 'stable', content: 'my post' };
  const replies = await Promise.all(Array.from({ length: 12 }, () => f.publisher.publish(input, session)));
  assert.ok(replies.every(r => r.confirmed && r.tid === 'tid_actual'));
  assert.equal(f.calls.length, 1); assert.equal(f.history.length, 1);
  assert.equal((await f.create().publish(input, session)).duplicate, true); assert.equal(f.calls.length, 1);
  await assert.rejects(f.publisher.publish({ ...input, content: 'different' }, session));
  assert.equal((await f.publisher.delivery({ accountId: '100001', actionId: 'stable' }, { ...session, id: 'other' })).status, 'not_found');
  f.setAccount('100002'); await f.publisher.publish(input, session); assert.equal(f.calls.length, 2);
  const prior = await f.publisher.delivery({ accountId: '100001', actionId: 'stable' }, session);
  assert.ok('tid' in prior); assert.equal(prior.tid, 'tid_actual');
});

for (const failure of ['rpc-throws', 'missing-tid', 'uncertain', 'pending-restart']) test(`qzone ${failure} never replays or fabricates history`, async () => {
  const f = await unit();
  f.setHandler(async () => { if (failure === 'rpc-throws') throw Error('raw secret'); return failure === 'missing-tid' ? { status: 'sent' } : { status: 'uncertain' }; });
  const input = { actionId: 'uncertain', content: 'own text' };
  assert.equal((await f.publisher.publish(input, session)).status, 'uncertain');
  if (failure === 'pending-restart') {
    const key = { accountId: '100001', sessionId: 'isolated', actionId: input.actionId };
    const ledger = (await f.store.read(key))!; ledger.status = 'pending'; await f.store.save(ledger);
  }
  assert.equal((await f.create().publish(input, session)).status, 'uncertain');
  assert.equal(f.calls.length, 1); assert.equal(f.history.length, 0);
});

test('qzone malformed durable state fails closed; failed first write sends nothing', async () => {
  const f = await unit(), input = { actionId: 'stable', content: 'my post' };
  await f.publisher.publish(input, session);
  const path = join(f.store.root, (await readdir(f.store.root))[0]); await writeFile(path, '{invalid');
  await assert.rejects(f.create().publish(input, session)); assert.equal(f.calls.length, 1);
  const g = await unit(); g.store.save = async () => { throw Error('disk full'); };
  await assert.rejects(g.publisher.publish(input, session)); assert.equal(g.calls.length, 0);
});

test('qzone post-confirmation persistence/history failures retain actual tid and do not replay', async () => {
  const f = await unit(), save = f.store.save.bind(f.store);
  let writes = 0; f.store.save = async (v, first) => { if (++writes > 1) throw Error('disk full'); await save(v, first); };
  f.ctx.memory.recordExperience = async () => { throw Error('history unavailable'); };
  const input = { actionId: 'stable', content: 'my post' };
  const r = await f.publisher.publish(input, session);
  assert.equal(r.confirmed, true); assert.equal(r.tid, 'tid_actual'); assert.equal(r.persistenceError, true); assert.equal(r.historyRecorded, false);
  assert.equal((await f.publisher.publish(input, session)).tid, 'tid_actual'); assert.equal(f.calls.length, 1);
  const queried = await f.publisher.delivery({ actionId: input.actionId, accountId: '100001' }, session);
  assert.equal(queried.status, 'sent'); assert.ok('tid' in queried); assert.equal(queried.tid, 'tid_actual');
  assert.equal((await f.create().publish(input, session)).status, 'uncertain'); assert.equal(f.calls.length, 1);
});

test('qzone permission/disabled/lifecycle rejection and revoked optional provider submit nothing', async () => {
  const f = await unit(), input = { actionId: 'stable', content: 'text' };
  await assert.rejects(f.publisher.publish(input, { ...session, permission: 'off' }));
  f.setConfig(defaultConfig); await assert.rejects(f.publisher.publish(input, session));
  f.controller.abort(); await assert.rejects(f.publisher.publish(input, session)); assert.equal(f.calls.length, 0);
  const g = await unit(), provider = new AbortController();
  const dispose = g.media.register(async () => { g.setAccount('100002'); return []; }, { signal: provider.signal });
  dispose(); assert.equal(g.media.active(), false);
  await assert.rejects(g.publisher.publish({ ...input, imageIds: ['a'.repeat(64)] }, session)); assert.equal(g.calls.length, 0);
});

test('qzone account changes during validation, uncooperative provider cancellation, and concurrency reject safely', async () => {
  const f = await unit();
  f.ctx.sessions.context = async () => { f.setAccount('100002'); return {} as any; };
  await assert.rejects(f.publisher.publish({ actionId: 'identity', content: 'mine' }, session)); assert.equal(f.calls.length, 0);
  const g = await unit(), c = new AbortController();
  g.media.register(async () => new Promise(() => {}), { signal: c.signal });
  const pending = g.publisher.publish({ actionId: 'cancel-image', content: 'mine', imageIds: ['a'.repeat(64)] }, session);
  const rejected = assert.rejects(pending); c.abort(); await rejected; assert.equal(g.calls.length, 0);
  const h = await unit(); let release: () => void = () => {};
  h.setHandler(async () => { await new Promise<void>(r => { release = r; }); return { status: 'sent', tid: 'actual' }; });
  const active = h.publisher.publish({ actionId: 'one', content: 'mine' }, session);
  while (!h.calls.length) await new Promise(r => setTimeout(r, 5));
  await assert.rejects(h.publisher.publish({ actionId: 'two', content: 'another' }, session));
  release(); assert.equal((await active).confirmed, true); assert.equal(h.calls.length, 1);
});

test('qzone parent emits one unsegmented public action and treats generic failed as uncertain', async () => {
  const calls: any[] = []; let fail = false;
  const bot = { request: async (...args: any[]) => { calls.push(args); if (fail) throw Error('platform_failed'); return { tid: 'real_tid' }; } };
  const signal = new AbortController().signal;
  const t = new SpaceTransport(bot as any, signal, () => ({ online: true, accountId: '100001' }));
  const p = { accountId: '100001', content: 'first.\nsecond!', images: [], visibility: 'public' as const };
  assert.equal((await t.publish(p, { signal })).tid, 'real_tid');
  assert.deepEqual(calls[0].slice(0, 2), ['send_qzone_msg', { content: p.content, images: [], ugc_right: 1 }]);
  assert.equal(calls[0][4], 120000);
  fail = true; assert.equal((await t.publish(p, { signal })).status, 'uncertain');
  assert.equal((await t.publish({ ...p, accountId: 'wrong' }, { signal })).status, 'not_submitted'); assert.equal(calls.length, 2);
});
