'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const r = require('../runtime.cjs');

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(process.env.VOICEMEM_TEST_TMP || os.tmpdir(), 'studio-desktop-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('server URL allows HTTPS and local HTTP but not unsafe origins or credentials', () => {
  for (const url of ['http://localhost:8787', 'http://127.0.0.1:8787/', 'http://[::1]:8787', 'https://studio.example.com/']) assert.equal(r.serverUrl(url), new URL(url).origin);
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'http://studio.example.com', 'http://localhost.evil.test', 'https://user:secret@studio.example.com', 'http://0.0.0.0:8787', 'https://studio.example.com/path', 'https://studio.example.com/?key=secret']) assert.throws(() => r.serverUrl(url));
});

test('only main-frame audio from the configured origin is eligible', () => {
  const origin = 'https://studio.example.com';
  assert.equal(r.audioPermission('media', { mediaTypes: ['audio'], isMainFrame: true }, origin, `${origin}/`), true);
  assert.equal(r.audioPermission('media', { mediaType: 'audio' }, origin, origin), true);
  for (const details of [{ mediaTypes: ['video'] }, { mediaTypes: ['audio', 'video'] }, { mediaTypes: [] }, { mediaType: 'unknown' }, { mediaTypes: ['audio'], isMainFrame: false }]) assert.equal(r.audioPermission('media', details, origin, origin), false);
  assert.equal(r.audioPermission('media', { mediaTypes: ['audio'] }, origin, 'https://other.example.com'), false);
  assert.equal(r.audioPermission('display-capture', {}, origin, origin), false);
});

test('settings persist only connection fields and reject malformed data', async t => {
  const directory = await temporary(t), file = path.join(directory, 'profile', 'connection.json');
  assert.deepEqual(await r.loadSettings(file), r.DEFAULTS);
  await r.saveSettings(file, { ...r.DEFAULTS, serverUrl: 'http://localhost:9000/', unrelatedSecret: 'test-only' });
  assert.deepEqual(await r.loadSettings(file), { ...r.DEFAULTS, serverUrl: 'http://localhost:9000' });
  assert.equal((await fs.readFile(file, 'utf8')).includes('unrelatedSecret'), false);
  await fs.writeFile(file, '{broken');
  await assert.rejects(r.loadSettings(file), /重新保存/);
  assert.throws(() => r.settings({ ...r.DEFAULTS, autoStartDocker: 'true' }));
});

test('Docker startup preserves compose overrides and uses the published port', async t => {
  const directory = await temporary(t);
  for (const file of ['compose.yaml', 'pyproject.toml', 'compose.override.yaml']) await fs.writeFile(path.join(directory, file), 'fixture');
  const calls = [];
  const url = await r.startDocker(directory, { platform: 'linux', env: {}, run: async (file, args, options) => {
    calls.push({ file, args, cwd: options.cwd });
    return args[0] === 'context' ? '"unix:///var/run/docker.sock"' : args.includes('port') ? '127.0.0.1:8788' : '';
  } });
  assert.equal(url, 'http://127.0.0.1:8788');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].args.slice(-7), ['up', '-d', '--no-build', '--no-recreate', '--pull', 'never', 'studio']);
  assert.ok(calls[1].args.includes(path.join(directory, 'compose.override.yaml')));
  assert.equal(calls.every(call => call.file === 'docker' && call.cwd === directory), true);
  assert.equal(calls.some(call => call.args.includes('down') || call.args.includes('build')), false);
});

test('Docker startup refuses remote contexts and unsupported local CUDA platforms', async t => {
  const directory = await temporary(t);
  for (const file of ['compose.yaml', 'pyproject.toml']) await fs.writeFile(path.join(directory, file), 'fixture');
  await assert.rejects(r.startDocker(directory, { platform: 'darwin' }), /Windows/);
  await assert.rejects(r.startDocker(directory, { platform: 'linux', env: { DOCKER_HOST: 'ssh://server' } }), /本机/);
  await assert.rejects(r.startDocker(directory, { platform: 'linux', env: {}, run: async () => '"ssh://server"' }), /context/);
  assert.equal(r.publishedUrl('0.0.0.0:9000'), 'http://127.0.0.1:9000');
  assert.equal(r.publishedUrl('[::]:9001'), 'http://127.0.0.1:9001');
  assert.throws(() => r.publishedUrl('unavailable'));
});

test('Windows Docker startup accepts only a local named pipe', async t => {
  const directory = await temporary(t);
  for (const file of ['compose.yaml', 'pyproject.toml']) await fs.writeFile(path.join(directory, file), 'fixture');
  for (const endpoint of ['npipe:////./pipe/docker_engine', 'npipe:////./pipe/dockerDesktopLinuxEngine']) {
    const calls = [];
    const url = await r.startDocker(directory, { platform: 'win32', env: { DOCKER_HOST: endpoint }, run: async (file, args) => {
      calls.push({ file, args });
      return args[0] === 'context' ? JSON.stringify(endpoint) : args.includes('port') ? '0.0.0.0:8787' : '';
    } });
    assert.equal(url, r.DEFAULTS.serverUrl);
    assert.deepEqual(calls[1].args.slice(-7), ['up', '-d', '--no-build', '--no-recreate', '--pull', 'never', 'studio']);
  }
  for (const endpoint of ['npipe:////remote-server/pipe/docker_engine', 'tcp://localhost:2375', 'ssh://server', 'unix:///var/run/docker.sock']) {
    await assert.rejects(r.startDocker(directory, { platform: 'win32', env: {}, run: async () => JSON.stringify(endpoint) }), /context/);
    await assert.rejects(r.startDocker(directory, { platform: 'win32', env: { DOCKER_HOST: endpoint } }), /本机/);
  }
});

test('readiness checks only GET the existing Web root', async t => {
  const server = http.createServer((req, res) => {
    assert.equal(req.method, 'GET'); assert.equal(req.url, '/');
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><title>VoiceMem</title></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await r.probe(`http://127.0.0.1:${server.address().port}`);
});

test('readiness waiting retries, cancels and times out without starting another service', async () => {
  let count = 0;
  await r.waitForStudio(r.DEFAULTS.serverUrl, { intervalMs: 1, timeoutMs: 100, check: async () => { if (++count < 3) throw new Error('not ready'); } });
  assert.equal(count, 3);
  const cancel = new AbortController();
  const waiting = r.waitForStudio(r.DEFAULTS.serverUrl, { signal: cancel.signal, intervalMs: 100, check: async () => { cancel.abort(); throw new Error('not ready'); } });
  await assert.rejects(waiting, { name: 'AbortError' });
  await assert.rejects(r.waitForStudio(r.DEFAULTS.serverUrl, { timeoutMs: 4, intervalMs: 1, check: async () => { throw new Error('offline'); } }), /尚未就绪/);
});

test('packaging excludes inference weights, credentials, recordings, backend source and tests', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('main.cjs'));
  assert.ok(pkg.build.files.includes('.pet-runtime/**/*'));
  for (const item of pkg.build.files) assert.equal(/\.env|models|record|prompt|tests|evals|voicemem_memoryspace|\.\.\//.test(item), false);
  assert.equal(pkg.devDependencies.electron.startsWith('^'), false);
  assert.equal(pkg.scripts['dist:linux'], undefined);
  assert.equal(pkg.build.linux, undefined);
  assert.ok(pkg.scripts['dist:win'].includes('--win nsis --x64'));
  assert.ok(pkg.scripts['dist:mac'].includes('--mac dmg zip --arm64'));
});
