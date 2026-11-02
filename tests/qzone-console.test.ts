import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { temporaryDirectory } from '../../whalelife/tests/temporary-directory.ts';
import { fixture, until } from '../../whalelife-plugin-qq/tests/fixture.ts';

// Exercise the built QQ package through the host's public management responses.
// Only this integration test imports the host renderer; plugin code never does.
for (const baseline of ['current', '213b52b']) test(`QQ console ${baseline}: parent settings, child management and preserved stop choice`, { timeout: 60000 }, async t => {
  let hostBoot, hostRoot = resolve('../whalelife');
  if (baseline !== 'current') {
    hostRoot = await temporaryDirectory('whale-qq-console-minhost-');
    execFileSync('git', ['-C', new URL('../../whalelife', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'archive', '--format=tar', '--output=' + join(hostRoot, 'host.tar'), baseline, 'core', 'package.json']);
    execFileSync('tar', ['-xf', join(hostRoot, 'host.tar'), '-C', hostRoot]);
    await symlink(new URL('../../whalelife/node_modules', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), join(hostRoot, 'node_modules'), 'junction');
    hostBoot = (await import(pathToFileURL(join(hostRoot, 'core/index.ts')).href)).boot;
  }
  const ui = await import(pathToFileURL(join(hostRoot, 'core/ui/extensions.js')).href);
  const f = await fixture(t, { hostBoot });
  await f.online();
  const status = async () => (await f.request('/api/status')).json();
  await until(async () => (await status()).pluginPages.some((p: any) => p.owner === 'qq/qzone' && p.settings));
  const initial = await status();
  const qqConfig = await readFile(join(f.root, 'plugins/qq/data/config.json'), 'utf8');
  const qzoneConfig = (await (await f.request('/plugins/qq/qzone/config')).json()).config;
  assert.equal(initial.plugins.find((p: any) => p.id === 'qq').name, 'QQ');
  assert.equal(initial.pluginPages.find((p: any) => p.path === '/plugins/qq/settings').title, 'QQ');
  for (const path of ['/plugins/qq/settings', '/plugins/qq/qzone/settings']) assert.equal((await f.request(path)).status, 200);
  const privatePage = await (await f.request('/plugins/qq/settings')).text();
  assert.match(privatePage, /id="allowedUsers"/);
  assert.match(privatePage, /id="galleryEnabled"/);
  const render = (s: any, page: string) => ui.extensionPage({ state: { status: s, page } }).render();
  if (baseline === 'current') {
    assert.equal(initial.plugins.find((p: any) => p.id === 'qq').console.groupChildren, true);
    assert.deepEqual(ui.visiblePluginCards(initial).filter((p: any) => p.id === 'qq' || p.id.startsWith('qq/')).map((p: any) => p.id), ['qq']);
    const nav = ui.extensionNavigation(initial);
    assert.equal((nav.match(/data-page="plugin:qq"/g) || []).length, 1);
    assert.ok(!nav.includes('QQ 空间'));
    const parent = render(initial, ui.pluginKey('qq'));
    assert.match(parent, /子插件/);
    assert.match(parent, /QQ 空间/);
    assert.match(parent, /src="\/plugins\/qq\/settings"/);
    assert.ok(!parent.includes('私聊子插件'));
    const oldLink = render(initial, ui.extensionKey('/plugins/qq/qzone/settings'));
    assert.match(oldLink, /class="plugin-root-name"[^>]*>QQ<\/a>/);
    assert.match(oldLink, /src="\/plugins\/qq\/qzone\/settings"/);
  } else {
    // Old hosts retain their existing flat navigation; the new declaration is harmless.
    const nav = ui.extensionNavigation(initial);
    assert.ok(nav.includes(ui.extensionKey('/plugins/qq/settings')));
    assert.ok(nav.includes(ui.extensionKey('/plugins/qq/qzone/settings')));
  }
  assert.equal((await f.request('/api/plugin', { id: 'qq/qzone', action: 'stop' })).status, 200);
  let stopped = await status();
  assert.equal(stopped.plugins.find((p: any) => p.id === 'qq').status, 'active');
  assert.equal(stopped.plugins.find((p: any) => p.id === 'qq/qzone').status, 'stopped');
  assert.equal(stopped.pluginPages.some((p: any) => p.owner === 'qq/qzone'), false);
  if (baseline === 'current') {
    const child = render(stopped, ui.pluginKey('qq/qzone'));
    assert.match(child, /QQ 空间/);
    assert.match(child, /data-plugin-id="qq\/qzone" data-plugin-action="start"/);
    assert.ok(!child.includes('<iframe'));
    const oldLink = render(stopped, ui.extensionKey('/plugins/qq/qzone/settings'));
    assert.match(oldLink, /data-plugin-id="qq\/qzone" data-plugin-action="start"/);
  }
  assert.equal((await f.request('/api/plugin', { id: 'qq', action: 'reload' })).status, 200);
  await f.online();
  stopped = await status();
  assert.equal(stopped.plugins.find((p: any) => p.id === 'qq/qzone').enabled, false);
  assert.equal(stopped.plugins.find((p: any) => p.id === 'qq/qzone').status, 'stopped');
  assert.equal((await f.request('/plugins/qq/settings')).status, 200);
  assert.equal(await readFile(join(f.root, 'plugins/qq/data/config.json'), 'utf8'), qqConfig);
  assert.equal((await f.request('/api/plugin', { id: 'qq/qzone', action: 'start' })).status, 200);
  await until(async () => (await status()).pluginPages.some((p: any) => p.owner === 'qq/qzone' && p.settings));
  assert.deepEqual((await (await f.request('/plugins/qq/qzone/config')).json()).config, qzoneConfig);
  if (baseline === 'current') assert.equal((ui.extensionNavigation(await status()).match(/data-page="plugin:qq"/g) || []).length, 1);
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
  assert.equal(f.calls.filter(c => ['send_private_msg', 'send_qzone_msg'].includes(c.action)).length, 0);
  assert.equal(f.generations.length, 0);
  assert.equal(f.modelCalls.length, 0);
});
