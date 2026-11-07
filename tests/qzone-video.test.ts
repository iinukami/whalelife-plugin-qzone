import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { SpaceVideo, type VisionMediaService } from '../src/video.ts';
import type { QQSpaceTransport } from '../src/types.ts';
import { defaultConfig } from '../src/policy.ts';
import { fixture, until } from '../../whalelife-plugin-qq/tests/fixture.ts';
import { temporaryDirectory } from '../../whalelife/tests/temporary-directory.ts';

const secret = 'SYNTHETIC_VIDEO_CONTENT_DO_NOT_STORE';
const ref = 'SYNTHETIC_SPACE_REFERENCE_DO_NOT_STORE';
const mediaRef = 'vis_' + 'c'.repeat(48);
const ready = { serviceVersion: '1.0.0', mediaPreparation: true, mainModelViewing: true, videoDecoder: 'bundled' };
const offer = { mediaRef, expiresAt: new Date(Date.now() + 600000).toISOString(), info: { kind: 'video', mime: 'video/mp4', width: 160, height: 90, durationSeconds: 2, hasAudio: false } };
const video = { mime: 'video/mp4' as const, base64: Buffer.from(secret).toString('base64') };
const input = { sessionId: 'trusted-session', ref, index: 0 };

test('video capability reports the actual missing component without reading media or calling a model', async () => {
  let reads = 0, offers = 0;
  const qq = { qzoneVideoApiVersion: '1.0.0', qzoneReadVideo: async () => { reads++; return video; } } as unknown as QQSpaceTransport;
  const x = new SpaceVideo(qq, true), controller = new AbortController();
  assert.equal((await x.status()).reason, 'vision_required');
  assert.equal((await new SpaceVideo({} as QQSpaceTransport, true).status()).reason, 'transport_required');
  assert.equal((await new SpaceVideo(qq, false).status()).reason, 'multimodal_required');
  for (const [patch, expected] of [
    [{ serviceVersion: '2.0.0' }, 'vision_incompatible'], [{ mediaPreparation: false }, 'vision_unavailable'],
    [{ mainModelViewing: false }, 'multimodal_required'], [{ videoDecoder: 'unavailable' }, 'decoder_unavailable'], [{}, 'ready'],
  ] as const) {
    const remove = x.bind({ signal: controller.signal, service: { status: () => ({ ...ready, ...patch }),
      offerMedia: async () => { offers++; return offer; }, release: async () => ({ released: true }) } });
    assert.equal((await x.status()).reason, expected); remove();
  }
  assert.equal(reads, 0); assert.equal(offers, 0);
});

test('video adapter passes trusted identity and bytes only to vision, strips unknown output and sanitizes failures', async () => {
  let reads = 0, released = 0, fail = false;
  const qq = { qzoneVideoApiVersion: '1.0.0', qzoneReadVideo: async (v: unknown) => { reads++; assert.deepEqual(v, input); return video; } } as unknown as QQSpaceTransport;
  const x = new SpaceVideo(qq, true), lifetime = new AbortController();
  const service: VisionMediaService = { status: () => ready, offerMedia: async (v, options) => {
    assert.deepEqual(v, { sessionId: input.sessionId, ...video }); assert.equal(options.signal.aborted, false);
    if (fail) throw Error(secret);
    return { ...offer, info: { ...offer.info, privateField: secret }, privateField: secret };
  }, release: async () => { released++; } };
  x.bind({ signal: lifetime.signal, service });
  const result = await x.open(input, lifetime.signal);
  assert.equal(result.mediaRef, mediaRef); assert.equal(result.view.tool, 'vision_view');
  assert.equal(result.status, 'prepared'); assert.match(result.notice, /尚未查看/);
  assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!JSON.stringify(result).includes('base64'));
  fail = true; await assert.rejects(x.open(input, lifetime.signal), error => error instanceof Error && !error.message.includes(secret));
  service.offerMedia = async () => ({ ...offer, info: { ...offer.info, kind: 'image' } });
  await assert.rejects(x.open(input, lifetime.signal)); assert.equal(released, 1); assert.equal(reads, 3);
});

