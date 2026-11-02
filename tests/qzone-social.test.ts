import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { Response } from 'undici';
import type { Context, ToolSession } from 'whalelife';
import { temporaryDirectory } from '../../whalelife/tests/temporary-directory.ts';
import { parseFeeds, parseProfileFeeds, imageUrl, responseObject, successful } from '../../whalelife-plugin-qq/src/space/feeds.ts';
import { SpaceWebTransport } from '../../whalelife-plugin-qq/src/space/web-transport.ts';
import { Social } from '../src/social.ts';
import { defaultConfig } from '../src/policy.ts';
import type { QQSpaceTransport, PostTarget, SocialTransportReceipt } from '../src/types.ts';

const sid: ToolSession = { id: 'session-a', personaId: 'a', permission: 'full' };
export const feedHtml = (author = '200002', type = '0', extra = '') => `<div id="feed_${author}_311_${type}_1700000000_0_1" data-key="real_tid_${author}"><div class="f-nick"><a link="nameCard_${author}" class="f-name">A</a></div><i name="feed_data" data-uin="${author}" data-tid="1700000000" data-fkey="real_tid_${author}" ${extra}></i><div class="f-info">FOREIGN_POST &amp; <b>text</b><br>line<script>evil()</script></div><img src="https://a1.qpic.cn/test.png"><video></video><ul><li class="comments-item" data-type="commentroot" data-tid="1" data-uin="300003"><div class="comments-content">FOREIGN_COMMENT_C</div></li><li class="comments-item" data-type="commentroot" data-tid="2" data-uin="200002"><div class="comments-content">FOREIGN_COMMENT_A</div><ul><li class="comments-item" data-type="replyroot" data-tid="1" data-uin="200002"><div class="comments-content">FOREIGN_NESTED</div></li></ul></li></ul></div>`;
const envelope = (html = feedHtml(), more = false) => JSON.stringify({ code: 0, data: { main: { hasMoreFeeds: more, externparam: 'basetime=17&pagenum=2' }, data: [{ html }] } });

test('feeds parse HTML as data, isolate authors/comments, preserve unknown originality and reject malformed envelopes', () => {
  const r = parseFeeds('_Callback(' + envelope() + ');', '100001', 10);
  assert.equal(r.posts.length, 1); const p = r.posts[0];
  assert.equal(p.authorId, '200002'); assert.equal(p.tid, 'real_tid_200002'); assert.equal(p.kind, 'original'); assert.equal(p.interactive, true);
  assert.equal(p.text, 'FOREIGN_POST & text\nline'); assert.equal(p.hasVideo, true); assert.equal(p.images.length, 1);
  assert.equal(p.comments[0].authorId, '300003'); assert.equal(p.comments[2].replyable, false);
  assert.equal(parseFeeds(envelope(feedHtml('200002', '5', 'data-origuin="400004"')), '100001', 10).posts[0].kind, 'repost');
  assert.equal(parseFeeds(envelope(feedHtml('200002', '2')), '100001', 10).posts[0].kind, 'unknown');
  assert.equal(parseFeeds(envelope(feedHtml().replace('nameCard_200002', 'nameCard_300003')), '100001', 10).posts[0].interactive, false);
  assert.equal(parseFeeds(envelope(feedHtml() + feedHtml('300003')), '100001', 10).posts.length, 2);
  const sibling = '<li class="f-single">' + feedHtml().replace('<ul><li class="comments-item"', '</div><ul><li class="comments-item"').replace('</ul></div>', '</ul>') + '</li>';
  assert.equal(parseFeeds(envelope(sibling), '100001', 10).posts[0].comments.length, 3);
  for (const s of ['evil({})', 'callback({code:0})', '{"code":0}', '{"code":-3000,"message":"raw secret"}']) {
    assert.throws(() => parseFeeds(s, '100001', 10));
  }
  assert.equal(successful({ code: 0, subcode: 1 }), false); assert.equal(successful({}), false);
  assert.throws(() => responseObject('callback({}); evil()'));
  assert.deepEqual(responseObject("_Callback({code:0, data:{html:'\\x3cdiv\\x3e',},});"), { code: 0, data: { html: '<div>' } });
  assert.deepEqual(responseObject("_Callback({code:0, optional:undefined, text:'undefined', other:'\\\"undefined', /*undefined*/ value:null});"), { code: 0, optional: null, text: 'undefined', other: '"undefined', value: null });
  assert.throws(() => responseObject('_Callback({code:0,data:(()=>{throw 1})()});'));
  assert.deepEqual(responseObject('<html><script>document.domain="qq.com";frameElement.callback({code:0,data:{commentid:"2"}});</script></html>'), { code: 0, data: { commentid: '2' } });
  assert.throws(() => responseObject('<script>const ignored="frameElement.callback({code:0})";</script>'));
  assert.throws(() => responseObject('<script>frameElement.callback({code:0});frameElement.callback({code:1});</script>'));
  for (const s of ['https://evil-qpic.cn/x', 'https://qpic.cn.evil.test/a', 'file:///test', 'https://x:q@a.qpic.cn/x', 'https://a.qpic.cn:444/a']) assert.equal(imageUrl(s), undefined);
});

