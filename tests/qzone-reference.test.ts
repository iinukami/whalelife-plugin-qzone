import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { referenceError, readFailure } from '../src/errors.ts';
import type { QQSpaceTransport, ReferenceFailure } from '../src/types.ts';
import { defaultConfig } from '../src/policy.ts';
import { fixture, until } from '../../whalelife-plugin-qq/tests/fixture.ts';

const legacy = '动态引用已过期、账号已变化或不属于本会话，请重新浏览。';
const messages: Record<ReferenceFailure, string> = {
  invalid_reference: '动态引用格式无效，请重新浏览并使用返回的完整引用。',
  unreadable_reference: '动态引用无法校验，可能来自已重载的连接或内容已损坏；请重新浏览。',
  offline: 'QQ 不在线，请恢复原账号连接后再检查引用。',
  account_changed: '动态引用所属 QQ 账号与当前账号不一致，请用当前账号重新浏览。',
  session_mismatch: '动态引用不属于本会话，请在当前会话重新浏览。',
  expired: '动态引用已超过有效期，请重新浏览。',
  wrong_kind: '引用类型不符，动态引用和翻页引用不能混用。',
};
const ref = 'SYNTHETIC_PRIVATE_REFERENCE_NO_STORE';
const secret = 'SYNTHETIC_PROVIDER_BODY_NO_STORE';

test('reference diagnostics distinguish all v1 reasons and preserve the original failure on incompatible/invalid results', async () => {
  const signal = new AbortController().signal, input = { sessionId: 'trusted-session', ref, expectedKind: 'post' as const };
  let calls = 0, value: any;
  const qq = { qzoneReferenceApiVersion: '1.0.0', qzoneReferenceStatus: async (v: unknown, options: any) => {
    calls++; assert.deepEqual(v, input); assert.equal(options.signal, signal); return value;
  } } as unknown as QQSpaceTransport;
  const explain = (q = qq, error = new Error(legacy), data = input) => referenceError(error, readFailure, q, data, signal);
  for (const [reason, message] of Object.entries(messages)) {
    value = { valid: false, reason, message };
    assert.equal(await explain(), message);
  }
  for (const result of [null, {}, { valid: true, kind: 'post', expiresAt: Date.now() + 60000 },
    { valid: false, reason: 'expired', message: secret }, { valid: false, reason: 'unknown', message: secret }]) {
    value = result; assert.equal(await explain(), legacy);
  }
  value = { valid: false, reason: 'wrong_kind', message: messages.wrong_kind };
  for (const message of ['需要动态引用。', '翻页引用与浏览范围不一致。', '图片序号无效。']) assert.equal(await explain(qq, new Error(message)), messages.wrong_kind);
  value = { valid: true, kind: 'post', expiresAt: Date.now() + 60000 };
  assert.equal(await explain(qq, new Error('图片序号无效。')), '图片序号无效。');
  const before = calls;
  assert.equal(await explain({ ...qq, qzoneReferenceStatus: undefined }), legacy);
  assert.equal(await explain({ ...qq, qzoneReferenceApiVersion: undefined }), legacy);
  assert.equal(await explain({ ...qq, qzoneReferenceApiVersion: '2.0.0' }), legacy);
  assert.equal(await explain(qq, new Error(secret)), readFailure);
  assert.equal(await explain(qq, new Error('图片来源不受支持。')), '图片来源不受支持。');
  assert.equal(await explain(qq, new Error(legacy), { ...input, ref: 'x'.repeat(65537) }), legacy);
  assert.equal(calls, before);
  assert.equal(await explain({ ...qq, qzoneReferenceStatus: async () => { throw Error(secret); } }), legacy);
});