test('video adapter cancels downloads when the optional connection goes away and never offers late bytes', async () => {
  let finish!: (v: typeof video) => void, calls = 0, offers = 0;
  const qq = { qzoneVideoApiVersion: '1.0.0', qzoneReadVideo: () => { calls++; return new Promise(resolve => { finish = resolve; }); } } as unknown as QQSpaceTransport;
  const x = new SpaceVideo(qq, true), lifetime = new AbortController();
  x.bind({ signal: lifetime.signal, service: { status: () => ready, offerMedia: async () => { offers++; return offer; }, release: async () => {} } });
  const pending = x.open(input, new AbortController().signal);
  await until(() => calls === 1); lifetime.abort(); await assert.rejects(pending, /取消/);
  finish(video); await new Promise(r => setTimeout(r, 20));
  assert.equal(offers, 0); assert.equal((await x.status()).available, false);
});

async function fakeQQ(root: string, bytes = video.base64, modern = true) {
  await writeFile(join(root, 'plugin.yaml'), 'id: qq\nname: qq\nversion: 1.0.0\ndescription: isolated space video transport\nsub: [qzone]\n');
  await mkdir(join(root, 'sub/qzone/data'), { recursive: true });
  await writeFile(join(root, 'sub/qzone/data/config.json'), JSON.stringify({ ...defaultConfig, enabled: true }));
  await writeFile(join(root, 'index.ts'), `export function apply(ctx) {
    let reads=[],held=false;
    const target={accountId:'100001',authorId:'300003',tid:'synthetic',kind:'original',interactive:true,comments:[]};
    ctx.provide('qq',{qzoneApiVersion:'1.0.0',qzoneSocialApiVersion:'1.0.0',qzoneStatus:()=>({accountId:'100001',online:true}),
      qzonePublish:()=>{throw Error('must not publish');},qzoneInteract:()=>{throw Error('must not interact');},qzoneResolve:()=>target,
      qzoneBrowse:()=>({accountId:'100001',posts:[{...target,ref:${JSON.stringify(ref)},text:${JSON.stringify(secret)},imageCount:1,hasVideo:true,videoCount:1},
        {...target,ref:'unsupported',imageCount:0,hasVideo:true,videoCount:0},{...target,ref:'text-only',imageCount:0,hasVideo:false}],hasMore:false,skipped:0}),
      qzoneReadImage:()=>({mime:'image/png',base64:'synthetic'}),qzoneDescribeImage:()=> 'existing image works',
      ${modern ? `qzoneVideoApiVersion:'1.0.0',qzoneReadVideo:async (input,{signal})=>{reads.push(input);if(held)await new Promise(r=>signal.addEventListener('abort',r,{once:true}));signal.throwIfAborted();if(input.ref!==${JSON.stringify(ref)})throw Error('动态引用已过期、账号已变化或不属于本会话，请重新浏览。');return {mime:'video/mp4',base64:${JSON.stringify(bytes)}};},` : ''}
      testReads:()=>reads,testHold:value=>{held=value;},ping:()=> 'private independent'});
  }`);
}
async function fakeVision(root: string, hung = false) {
  const dir = join(root, 'plugins/vision'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'plugin.yaml'), 'id: vision\nname: vision\nversion: 1.0.0\ndescription: isolated video service\n');
  await writeFile(join(dir, 'index.ts'), `export function apply(ctx) {let offers=[];
    ctx.provide('vision',{status:()=>(${hung ? 'new Promise(()=>{})' : JSON.stringify(ready)}),offerMedia:(input)=>{offers.push(input.sessionId);return ${JSON.stringify(offer)};},release:()=>({released:true}),testOffers:()=>offers});
  }`);
}
async function disk(root: string): Promise<string> {
  let result = '';
  try { for (const e of await readdir(root, { withFileTypes: true })) { const path = join(root, e.name); result += e.isDirectory() ? await disk(path) : await readFile(path, 'utf8'); } }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  return result;
}

