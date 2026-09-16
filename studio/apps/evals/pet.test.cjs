'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
const { CUBISM_CORE, observerUrl, resourceAllowed, trustedSender } = require('../pet-policy.cjs');
const { preparePet, sourceFiles } = require('../scripts/prepare-pet.cjs');

test('pet observes only the selected service and bundled local assets', () => {
  const root = path.resolve('/fixture/app/.pet-runtime');
  const asset = file => pathToFileURL(path.join(root, file)).href;
  const ws = observerUrl('http://127.0.0.1:8787');
  assert.equal(ws, 'ws://127.0.0.1:8787/ws-pet');
  assert.equal(observerUrl('https://studio.example.com'), 'wss://studio.example.com/ws-pet');
  assert.equal(observerUrl('http://[::1]:8787'), 'ws://[::1]:8787/ws-pet');
  assert.throws(() => observerUrl('http://untrusted.example.com'));
  for (const url of [asset('index.html'), asset('assets/live2d/hiyori/hiyori_pro_t11.moc3'), CUBISM_CORE, ws]) assert.equal(resourceAllowed(url, root, ws), true);
  for (const url of [asset('../launcher.html'), asset('../.pet-runtime-other/secret'), 'file:///etc/passwd', `${ws}?other=1`,
    'ws://localhost:8787/ws-pet', 'ws://127.0.0.1:8787/ws', 'https://studio.example.com/script.js']) {
    assert.equal(resourceAllowed(url, root, ws), false, url);
  }
  assert.equal(resourceAllowed(ws, root, ''), false);
});

test('pet window controls reject another renderer, frame or document', () => {
  const page = 'file:///fixture/pet/index.html?ws=fixture';
  const frame = { url: page }, contents = { mainFrame: frame };
  const window = { webContents: contents, isDestroyed: () => false };
  const event = { sender: contents, senderFrame: frame };
  assert.equal(trustedSender(event, window, page), true);
  assert.equal(trustedSender({ ...event, sender: {} }, window, page), false);
  assert.equal(trustedSender({ ...event, senderFrame: { url: page } }, window, page), false);
  assert.equal(trustedSender(event, window, `${page}-other`), false);
  assert.equal(trustedSender(event, { ...window, isDestroyed: () => true }, page), false);
});

test('pet bundle includes the Live2D runtime, model and required licenses', async t => {
  const destination = await fs.mkdtemp(path.join(process.env.VOICEMEM_TEST_TMP || os.tmpdir(), 'studio-pet-test-'));
  t.after(() => fs.rm(destination, { recursive: true, force: true }));
  const inventory = await preparePet({ destination });
  const source = path.resolve(__dirname, '../../../pet');
  for (const file of sourceFiles) {
    const original = path.join(file.startsWith('node_modules/') ? path.resolve(__dirname, '..') : source, file);
    assert.deepEqual(await fs.readFile(path.join(destination, file)), await fs.readFile(original), file);
  }
  const html = await fs.readFile(path.join(destination, 'index.html'), 'utf8');
  for (const [, file] of html.matchAll(/(?:src|href)="([^"]+)"/g)) await fs.access(path.join(destination, file));
  assert.ok(inventory.includes('node_modules/pixi.js/dist/browser/pixi.min.js'));
  assert.ok(inventory.includes('node_modules/pixi-live2d-display/dist/cubism4.min.js'));
  assert.ok(html.includes("script-src 'self' 'unsafe-eval' https://cubism.live2d.com;"));
  for (const name of ['live2d-renderer.js', 'style.css']) {
    const content = await fs.readFile(path.join(destination, name), 'utf8');
    for (const [file] of content.matchAll(/assets\/[\w/.-]+\.png/g)) {
      assert.ok(inventory.includes(file), file);
      await fs.access(path.join(destination, file));
    }
  }
  assert.equal(inventory.some(file => /checks|package-lock|\.env/.test(file)), false);
  assert.equal(inventory.filter(file => file.endsWith('.png')).length, 3);
  assert.ok(inventory.includes('THIRD_PARTY_NOTICES.md'));
  assert.ok(inventory.includes('assets/live2d/hiyori/README-LICENSE.txt'));
  await fs.writeFile(path.join(destination, 'unexpected-private-file'), 'synthetic fixture');
  await assert.rejects(preparePet({ destination }), /Unexpected files/);
  assert.equal(await fs.readFile(path.join(destination, 'unexpected-private-file'), 'utf8'), 'synthetic fixture');
});

test('old Canvas pet resources are backed up once and excluded from the Live2D payload', async t => {
  const directory = await fs.mkdtemp(path.join(process.env.VOICEMEM_TEST_TMP || os.tmpdir(), 'studio-pet-migration-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'bundle');
  await fs.mkdir(path.join(destination, 'assets/avatar'), { recursive: true });
  await fs.writeFile(path.join(destination, 'avatar-rig.js'), 'old Canvas fixture');
  await fs.writeFile(path.join(destination, 'assets/avatar/calm.png'), 'old image fixture');
  await preparePet({ destination });
  const backups = (await fs.readdir(directory)).filter(file => file.startsWith('bundle.previous-'));
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(directory, backups[0], 'resources/avatar-rig.js'), 'utf8'), 'old Canvas fixture');
  await assert.rejects(fs.access(path.join(destination, 'avatar-rig.js')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(destination, 'assets/avatar')), { code: 'ENOENT' });
  await preparePet({ destination });
  assert.deepEqual((await fs.readdir(directory)).filter(file => file.startsWith('bundle.previous-')), backups);
});

test('desktop preload exposes the same reduced window API as the new pet', async () => {
  async function exposed(file) {
    let api;
    vm.runInNewContext(await fs.readFile(file, 'utf8'), { require: name => {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld: (key, value) => { assert.equal(key, 'pet'); api = value; } }, ipcRenderer: {} };
    } });
    return Object.keys(api).sort();
  }
  assert.deepEqual(await exposed(path.join(__dirname, '../pet-preload.cjs')), await exposed(path.resolve(__dirname, '../../../pet/preload.cjs')));
});