test('cancelled diagnostics do not call a provider or replace the original failure', async () => {
  const lifecycle = new AbortController(); let calls = 0;
  const qq = { qzoneReferenceApiVersion: '1.0.0', qzoneReferenceStatus: async () => {
    calls++; lifecycle.abort(); return { valid: false, reason: 'expired', message: messages.expired };
  } } as unknown as QQSpaceTransport;
  const explain = () => referenceError(new Error(legacy), readFailure, qq, { sessionId: 'test', ref }, lifecycle.signal);
  assert.equal(await explain(), legacy); assert.equal(calls, 1);
  assert.equal(await explain(), legacy); assert.equal(calls, 1);
});

async function disk(root: string): Promise<string> {
  let content = '';
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      content += entry.isDirectory() ? await disk(path) : await readFile(path, 'utf8');
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return content;
}

for (const diagnostic of [true, false]) test(`installed space with ${diagnostic ? 'v1' : 'old'} QQ: trusted diagnostic routing, read/action errors and no persistent reference`, { timeout: 40000 }, async t => {
  const f = await fixture(t, { preparePlugin: async root => {
    await mkdir(join(root, 'sub/qzone/data'), { recursive: true });
    await writeFile(join(root, 'sub/qzone/data/config.json'), JSON.stringify({ ...defaultConfig, enabled: true, interactionWhitelist: ['200002'] }));
    await writeFile(join(root, 'index.ts'), `export function apply(ctx) {
      let generic=false, diagnostics=[], attempts=[], writes=0;
      const reject=kind=>{attempts.push(kind);throw Error(generic?${JSON.stringify(secret)}:${JSON.stringify(legacy)});};
      ctx.provide('qq', {qzoneApiVersion:'1.0.0',qzoneSocialApiVersion:'1.0.0',
        qzoneStatus:()=>({accountId:'100001',online:true}),qzonePublish:()=>{writes++;return {status:'uncertain'};},
        qzoneBrowse:()=>reject('browse'),qzoneResolve:()=>reject('resolve'),qzoneReadImage:()=>reject('image'),qzoneDescribeImage:()=>reject('describe'),
        qzoneInteract:()=>{writes++;return {status:'uncertain'};},
        ${diagnostic ? `qzoneReferenceApiVersion:'1.0.0',qzoneReferenceStatus:(input,{signal})=>{signal.throwIfAborted();diagnostics.push(input);return {valid:false,reason:'session_mismatch',message:${JSON.stringify(messages.session_mismatch)}};},` : ''}
        testGeneric:()=>{generic=true;},testState:()=>({diagnostics,attempts,writes})});
    }`);
    const probe = join(root, 'sub/qzone/sub/collector-probe');
    await mkdir(probe, { recursive: true });
    const manifest = join(root, 'sub/qzone/plugin.yaml');
    await writeFile(manifest, (await readFile(manifest, 'utf8')).replace('sub: []', 'sub: [collector-probe]'));
    await writeFile(join(probe, 'plugin.yaml'), 'id: collector-probe\nname: test collector\nversion: 1.0.0\ndescription: isolated collector\ndepends: [qq/qzone]\n');
    await writeFile(join(probe, 'index.ts'), "export async function apply(ctx) {const remove=await ctx.get('qq/qzone').registerMediaCollector(()=>{throw Error('must not collect');},{signal:ctx.signal});ctx.effect(()=>remove);}");
  } });
  try { await until(async () => (await (await f.request('/plugins/qq/qzone/status')).json()).capabilities.collectImage); }
  catch { throw Error(JSON.stringify((await (await f.request('/api/status')).json()).plugins)); }
  const sid = await f.app.sessions.create('reference-test'), session = { id: sid, permission: 'full' as const, personaId: 'a' };
  const qq = f.app.runtime.services.get('qq')!.value;
  const calls = [
    ['qzone_browse', { cursor: ref }, 'cursor'], ['qzone_read_image', { ref, index: 0 }, 'post'],
    ['qzone_collect_image', { actionId: 'collect', ref, index: 0 }, 'post'], ['qzone_like', { actionId: 'like', ref }, 'post'],
    ['qzone_comment', { actionId: 'comment', ref, text: 'own' }, 'post'], ['qzone_repost', { actionId: 'repost', ref }, 'post'],
  ] as const;
  for (const [name, args] of calls) {
    const result = (await f.app.tools.call(name, args, session)).result;
    assert.equal(result.error, diagnostic ? messages.session_mismatch : legacy);
    assert.equal(result.status, 'blocked'); assert.equal(result.confirmed, false); assert.equal(result.canRetry, false);
  }
  const state = await qq.testState();
  assert.equal(state.attempts.length, calls.length, 'diagnostics never rerun the operation');
  assert.deepEqual(state.diagnostics, diagnostic ? calls.map(([, , expectedKind]) => ({ sessionId: sid, ref, expectedKind })) : []);
  assert.equal(state.writes, 0);
  const preview = await f.request('/plugins/qq/qzone/browse', { cursor: ref });
  assert.equal(preview.status, 400);
  assert.equal((await preview.json()).error, diagnostic ? messages.session_mismatch : legacy);
  if (diagnostic) assert.equal((await qq.testState()).diagnostics.at(-1).sessionId, 'admin-preview');
  const events: any[] = []; f.app.runtime.events.on('tool/called', (e: any) => events.push(e));
  let round = 0;
  f.setGenerate(async input => {
    if (++round === 1) return { text: '', toolCalls: [{ id: 'read', name: 'qzone_read_image', arguments: JSON.stringify({ ref, index: 0 }) }] };
    assert.ok(JSON.stringify(input).includes(diagnostic ? messages.session_mismatch : legacy));
    return { text: '本轮临时诊断：' + messages.session_mismatch, toolCalls: [] };
  });
  await f.app.sessions.chat(sid, '查看测试图片', () => {}, undefined, 'a', { channel: 'web', account: 'web', peer: sid, persona: 'a', permission: 'full' });
  await f.app.runtime.events.drain();
  await qq.testGeneric();
  const count = (await qq.testState()).diagnostics.length;
  for (const [name, args] of calls.slice(0, 2)) {
    const result = (await f.app.tools.call(name, args, session)).result;
    assert.equal(result.error, readFailure); assert.doesNotMatch(result.error, /动作 ID|回执/);
  }
  const action = (await f.app.tools.call('qzone_like', { actionId: 'generic', ref }, session)).result;
  assert.match(action.error, /原动作 ID.*回执/); assert.equal((await qq.testState()).diagnostics.length, count);
  const persisted = JSON.stringify(events) + await disk(join(f.root, 'memory')) + await disk(join(f.root, 'logs')) + await disk(join(f.root, 'plugins/qq/sub/qzone/data'));
  for (const privateText of [ref, secret, messages.session_mismatch, legacy]) assert.ok(!persisted.includes(privateText), 'temporary diagnosis/reference leaked');
  assert.equal((await qq.testState()).writes, 0);
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
});

test('real QQ 0.14.4 transport diagnoses invalid image references without network access or model calls', { timeout: 25000 }, async t => {
  const f = await fixture(t, { preparePlugin: async root => {
    await mkdir(join(root, 'sub/qzone/data'), { recursive: true });
    await writeFile(join(root, 'sub/qzone/data/config.json'), JSON.stringify({ ...defaultConfig, enabled: true }));
  } });
  await f.online();
  await until(() => f.app.tools.list().some((x: any) => x.function.name === 'qzone_read_image'));
  const sid = await f.app.sessions.create('real-parent-reference');
  const before = f.calls.length;
  const result = (await f.app.tools.call('qzone_read_image', { ref: 'bad-ref', index: 0 }, { id: sid, permission: 'full', personaId: 'a' })).result;
  assert.equal(result.error, messages.invalid_reference); assert.equal(result.confirmed, false);
  assert.equal(f.calls.length, before); assert.equal(f.modelCalls.length, 0); assert.equal(f.generations.length, 0);
});