test('installed video integration binds optionally, rejects forged inputs, respects the switch and survives provider stop/reload', { timeout: 40000 }, async t => {
  const f = await fixture(t, { preparePlugin: root => fakeQQ(root) });
  const status = async () => (await f.request('/plugins/qq/qzone/status')).json();
  await until(async () => (await status()).capabilities.modelBrowse);
  const pid = f.app.runtime.records.get('qq/qzone').execution.pid;
  const sid = await f.app.sessions.create('video-only-test'), session = { id: sid, permission: 'full' as const, personaId: 'a' };
  const call = async (name: string, args: unknown) => (await f.app.tools.call(name, args, session)).result;
  assert.equal((await status()).video.reason, 'vision_required');
  assert.match((await call('qzone_open_video', { ref, index: 0 })).error, /启用视觉/);
  await fakeVision(f.root); await f.app.runtime.loadPath('vision');
  await until(async () => (await status()).capabilities.video);
  const qq = f.app.runtime.services.get('qq')!.value;
  const browse = await call('qzone_browse', {});
  assert.deepEqual(browse.posts[0].videoAccess, { available: true, tool: 'qzone_open_video', indices: [0], viewTool: 'vision_view' });
  assert.equal(browse.posts[0].canInteract, false, 'empty whitelist does not prohibit reading');
  assert.equal(browse.posts[1].videoAccess.reason, 'source_unavailable'); assert.equal(browse.posts[2].videoAccess, null);
  assert.equal((await qq.testReads()).length, 0, 'browsing does not download videos automatically');
  for (const args of [{ ref, index: 0, sessionId: 'forged' }, { ref, index: 0, url: 'https://invalid.invalid' }, { ref, index: 8 }, { ref, index: -1 }])
    assert.equal((await call('qzone_open_video', args)).status, 'blocked');
  assert.equal((await qq.testReads()).length, 0);
  assert.equal((await call('qzone_open_video', { ref, index: 0 })).mediaRef, mediaRef);
  assert.deepEqual(await qq.testReads(), [{ sessionId: sid, ref, index: 0 }]);
  assert.deepEqual(await f.app.runtime.services.get('vision')!.value.testOffers(), [sid]);
  const before = await (await f.request('/plugins/qq/qzone/config')).json();
  await f.request('/plugins/qq/qzone/config', { revision: before.revision, config: { ...before.config, enabled: false } });
  assert.match((await call('qzone_open_video', { ref, index: 0 })).error, /空间自主使用已关闭/);
  assert.equal((await qq.testReads()).length, 1);
  const disabled = await (await f.request('/plugins/qq/qzone/config')).json();
  await f.request('/plugins/qq/qzone/config', { revision: disabled.revision, config: { ...disabled.config, enabled: true } });
  await qq.testHold(true); const pending = call('qzone_open_video', { ref, index: 0 });
  await until(async () => (await qq.testReads()).length === 2);
  await f.app.runtime.action('vision', 'stop'); assert.equal((await pending).status, 'blocked');
  await until(async () => !(await status()).capabilities.video);
  assert.equal(f.app.runtime.records.get('qq/qzone').execution.pid, pid);
  assert.equal((await call('qzone_read_image', { ref, index: 0 })).description, 'existing image works');
  assert.equal(await qq.ping(), 'private independent');
  await f.app.runtime.action('vision', 'start'); await until(async () => (await status()).capabilities.video);
  assert.deepEqual(await f.app.runtime.services.get('vision')!.value.testOffers(), []);
  assert.equal(f.app.runtime.records.get('qq/qzone').execution.pid, pid);
  assert.equal(f.app.runtime.records.has('qq/qzone/vision'), false);
  assert.equal(f.app.runtime.records.get('qq/qzone').dependencies.has('vision'), false);
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
  const stored = await disk(join(f.root, 'memory')) + await disk(join(f.root, 'logs')) + await disk(join(f.root, 'plugins/qq/sub/qzone/data'));
  for (const value of [secret, ref, mediaRef, video.base64]) assert.ok(!stored.includes(value));
});

