'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { PassThrough, Readable } = require('node:stream');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const launch = require('../launch.cjs');

test('npm start selects a provider and passes its credential without printing it', async () => {
  let printed = '';
  const output = { write(value) { printed += value; } };
  const env = await launch.launchEnvironment({
    platform: 'darwin', env: {}, input: Readable.from(['qwen\n']), output,
    askSecret: async () => 'dashscope-test-secret',
  });
  assert.equal(env.VOICEMEM_DESKTOP_MANAGED_PROVIDER, 'qwen');
  assert.equal(env.DASHSCOPE_API_KEY, 'dashscope-test-secret');
  assert.equal(path.basename(env.VOICEMEM_DESKTOP_PROJECT_ROOT), 'VoiceMem-Studio');
  assert.equal(printed.includes('dashscope-test-secret'), false);
});

test('provider menu only offers local MLX on macOS', () => {
  assert.equal(launch.selectProvider('4', 'darwin').id, 'local');
  assert.equal(launch.selectProvider('local', 'win32'), undefined);
  assert.equal(launch.selectProvider('', 'win32').id, 'deepseek');
});

test('API key input is masked and returns the entered value', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = value => { input.raw = value; };
  let printed = '';
  const secret = launch.readSecret('Key: ', { input, output: { write(value) { printed += value; } } });
  input.write('secret-value\n');
  assert.equal(await secret, 'secret-value');
  assert.equal(printed.includes('secret-value'), false);
  assert.match(printed, /\*{12}/);
  assert.equal(input.raw, false);
});

test('configuration page omits the removed descriptive copy', async () => {
  const html = await fs.readFile(path.join(__dirname, '../launcher.html'), 'utf8');
  assert.match(html, /class="nav-item">配置设置</);
  assert.doesNotMatch(html, /与你熟悉的|桌面工作区|连接设置|class="side-note"|class="eyebrow"/);
  const main = await fs.readFile(path.join(__dirname, '../main.cjs'), 'utf8');
  assert.match(main, /label: '配置设置'/);
});

test('Windows exposes Docker startup while macOS keeps the native MLX path', async () => {
  const script = await fs.readFile(path.join(__dirname, '../launcher.js'), 'utf8');
  for (const platform of ['win32', 'darwin', 'linux']) {
    const elements = new Map();
    const byId = id => {
      if (!elements.has(id)) elements.set(id, { addEventListener() {}, checked: false, hidden: false });
      return elements.get(id);
    };
    const state = { platform, version: 'fixture', settings: { serverUrl: 'http://localhost:8787', autoStartDocker: true, projectDir: '' }, status: { kind: 'idle', message: '' } };
    const context = { document: { getElementById: byId }, window: { studioDesktop: { onStatus() {}, state: async () => state } } };
    vm.runInNewContext(script, context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(byId('docker-options').hidden, platform !== 'win32');
    assert.equal(byId('docker').checked, platform === 'win32');
    assert.match(byId('platform-hint').textContent, platform === 'win32' ? /WSL2/ : platform === 'darwin' ? /原生 MLX/ : /只部署后端/);
  }
});

test('normal Linux entry points reject desktop startup before loading Electron', { skip: process.platform !== 'linux' }, async () => {
  for (const entry of ['../launch.cjs', '../../../pet/launch.cjs']) {
    await assert.rejects(promisify(execFile)(process.execPath, [path.resolve(__dirname, entry)]), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Windows.*macOS/);
      return true;
    });
  }
});
