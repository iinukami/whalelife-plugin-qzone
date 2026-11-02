import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { temporaryDirectory } from '../../whalelife/tests/temporary-directory.ts';
import { fixture, until } from '../../whalelife-plugin-qq/tests/fixture.ts';
import { defaultConfig } from '../src/policy.ts';

const sends = (f: Awaited<ReturnType<typeof fixture>>) => f.calls.filter(c => c.action === 'send_qzone_msg');
async function setup(t: Parameters<typeof fixture>[0], options: Parameters<typeof fixture>[1] = {}) {
  const f = await fixture(t, { ...options, config: { permission: 'full', ...options.config }, preparePlugin: async root => {
    await mkdir(join(root, 'sub/qzone/data'), { recursive: true });
    await writeFile(join(root, 'sub/qzone/data/config.json'), JSON.stringify({ ...defaultConfig, enabled: true }));
    await options.preparePlugin?.(root);
  } });
  await f.online(); await until(() => f.app.tools.list().some((x: any) => x.function.name === 'qzone_publish'));
  f.setAction((data, socket) => {
    if (data.action !== 'send_qzone_msg') return false;
    socket.send(JSON.stringify({ echo: data.echo, status: 'ok', retcode: 0, data: { tid: 'space_actual_' + sends(f).length } })); return true;
  });
  const sid = await f.app.sessions.create('isolated-space');
  const call = async (args: any, signal?: AbortSignal, id = sid) => (await f.app.tools.call('qzone_publish', args, { id, permission: 'full', personaId: 'a', signal })).result;
  const lookup = async (actionId: string, id = sid) => (await f.app.tools.call('qzone_delivery', { actionId, accountId: '100001' }, { id, personaId: 'a', permission: 'full' })).result;
  return { f, sid, call, lookup };
}