test('cached status coalesces probes, ignores detached results and never authorizes opening from stale readiness', async t => {
  let calls = 0, reads = 0, finish!: (v: typeof ready) => void;
  const qq = { qzoneVideoApiVersion: '1.0.0', qzoneReadVideo: async () => { reads++; return video; } } as unknown as QQSpaceTransport;
  const x = new SpaceVideo(qq, true), signal = new AbortController().signal;
  const service = { status: () => { calls++; return new Promise<typeof ready>(r => { finish = r; }); }, offerMedia: async () => offer, release: async () => {} };
  const remove = x.bind({ signal, service });
  for (let i = 0; i < 100; i++) assert.equal(x.cachedStatus().reason, 'checking');
  assert.equal(calls, 1); remove(); assert.equal(x.cachedStatus().reason, 'vision_required');
  let healthy = false, fastCalls = 0;
  x.bind({ signal, service: { ...service, status: () => { fastCalls++; return { ...ready, mediaPreparation: healthy }; } } });
  assert.equal(x.cachedStatus().reason, 'checking');
  await until(() => x.cachedStatus().reason === 'vision_unavailable');
  finish(ready); await new Promise(r => setTimeout(r, 10));
  assert.equal(x.cachedStatus().reason, 'vision_unavailable'); assert.equal(fastCalls, 1);
  let now = Date.now(); t.mock.method(Date, 'now', () => now); now += 30001; healthy = true;
  assert.equal(x.cachedStatus().reason, 'vision_unavailable', 'refresh returns the old snapshot immediately');
  await until(() => x.cachedStatus().available); assert.equal(fastCalls, 2);
  healthy = false; await assert.rejects(x.open(input, signal), /暂时不能准备媒体/);
  assert.equal(reads, 0, 'opening always verifies current readiness before downloading');
});

test('a hung optional vision status does not block space browse, settings, images or the parent', { timeout: 30000 }, async t => {
  const f = await fixture(t, { preparePlugin: root => fakeQQ(root), prepareHost: root => fakeVision(root, true) });
  const status = async () => (await f.request('/plugins/qq/qzone/status')).json();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([until(async () => (await status()).video.reason === 'checking'),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('optional status blocked settings')), 3000); })]);
  } finally { clearTimeout(timer); }
  const pid = f.app.runtime.records.get('qq/qzone').execution.pid;
  const session = { id: 'trusted', permission: 'full' as const, personaId: 'a' };
  try {
    const browse = await Promise.race([f.app.tools.call('qzone_browse', {}, session),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('optional status blocked browse')), 3000); })]);
    assert.equal(browse.result.posts.length, 3); assert.equal(browse.result.posts[2].videoAccess, null);
  } finally { clearTimeout(timer); }
  assert.equal((await f.app.tools.call('qzone_read_image', { ref, index: 0 }, session)).result.description, 'existing image works');
  assert.equal(await f.app.runtime.services.get('qq')!.value.ping(), 'private independent');
  await f.app.runtime.action('vision', 'stop');
  await until(async () => (await status()).video.reason === 'vision_required');
  assert.equal(f.app.runtime.records.get('qq/qzone').execution.pid, pid);
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
});

test('old QQ keeps image and browse capabilities while reporting its missing video transport', { timeout: 25000 }, async t => {
  const f = await fixture(t, { preparePlugin: root => fakeQQ(root, video.base64, false), prepareHost: fakeVision });
  const status = async () => (await f.request('/plugins/qq/qzone/status')).json();
  await until(async () => (await status()).capabilities.modelBrowse);
  assert.equal((await status()).capabilities.video, false); assert.equal((await status()).video.reason, 'transport_required');
  const session = { id: 'trusted', permission: 'full' as const, personaId: 'a' };
  assert.equal((await f.app.tools.call('qzone_read_image', { ref, index: 0 }, session)).result.description, 'existing image works');
  assert.match((await f.app.tools.call('qzone_open_video', { ref, index: 0 }, session)).result.error, /QQ 插件尚未提供/);
});

