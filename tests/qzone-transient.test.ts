import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, until } from '../../whalelife-plugin-qq/tests/fixture.ts';
import { defaultConfig } from '../src/policy.ts';

const foreign = 'SYNTHETIC_QZONE_FOREIGN_TEXT_NO_STORE', image = 'SYNTHETIC_QZONE_IMAGE_NO_STORE';
async function disk(root: string): Promise<string> {
  let result = '';
  try { for (const e of await readdir(root, { withFileTypes: true })) { const p = join(root, e.name); result += e.isDirectory() ? await disk(p) : await readFile(p, 'utf8'); } }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  return result;
}
const toolCall = (name: string, args = {}, id = name) => ({ id, name, arguments: JSON.stringify(args) });
async function enabled(root: string) {
  await mkdir(join(root, 'sub/qzone/data'), { recursive: true });
  await writeFile(join(root, 'sub/qzone/data/config.json'), JSON.stringify({ ...defaultConfig, enabled: true, interactionWhitelist: ['200002'] }));
}
async function fakeQQ(root: string) {
  await enabled(root);
  await writeFile(join(root, 'index.ts'), `export function apply(ctx) {
    let calls=[], reads=0, imageReads=0, held=false; const foreign=${JSON.stringify(foreign)}, image=${JSON.stringify(image)};
    const target={accountId:'100001',authorId:'200002',tid:'actual_tid',kind:'repost',interactive:true,typeId:'5',timestamp:'1700000000',comments:[{id:'c',authorId:'300003',replyable:true},{id:'a',authorId:'200002',replyable:true}]};
    ctx.provide('qq', {apiVersion:'1.0.0',qzoneApiVersion:'1.0.0',qzoneSocialApiVersion:'1.0.0',qzoneStatus:()=>({accountId:'100001',online:true}),
      qzonePublish:()=>({status:'sent',tid:'own_tid'}),
      qzoneBrowse: async (input,{signal})=>{reads++;if(held) await new Promise(r=>signal.addEventListener('abort',r,{once:true}));signal.throwIfAborted();return {accountId:'100001',posts:[{...target,ref:'read_ref',text:foreign,imageCount:1,hasVideo:true,comments:target.comments.map(c=>({...c,text:foreign}))},{...target,authorId:'300003',ref:'outside_ref',text:foreign,imageCount:0,hasVideo:false}],hasMore:false,skipped:0};},
      qzoneResolve: input=>({...target,authorId:input.ref==='outside_ref'?'300003':'200002'}),
      qzoneInteract: async (input,{signal})=>{calls.push(input);if(held) await new Promise(r=>signal.addEventListener('abort',r,{once:true}));signal.throwIfAborted();return {status:'sent',platformCode:0,platformId:'actual_comment'};},
      qzoneReadImage:()=>({mime:'image/png',base64:'synthetic'}),qzoneDescribeImage:()=>{imageReads++;return image;},
      testCalls:()=>calls,testReads:()=>reads,testImageReads:()=>imageReads,hold:()=>{held=true;},released:()=>{held=false;}});
  }`);
}
async function checkClean(f: Awaited<ReturnType<typeof fixture>>) {
  for (const dir of ['memory', 'logs', 'plugins/qq/data', 'plugins/qq/sub/qzone/data']) {
    const contents = await disk(join(f.root, dir));
    assert.ok(!contents.includes(foreign), dir + ' stores external text'); assert.ok(!contents.includes(image), dir + ' stores image descriptions');
  }
}