for (const baseline of ['current', '213b52b']) test(`qzone ${baseline}: public text, real gallery GIFs, scoped durable receipts and independent lifecycle`, { timeout: 60000 }, async t => {
  let hostBoot;
  if (baseline !== 'current') {
    const dir = await temporaryDirectory('whale-qzone-minhost-');
    execFileSync('git', ['-C', new URL('../../whalelife', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'archive', '--format=tar', '--output=' + join(dir, 'host.tar'), baseline, 'core', 'package.json']);
    execFileSync('tar', ['-xf', join(dir, 'host.tar'), '-C', dir]);
    await symlink(new URL('../../whalelife/node_modules', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), join(dir, 'node_modules'), 'junction');
    hostBoot = (await import(pathToFileURL(join(dir, 'core/index.ts')).href)).boot;
  }
  const { f, sid, call, lookup } = await setup(t, { hostBoot, prepareHost: async root => {
    await cp(new URL('../../whalelife-plugin-gallery/dist/gallery', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), join(root, 'plugins/gallery'), { recursive: true });
  } });
  const capabilities = await (await f.request('/plugins/qq/qzone/status')).json();
  assert.equal(capabilities.galleryMode, baseline === 'current' ? 'builtin' : 'legacy');
  assert.equal(f.app.runtime.records.has('qq/qzone/gallery'), baseline !== 'current');
  assert.equal(capabilities.capabilities.modelBrowse, baseline === 'current');
  assert.equal(f.app.tools.list().some((x: any) => x.function.name === 'qzone_browse'), baseline === 'current');
  assert.equal(f.app.tools.list().some((x: any) => x.function.name === 'qzone_collect_image'), baseline === 'current');
  const content = '第一句。\n第二句！';
  const result = await call({ actionId: 'text', content }); assert.equal(result.confirmed, true); assert.ok(result.tid);
  assert.equal(sends(f).length, 1); assert.equal(sends(f)[0].params.content, content); assert.equal(sends(f)[0].params.ugc_right, 1);
  assert.equal((await call({ actionId: 'text', content })).duplicate, true); assert.equal(sends(f).length, 1);
  assert.equal((await call({ actionId: 'text', content: 'changed' })).status, 'blocked');
  const other = await f.app.sessions.create('other'); assert.equal((await lookup('text', other)).status, 'not_found');
  await until(async () => (await (await f.request('/plugins/qq/qzone/status')).json()).gallery);
  assert.equal((await (await f.request('/plugins/qq/qzone/status')).json()).capabilities.collectImage, baseline === 'current');
  const gallery = f.app.runtime.services.get('gallery')!.value;
  const gif = await sharp(Buffer.alloc(8 * 16 * 3, 120), { raw: { width: 8, height: 16, channels: 3, pageHeight: 8 } }).gif().toBuffer();
  const offer = await gallery.offerMedia({ sessionId: sid, base64: gif.toString('base64') });
  const saved = await f.app.tools.call('gallery_collect', { mediaRef: offer.mediaRef, description: 'test GIF', purposes: ['image'] }, { id: sid, permission: 'full' });
  assert.equal(saved.result.state, 'saved');
  const id = saved.result.asset.id;
  assert.equal((await call({ actionId: 'images', content: 'my picture', imageIds: [id, id] })).confirmed, true);
  assert.deepEqual(sends(f).at(-1).params.images, ['base64://' + gif.toString('base64'), 'base64://' + gif.toString('base64')]);
  const dir = join(f.root, 'plugins/qq/sub/qzone/data/receipts');
  for (const name of await readdir(dir)) assert.ok(!(await readFile(join(dir, name), 'utf8')).includes(gif.toString('base64')));
  assert.ok(!JSON.stringify(await f.app.memory.readSession(sid)).includes(gif.toString('base64')));
  await f.app.runtime.action('gallery', 'stop');
  await until(async () => !(await (await f.request('/plugins/qq/qzone/status')).json()).gallery);
  assert.equal((await call({ actionId: 'without-gallery', content: 'still text' })).confirmed, true);
  assert.equal((await call({ actionId: 'blocked-image', content: 'picture', imageIds: [id] })).status, 'blocked');
  assert.equal((await call({ actionId: 'images', content: 'my picture', imageIds: [id, id] })).duplicate, true);
  const n = sends(f).length;
  await f.app.runtime.action('qq', 'reload'); await f.online();
  assert.equal((await call({ actionId: 'text', content })).confirmed, true); assert.equal(sends(f).length, n);
  await f.app.runtime.action('qq/qzone', 'stop');
  assert.ok(!f.app.tools.list().some((x: any) => x.function.name === 'qzone_publish'));
  await f.app.runtime.services.get('qq')!.value.sendText({ userId: '200002', messageId: 'private-ok', text: 'private still works' });
  assert.equal(f.calls.filter(c => c.action === 'send_private_msg').length, 1);
  await f.app.runtime.action('qq', 'reload'); await f.online();
  assert.ok(!f.app.tools.list().some((x: any) => x.function.name === 'qzone_publish'));
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
});

for (const mode of ['failed', 'missing-tid', 'disconnect', 'cancel', 'stop']) test(`qzone ${mode}: no automatic resend after cancellation/restart`, { timeout: 30000 }, async t => {
  const { f, call, lookup } = await setup(t);
  f.setAction((data, socket) => {
    if (data.action !== 'send_qzone_msg') return false;
    if (mode === 'failed' || mode === 'missing-tid') socket.send(JSON.stringify({ echo: data.echo, status: mode === 'failed' ? 'failed' : 'ok', retcode: mode === 'failed' ? 100 : 0, data: {} }));
    if (mode === 'disconnect') socket.terminate();
    return true;
  });
  const controller = new AbortController(), input = { actionId: mode, content: 'own text' };
  const task = call(input, controller.signal);
  await until(() => sends(f).length === 1);
  if (mode === 'cancel') controller.abort();
  if (mode === 'stop') await f.app.runtime.action('qq/qzone', 'stop');
  const r = await task;
  if (mode !== 'stop') assert.equal(r.status, 'uncertain');
  await f.app.runtime.action('qq/qzone', 'start'); await f.online();
  await until(() => f.app.tools.list().some((x: any) => x.function.name === 'qzone_publish'));
  assert.equal((await lookup(mode)).status, 'uncertain');
  assert.equal((await call(input)).status, 'uncertain'); assert.equal(sends(f).length, 1);
});

test('qzone settings authentication/revision and safe defaults; transient browse capability is detected', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.online();
  await until(() => f.app.tools.list().some((x: any) => x.function.name === 'qzone_publish'));
  assert.equal((await fetch(f.url + '/plugins/qq/qzone/config')).status, 401);
  const state = await (await f.request('/plugins/qq/qzone/config')).json();
  assert.equal(state.config.enabled, false); assert.deepEqual(state.config.interactionWhitelist, []);
  const response = await f.request('/plugins/qq/qzone/config', { revision: state.revision, config: { ...state.config, enabled: true, interactionWhitelist: ['200002'] } });
  assert.equal(response.status, 200);
  assert.equal((await f.request('/plugins/qq/qzone/config', { revision: state.revision, config: state.config })).status, 409);
  const status = await (await f.request('/plugins/qq/qzone/status')).json(); assert.equal(status.capabilities.modelBrowse, true);
  assert.ok(f.app.tools.list().some((x: any) => x.function.name === 'qzone_browse'));
  assert.equal(sends(f).length, 0); assert.equal(f.generations.length, 0);
});