test('actual vision package: synthetic space video reaches the same main model as native frames and never future memory', { timeout: 60000 }, async t => {
  const temp = await temporaryDirectory('whale-space-video-media-');
  const visionRoot = fileURLToPath(new URL('../../whalelife-plugin-vision/dist/vision/', import.meta.url));
  const movie = join(temp, 'synthetic.mp4');
  execFileSync(join(visionRoot, 'runtime/ffmpeg/win32-x64/ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=5:d=2', '-an', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', movie],
  { windowsHide: true, timeout: 15000 });
  const bytes = (await readFile(movie)).toString('base64');
  const f = await fixture(t, { preparePlugin: root => fakeQQ(root, bytes), prepareHost: root => cp(visionRoot, join(root, 'plugins/vision'), { recursive: true }) });
  const status = async () => (await f.request('/plugins/qq/qzone/status')).json();
  await until(async () => (await status()).capabilities.video, 15000);
  const sid = await f.app.sessions.create('space-native-video');
  let round = 0, visualRef = '', imageData = '';
  const events: unknown[] = []; f.app.runtime.events.on('tool/called', (v: unknown) => events.push(v));
  f.setGenerate(async request => {
    round++;
    const tool = (name: string, args: unknown) => ({ text: '', toolCalls: [{ id: 'step' + round, name, arguments: JSON.stringify(args) }] });
    if (round === 1) return tool('qzone_browse', {});
    if (round === 2) { assert.ok(JSON.stringify(request).includes(secret)); return tool('qzone_open_video', { ref, index: 0 }); }
    if (round === 3) {
      const result = JSON.parse(request.messages.filter((m: any) => m.role === 'tool').at(-1).content).result;
      visualRef = result.mediaRef; assert.match(visualRef, /^vis_/); assert.ok(!JSON.stringify(result).includes(bytes));
      return tool('vision_view', { mediaRef: visualRef, atSeconds: 1, detail: 'detail' });
    }
    if (round === 4) {
      const content = request.messages.filter((m: any) => Array.isArray(m.content)).flatMap((m: any) => m.content);
      imageData = content.find((p: any) => p.type === 'image_url')?.image_url.url;
      assert.match(imageData, /^data:image\/jpeg;base64,/);
      assert.ok(content.some((p: any) => p.type === 'text' && p.text.includes('audioIncluded')));
      return { text: secret + ' understood this turn only', toolCalls: [] };
    }
    const next = JSON.stringify(request);
    for (const privateValue of [secret, ref, visualRef, bytes, imageData]) assert.ok(!next.includes(privateValue), 'previous video leaked into a later turn');
    return { text: 'next turn clean', toolCalls: [] };
  });
  await f.app.sessions.chat(sid, '查看测试视频', () => {}, undefined, 'a', { channel: 'web', account: 'web', peer: sid, persona: 'a', permission: 'full' });
  assert.equal(round, 4);
  const refused = await f.app.tools.call('vision_view', { mediaRef: visualRef, sessionId: sid }, { id: 'other-session', permission: 'full' });
  assert.ok(!refused.result.some((p: any) => p.type === 'image'));
  await f.app.sessions.chat(sid, '新一轮', () => {}, undefined, 'a', { channel: 'web', account: 'web', peer: sid, persona: 'a', permission: 'full' });
  await f.app.runtime.events.drain();
  const stored = JSON.stringify(events) + await disk(join(f.root, 'memory')) + await disk(join(f.root, 'logs')) + await disk(join(f.root, 'plugins/qq/sub/qzone/data'));
  for (const privateValue of [secret, ref, visualRef, bytes, imageData]) assert.ok(!stored.includes(privateValue), 'video leaked into persistent storage');
  assert.ok(stored.includes('prepare_visual_input'));
});