async function transport() {
  const controller = new AbortController(), requests: { url: string; options: any }[] = [], credentials: unknown[] = [];
  let identity = { accountId: '100001', online: true }, output = envelope(), cookies = 'uin=o0100001; p_uin=o0100001; p_skey=ONLY_PARENT_SECRET;';
  let handler: ((url: string, options: any) => Promise<Response>) | undefined;
  const bot = { request: async (action: string, params: any, signal: AbortSignal) => { signal.throwIfAborted(); credentials.push({ action, params }); return { cookies }; } } as any;
  const fetch = (async (url: any, options: any) => { requests.push({ url: String(url), options }); if (handler) return handler(String(url), options); return new Response(output); }) as any;
  const web = new SpaceWebTransport(bot, controller.signal, () => identity, fetch);
  return { web, requests, credentials, controller, output: (s: string) => { output = s; }, cookie: (s: string) => { cookies = s; }, identity: (v: typeof identity) => { identity = v; }, handler: (fn: typeof handler) => { handler = fn; } };
}
test('web transport keeps credentials parent-only, binds encrypted references, supports pagination and never caches foreign bodies', async () => {
  const f = await transport(); f.output(envelope(undefined, true));
  const result = await f.web.browse({ sessionId: 's', count: 5 }, { signal: f.controller.signal });
  assert.ok(!JSON.stringify(result).includes('ONLY_PARENT_SECRET')); assert.ok(!result.posts[0].ref.includes('FOREIGN_POST'));
  assert.equal(new URL(f.requests[0].url).searchParams.get('count'), '5'); assert.equal(f.requests[0].options.redirect, 'error');
  const ref = result.posts[0].ref;
  assert.equal(f.web.resolve({ sessionId: 's', ref }, { signal: f.controller.signal }).authorId, '200002');
  assert.throws(() => f.web.resolve({ sessionId: 'other', ref }, { signal: f.controller.signal }));
  assert.throws(() => f.web.resolve({ sessionId: 's', ref: ref.slice(0, -8) + 'deadbeef' }, { signal: f.controller.signal }));
  await f.web.browse({ sessionId: 's', cursor: result.cursor }, { signal: f.controller.signal });
  assert.equal(new URL(f.requests[1].url).searchParams.get('pagenum'), '2');
  await assert.rejects(f.web.browse({ sessionId: 's', authorId: '200002', cursor: result.cursor }, { signal: f.controller.signal }));
  await f.web.browse({ sessionId: 's', authorId: '100001' }, { signal: f.controller.signal });
  assert.equal(new URL(f.requests.at(-1)!.url).searchParams.get('uinlist'), '100001');
  assert.equal(new URL(f.requests.at(-1)!.url).searchParams.get('uin'), '100001');
  f.identity({ accountId: '100002', online: true }); assert.throws(() => f.web.resolve({ sessionId: 's', ref }, { signal: f.controller.signal }));
});