test('host contract evidence: ordinary tool results enter experience and raw history', { timeout: 30000 }, async t => {
  const f = await fixture(t, { prepareHost: async root => {
    await mkdir(join(root, 'plugins/ephemeral-probe'), { recursive: true });
    await writeFile(join(root, 'plugins/ephemeral-probe/plugin.yaml'), 'id: ephemeral-probe\nname: probe\nversion: 1.0.0\ndescription: isolated public tool persistence probe\n');
    await writeFile(join(root, 'plugins/ephemeral-probe/index.ts'), "export function apply(ctx) {ctx.tools.register({name:'ephemeral_probe',description:'test',schema:{type:'object',properties:{}},danger:'safe',run:()=>({text:'SYNTHETIC_FOREIGN_TEXT_DO_NOT_KEEP'})});}");
  } });
  const sid = await f.app.sessions.create('probe'); let turn = 0;
  f.setGenerate(async () => turn++ === 0 ? { text: '', toolCalls: [{ id: 'probe', name: 'ephemeral_probe', arguments: '{}' }] } : { text: 'my own action only', toolCalls: [] });
  await f.app.sessions.chat(sid, 'test', () => {}, undefined, 'a', { channel: 'web', account: 'web', peer: sid, persona: 'a', permission: 'full' });
  assert.ok(JSON.stringify(await f.app.memory.readSession(sid)).includes('SYNTHETIC_FOREIGN_TEXT_DO_NOT_KEEP'));
  assert.ok(JSON.stringify(await f.app.memoryEngine.state(sid)).includes('SYNTHETIC_FOREIGN_TEXT_DO_NOT_KEEP'));
});

test('qzone holds no private-chat queue; settings disable cancels waiting and preserves pending across restart', { timeout: 30000 }, async t => {
  const { f, call, lookup } = await setup(t);
  f.setAction(data => data.action === 'send_qzone_msg');
  const input = { actionId: 'hold', content: 'mine' }, pending = call(input);
  await until(() => sends(f).length === 1);
  await f.app.runtime.services.get('qq')!.value.sendText({ userId: '200002', messageId: 'while-uploading', text: 'private independent' });
  assert.equal(f.calls.filter(c => c.action === 'send_private_msg').length, 1);
  assert.equal((await call({ actionId: 'another', content: 'second' })).status, 'blocked');
  const cfg = await (await f.request('/plugins/qq/qzone/config')).json();
  assert.equal((await f.request('/plugins/qq/qzone/config', { revision: cfg.revision, config: { ...cfg.config, enabled: false } })).status, 200);
  assert.equal((await pending).status, 'uncertain');
  await f.app.runtime.action('qq/qzone', 'reload');
  assert.equal((await lookup('hold')).status, 'uncertain'); assert.equal(sends(f).length, 1);
});