test('disabled QZone explains its master switch before accessing QQ; empty whitelist still allows enabled reads', { timeout: 30000 }, async t => {
  const f = await fixture(t, { preparePlugin: fakeQQ });
  await until(() => f.app.tools.list().some((x: any) => x.function.name === 'qzone_browse'));
  const qq = f.app.runtime.services.get('qq')!.value, sid = await f.app.sessions.create('qzone-switch');
  const session = { id: sid, permission: 'full' as const, personaId: 'a' };
  const before = await (await f.request('/plugins/qq/qzone/config')).json();
  await f.request('/plugins/qq/qzone/config', { revision: before.revision, config: { ...before.config, enabled: false, interactionWhitelist: [] } });
  for (const [name, args] of [['qzone_browse', { authorId: '100001' }], ['qzone_read_image', { ref: 'read_ref', index: 0 }]] as const) {
    const result: any = (await f.app.tools.call(name, args, session)).result;
    assert.equal(result.status, 'blocked'); assert.match(result.error, /空间自主使用已关闭/);
    assert.match(result.error, /尚未访问 QQ 空间/); assert.match(result.error, /读取自己的说说/);
  }
  assert.equal(await qq.testReads(), 0);
  const state = await (await f.request('/plugins/qq/qzone/config')).json();
  await f.request('/plugins/qq/qzone/config', { revision: state.revision, config: { ...state.config, enabled: true } });
  const browse: any = (await f.app.tools.call('qzone_browse', {}, session)).result;
  assert.equal(browse.posts.length, 2); assert.ok(browse.posts.every((p: any) => !p.canInteract));
  assert.equal(await qq.testReads(), 1);
  const bad: any = (await f.app.tools.call('qzone_browse', { extra: true }, session)).result;
  assert.equal(bad.error, '空间浏览参数无效。'); assert.equal(await qq.testReads(), 1);
  assert.equal(((await f.app.tools.call('qzone_read_image', { ref: 'read_ref', index: 0 }, session)).result as any).description, image);
  assert.equal((await qq.testCalls()).length, 0); await checkClean(f);
});
test('real isolated qzone tools: current turn sees external content, whitelist enforced, own receipts survive but copies never reach disk/events/next turn', { timeout: 40000 }, async t => {
  const f = await fixture(t, { preparePlugin: fakeQQ });
  const sid = await f.app.sessions.create('qzone-transient');
  await until(() => f.app.tools.list().some((x: any) => x.function.name === 'qzone_browse'));
  const events: any[] = []; f.app.runtime.events.on('tool/called', (e: any) => events.push(e));
  const session = { id: sid, permission: 'full' as const, personaId: 'a' };
  const browse: any = (await f.app.tools.call('qzone_browse', {}, session)).result;
  assert.equal(browse.posts[0].text, foreign); assert.equal(browse.posts[0].canInteract, true); assert.equal(browse.posts[0].canRepost, false);
  assert.deepEqual(browse.posts[0].imageAccess, { tool: 'qzone_read_image', indices: [0] });
  assert.equal(browse.posts[1].imageAccess, null);
  assert.equal(await f.app.runtime.services.get('qq')!.value.testReads(), 1);
  assert.equal(await f.app.runtime.services.get('qq')!.value.testImageReads(), 0, 'browsing advertises image access without automatically running vision');
  assert.equal(browse.posts[0].comments[0].canReply, false); assert.equal(browse.posts[0].comments[1].canReply, true); assert.equal(browse.posts[1].canInteract, false);
  for (const [name, args] of [ ['qzone_comment', { ref: 'read_ref', text: 'own', reply: { commentId: 'c', authorId: '300003' } }],
    ['qzone_comment', { ref: 'read_ref', text: 'own', mentions: ['300003'] }], ['qzone_repost', { ref: 'read_ref' }], ['qzone_like', { ref: 'outside_ref' }] ] as const) {
    assert.equal(((await f.app.tools.call(name, { actionId: name, ...args }, session)).result as any).status, 'blocked');
  }
  let round = 0;
  f.setGenerate(async input => {
    if (++round === 1) return { text: '', toolCalls: [toolCall('qzone_browse')] };
    if (round === 2) { assert.ok(JSON.stringify(input).includes(foreign)); return { text: '', toolCalls: [toolCall('qzone_read_image', { ref: 'read_ref', index: 0 })] }; }
    if (round === 3) { assert.ok(JSON.stringify(input).includes(image)); return { text: '', toolCalls: [
      toolCall('qzone_comment', { actionId: foreign, ref: 'read_ref', text: foreign, reply: { commentId: 'a', authorId: '200002' } }),
      toolCall('qzone_publish', { actionId: foreign, content: foreign }), toolCall('remember_fact', { text: foreign })] }; }
    return { text: foreign + image, toolCalls: [] };
  });
  const answer = await f.app.sessions.chat(sid, '请查看空间', () => {}, undefined, 'a', { channel: 'web', account: 'web', peer: sid, persona: 'a', permission: 'full' });
  assert.equal(answer, foreign + image);
  assert.equal(await f.app.runtime.services.get('qq')!.value.testImageReads(), 1, 'selected image understanding actually invokes the image reader');
  const calls = await f.app.runtime.services.get('qq')!.value.testCalls(); assert.equal(calls.length, 1);
  await f.app.runtime.events.drain(); assert.ok(!JSON.stringify(events).includes(foreign)); assert.ok(!JSON.stringify(events).includes(image));
  const rows = JSON.stringify(await f.app.memory.readSession(sid)); assert.ok(rows.includes('actual_comment'));
  assert.ok(JSON.stringify(await f.app.memoryEngine.state(sid)).includes('own_tid'));
  assert.ok(!rows.includes(foreign)); assert.equal((await f.app.memoryEngine.localFacts(sid)).text, ''); await checkClean(f);
  f.setGenerate(async input => { assert.ok(!JSON.stringify(input).includes(foreign)); assert.ok(!JSON.stringify(input).includes(image)); return { text: '下一轮正常交流', toolCalls: [] }; });
  await f.app.sessions.chat(sid, '继续聊', () => {}, undefined, 'a');
  await f.app.runtime.action('qq/qzone', 'reload');
  await until(() => f.app.tools.list().some((x: any) => x.function.name === 'qzone_delivery'));
  // Both actions used the same synthetic ID: publication query returns its own receipt;
  // the durable social receipt is additionally verified directly on disk.
  const receipt: any = (await f.app.tools.call('qzone_delivery', { accountId: '100001', actionId: foreign }, { ...session, transientContext: true })).result;
  assert.equal(receipt.tid, 'own_tid'); await checkClean(f);
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
});
test('qzone in-flight interaction cancellation retains uncertainty; read-only preview has no model/history side effects', { timeout: 30000 }, async t => {
  const f = await fixture(t, { preparePlugin: fakeQQ }); const sid = await f.app.sessions.create('qzone-cancel');
  await until(() => f.app.tools.list().some((x: any) => x.function.name === 'qzone_browse'));
  assert.equal((await fetch(f.url + '/plugins/qq/qzone/browse', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await (await f.request('/plugins/qq/qzone/browse', {})).json()).posts[0].text, foreign); assert.equal(f.generations.length, 0);
  const qq = f.app.runtime.services.get('qq')!.value; await qq.hold();
  const task = f.app.tools.call('qzone_comment', { ref: 'read_ref', actionId: 'held', text: 'own' }, { id: sid, permission: 'full', personaId: 'a' });
  await until(async () => (await qq.testCalls()).length === 1);
  const old = await (await f.request('/plugins/qq/qzone/config')).json();
  await f.request('/plugins/qq/qzone/config', { revision: old.revision, config: { ...old.config, interactionWhitelist: [] } });
  assert.equal(((await task).result as any).status, 'uncertain'); await qq.released();
  await f.app.runtime.action('qq/qzone', 'reload');
  await until(() => f.app.tools.list().some((x: any) => x.function.name === 'qzone_delivery'));
  const r: any = (await f.app.tools.call('qzone_delivery', { accountId: '100001', actionId: 'held' }, { id: sid, permission: 'full' })).result;
  assert.equal(r.status, 'uncertain'); assert.equal((await qq.testCalls()).length, 1); await checkClean(f);
});

test('QQ transient final reply is delivered once without private text plans; copied publish inputs/IDs do not persist', { timeout: 35000 }, async t => {
  const f = await fixture(t, { config: { permission: 'full' }, preparePlugin: enabled, prepareHost: async root => {
    await mkdir(join(root, 'plugins/temporary-probe'), { recursive: true });
    await writeFile(join(root, 'plugins/temporary-probe/plugin.yaml'), 'id: temporary-probe\nname: temporary probe\nversion: 1.0.0\ndescription: test\n');
    await writeFile(join(root, 'plugins/temporary-probe/index.ts'), `export function apply(ctx){ctx.tools.registerTransient({name:'external_read',description:'test',schema:{type:'object',properties:{}},danger:'safe',run:()=>({content:${JSON.stringify(foreign)},receipt:null})});}`);
  } });
  await f.online();
  f.setAction((data, socket) => { if (data.action !== 'send_qzone_msg') return false; socket.send(JSON.stringify({ echo: data.echo, status: 'ok', retcode: 0, data: { tid: 'actual_own_post' } })); return true; });
  let round = 0;
  f.setGenerate(async () => ++round === 1 ? { text: '', toolCalls: [toolCall('external_read')] }
    : round === 2 ? { text: '', toolCalls: [toolCall('qzone_publish', { actionId: foreign, content: foreign }), toolCall('qq_send_message', { userId: '200002', messageId: 'copied', text: foreign })] }
    : { text: foreign, toolCalls: [] });
  f.send({ message_id: 431 });
  await until(() => f.calls.some(c => c.action === 'send_private_msg'));
  await until(async () => (await f.status()).queued === 0);
  assert.equal(f.calls.filter(c => c.action === 'send_private_msg').length, 1);
  assert.equal(f.calls.find(c => c.action === 'send_private_msg').params.message[0].data.text, foreign);
  assert.equal(f.calls.filter(c => c.action === 'send_qzone_msg').length, 1);
  await checkClean(f);
  const files = await readdir(join(f.root, 'plugins/qq/data'));
  const plan = JSON.parse(await readFile(join(f.root, 'plugins/qq/data', files.find(n => n.startsWith('delivery-'))!), 'utf8'));
  assert.equal(plan.transient, true); assert.equal(plan.texts, undefined); assert.equal(plan.parts[0].state, 'sent');
  await f.app.runtime.action('qq', 'reload'); await f.online(); f.send({ message_id: 431 });
  await new Promise(r => setTimeout(r, 150)); assert.equal(f.calls.filter(c => c.action === 'send_private_msg').length, 1); await checkClean(f);
});