test('specified other account uses its profile bucket, validates actual authors and binds advancing pagination', async () => {
  const envelope = (offset: unknown = '20', more: unknown = true) => JSON.stringify({ code: 0, data: {
    main: { hasMoreFeeds_0: more, hasMoreFeeds_1: true, offset },
    friend_data: [{ html: feedHtml('200002') + feedHtml('300003') }],
    host_data: [{ html: feedHtml('400004') }], about_data: [{ html: feedHtml('500005') }],
  } });
  const f = await transport(); f.output(envelope());
  const a = await f.web.browse({ sessionId: 's', authorId: '200002', count: 20 }, { signal: f.controller.signal });
  const url = new URL(f.requests[0].url); assert.ok(url.pathname.endsWith('/feeds_html_act_all'));
  assert.equal(url.searchParams.get('uin'), '200002'); assert.equal(url.searchParams.get('hostuin'), '200002'); assert.equal(url.searchParams.get('start'), '0');
  assert.equal(a.source, 'profile'); assert.deepEqual(a.posts.map(p => p.authorId), ['200002']); assert.equal(a.hasMore, true);
  assert.equal(f.web.resolve({ sessionId: 's', ref: a.posts[0].ref }, { signal: f.controller.signal }).authorId, '200002');
  await assert.rejects(f.web.browse({ sessionId: 'other', authorId: '200002', cursor: a.cursor }, { signal: f.controller.signal }));
  await assert.rejects(f.web.browse({ sessionId: 's', authorId: '300003', cursor: a.cursor }, { signal: f.controller.signal }));
  f.output(envelope('40'));
  const b = await f.web.browse({ sessionId: 's', authorId: '200002', cursor: a.cursor }, { signal: f.controller.signal });
  assert.equal(new URL(f.requests.at(-1)!.url).searchParams.get('start'), '20'); assert.equal(b.hasMore, true);
  for (const offset of ['20', '19', 'not-a-number', '1000001']) assert.equal(parseProfileFeeds(envelope(offset), '100001', 20, 20).hasMore, false);
  assert.equal(parseProfileFeeds(envelope('40', false), '100001', 20, 20).hasMore, false);
  assert.throws(() => parseProfileFeeds('{"code":0,"data":{"main":{},"host_data":[]}}', '100001', 20, 0));
  assert.throws(() => parseProfileFeeds('{"code":-3000,"data":{"friend_data":[]}}', '100001', 20, 0));
  const before = f.requests.length; f.handler(async () => { throw Error('No profile response'); });
  await assert.rejects(f.web.browse({ sessionId: 's', authorId: '200002' }, { signal: f.controller.signal }));
  assert.equal(f.requests.length, before + 1, 'profile failures must not silently switch data sources');
});
test('web mutations use one fixed endpoint, exact reply targets and confirmation evidence; failures never fall back', async () => {
  const f = await transport(), { posts } = await f.web.browse({ sessionId: 's' }, { signal: f.controller.signal });
  const input = { sessionId: 's', ref: posts[0].ref };
  f.output('{"code":0}');
  assert.equal((await f.web.interact({ ...input, action: { kind: 'like' } }, { signal: f.controller.signal })).status, 'sent');
  assert.equal(f.requests.at(-1)!.options.body.get('fid'), posts[0].tid);
  assert.equal((await f.web.interact({ ...input, action: { kind: 'comment', text: 'own' } }, { signal: f.controller.signal })).status, 'uncertain');
  f.output('{"code":-10004,"message":"DO_NOT_ECHO_FOREIGN_OR_SECRET"}');
  const rejected = await f.web.interact({ ...input, action: { kind: 'comment', text: 'own' } }, { signal: f.controller.signal });
  assert.equal(rejected.platformCode, -10004); assert.equal(rejected.reason, 'platform_rejected'); assert.ok(!JSON.stringify(rejected).includes('DO_NOT_ECHO'));
  f.output('{"code":0,"data":{"commentid":"comment_real"}}');
  assert.equal((await f.web.interact({ ...input, action: { kind: 'comment', text: 'own', reply: { commentId: '2', authorId: '200002' } } }, { signal: f.controller.signal })).platformId, 'comment_real');
  assert.equal(f.requests.at(-1)!.options.body.get('replyUin'), '200002');
  assert.equal(f.requests.at(-1)!.options.body.get('content'), '@{uin:200002,nick:200002,auto:1} own');
  f.output('{"code":0,"tid":"forward_real"}');
  assert.equal((await f.web.interact({ ...input, action: { kind: 'repost', text: 'my thought' } }, { signal: f.controller.signal })).platformId, 'forward_real');
  assert.equal(f.requests.at(-1)!.options.body.get('ugc_right'), '1');
  const before = f.requests.length; f.handler(async () => { throw Error('network after submission'); });
  assert.equal((await f.web.interact({ ...input, action: { kind: 'like' } }, { signal: f.controller.signal })).status, 'uncertain');
  assert.equal(f.requests.length, before + 1);
  f.cookie('uin=o0999999; p_skey=wrong');
  assert.equal((await f.web.interact({ ...input, action: { kind: 'like' } }, { signal: f.controller.signal })).status, 'not_submitted');
  assert.equal(f.requests.length, before + 1);
});
test('web image is bounded, fetched without cookies and held in memory; oversized/redirected/unknown resources fail', async () => {
  const f = await transport(), { posts } = await f.web.browse({ sessionId: 's' }, { signal: f.controller.signal });
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const input = { sessionId: 's', ref: posts[0].ref, index: 0 };
  f.handler(async () => new Response(bytes));
  assert.equal((await f.web.readImage(input, { signal: f.controller.signal })).base64, bytes.toString('base64'));
  assert.equal(f.requests.at(-1)!.options.headers, undefined);
  assert.equal(f.requests.at(-1)!.options.redirect, 'error');
  f.handler(async () => new Response('x', { headers: { 'content-length': String(11 * 1024 * 1024) } }));
  await assert.rejects(f.web.readImage(input, { signal: f.controller.signal }));
  await assert.rejects(f.web.readImage({ ...input, index: 1 }, { signal: f.controller.signal }));
});
test('comment acceptance without an ID is confirmed only by a single newly observed exact own comment; no second POST', async () => {
  const f = await transport(), { posts } = await f.web.browse({ sessionId: 's' }, { signal: f.controller.signal });
  const input = { sessionId: 's', ref: posts[0].ref, action: { kind: 'comment' as const, text: 'own approved comment' } };
  const extra = '<li class="comments-item" data-type="commentroot" data-tid="3" data-uin="100001"><div class="comments-content"><a class="nickname">My nickname</a>：own approved comment\t\t<div class="comments-op"><span class="state">01:45</span><a class="reply">回复</a><a>删除</a></div></div></li>';
  let mode = 'one';
  f.handler(async (url, options) => {
    if (options.method === 'POST') return new Response('{"code":0}');
    assert.ok(url.includes('/feeds_html_act_all'));
    return new Response(JSON.stringify({ code: 0, data: { main: { hasMoreFeeds_0: false, offset: '20' }, friend_data: [{
      html: feedHtml() + (mode === 'one' ? extra : mode === 'duplicate' ? extra + extra.replace('data-tid="3"', 'data-tid="4"') : ''),
    }] } }));
  });
  const result = await f.web.interact(input, { signal: f.controller.signal });
  assert.equal(result.status, 'sent'); assert.equal(result.platformId, '3');
  assert.equal(f.requests.filter(r => r.options.method === 'POST').length, 1);
  mode = 'duplicate'; assert.equal((await f.web.interact(input, { signal: f.controller.signal })).status, 'uncertain');
  mode = 'none'; assert.equal((await f.web.interact(input, { signal: f.controller.signal })).status, 'uncertain');
  assert.equal(f.requests.filter(r => r.options.method === 'POST').length, 3);
});
async function social() {
  const root = await temporaryDirectory('whale-qzone-social-'), controller = new AbortController(), calls: any[] = [], history: any[] = [];
  let config = { ...defaultConfig, enabled: true, interactionWhitelist: ['200002'] };
  let post: PostTarget = { accountId: '100001', authorId: '200002', tid: 'actual_tid', kind: 'original', typeId: '0', timestamp: '1700000000', interactive: true,
    comments: [{ id: 'c', authorId: '300003', replyable: true }, { id: 'a', authorId: '200002', replyable: true }, { id: 'nested', authorId: '200002', replyable: false }] };
  let handler: () => Promise<SocialTransportReceipt> = async () => ({ status: 'sent', platformCode: 0, platformId: 'actual_response' });
  const qq = { qzoneStatus: async () => ({ online: true, accountId: '100001' }), qzoneResolve: async () => post,
    qzoneInteract: async (...args: any[]) => { calls.push(args); return handler(); } } as unknown as QQSpaceTransport;
  const ctx = { signal: controller.signal, sessions: { context: async () => ({}) }, memory: { recordExperience: async (...args: any[]) => history.push(args) } } as unknown as Context;
  const create = () => new Social(ctx, qq, () => config, root);
  return { root, controller, calls, history, qq, ctx, create, api: create(), config: (v: typeof config) => { config = v; }, post: (v: Partial<PostTarget>) => { post = { ...post, ...v }; }, handler: (v: typeof handler) => { handler = v; } };
}
test('social whitelist applies to direct targets: A repost comments allowed, C replies/mentions and repost-of-repost blocked', async () => {
  const f = await social(); f.post({ kind: 'repost' });
  assert.equal((await f.api.act('comment', { actionId: 'A', ref: 'ref', text: 'own' }, sid)).confirmed, true);
  for (const args of [{ reply: { commentId: 'c', authorId: '300003' } }, { reply: { commentId: 'c', authorId: '200002' } }, { mentions: ['300003'] }, { reply: { commentId: 'nested', authorId: '200002' } }])
    await assert.rejects(f.api.act('comment', { actionId: 'denied', ref: 'ref', text: 'own', ...args }, sid));
  await assert.rejects(f.api.act('repost', { actionId: 'repost', ref: 'ref' }, sid));
  f.post({ kind: 'unknown' }); await assert.rejects(f.api.act('repost', { actionId: 'unknown', ref: 'ref' }, sid));
  f.post({ authorId: '300003' }); await assert.rejects(f.api.act('like', { actionId: 'outside', ref: 'ref' }, sid));
  assert.equal(f.calls.length, 1);
});
test('social durable receipts deduplicate concurrently and after restart, reject changed content, contain no foreign text or raw IDs', async () => {
  const f = await social(), input = { actionId: 'FOREIGN_ACTION_ID', ref: 'FOREIGN_REF', text: 'FOREIGN_BODY_COPY' };
  const r = await Promise.all(Array.from({ length: 12 }, () => f.api.act('comment', input, sid)));
  assert.ok(r.every(v => v.confirmed)); assert.equal(f.calls.length, 1); assert.equal(f.history.length, 1);
  assert.equal((await f.create().act('comment', input, sid)).duplicate, true);
  await assert.rejects(f.create().act('comment', { ...input, text: 'changed' }, sid));
  assert.equal((await f.create().delivery({ actionId: input.actionId, accountId: '100001' }, sid)).status, 'sent');
  assert.equal((await f.create().delivery({ actionId: input.actionId, accountId: '100001' }, { ...sid, id: 'other' })).status, 'not_found');
  for (const name of await readdir(f.root)) assert.ok(!(await readFile(join(f.root, name), 'utf8')).includes('FOREIGN_'));
  assert.ok(!JSON.stringify(f.history).includes('FOREIGN_'));
  const name = (await readdir(f.root))[0]; await writeFile(join(f.root, name), '{bad');
  await assert.rejects(f.create().act('comment', input, sid)); assert.equal(f.calls.length, 1);
});
for (const mode of ['throw', 'missing-id', 'uncertain', 'not-submitted']) test(`social ${mode} keeps conservative result across restart without replay`, async () => {
  const f = await social();
  f.handler(async () => { if (mode === 'throw') throw Error('foreign raw error'); return mode === 'missing-id' ? { status: 'sent', platformCode: 0 } : { status: mode === 'not-submitted' ? 'not_submitted' : 'uncertain' }; });
  const input = { actionId: 'stable', ref: 'ref', text: 'own' };
  assert.equal((await f.api.act('comment', input, sid)).status, mode === 'not-submitted' ? 'not_submitted' : 'uncertain');
  await f.create().act('comment', input, sid); assert.equal(f.calls.length, 1); assert.equal(f.history.length, 0);
});
test('social rechecks whitelist after async session context; permissions and cancellation precede submission', async () => {
  const f = await social(); f.ctx.sessions.context = async () => { f.config({ ...defaultConfig, enabled: true, interactionWhitelist: [] }); return {} as any; };
  await assert.rejects(f.api.act('like', { actionId: 'removed', ref: 'ref' }, sid)); assert.equal(f.calls.length, 0);
  await assert.rejects(f.api.act('like', { actionId: 'off', ref: 'ref' }, { ...sid, permission: 'ask' }));
  f.controller.abort(); await assert.rejects(f.api.act('like', { actionId: 'cancel', ref: 'ref' }, sid)); assert.equal(f.calls.length, 0);
});
