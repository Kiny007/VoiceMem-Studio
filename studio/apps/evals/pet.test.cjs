'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { observerUrl, resourceAllowed, trustedSender } = require('../pet-policy.cjs');
const { preparePet, sourceFiles } = require('../scripts/prepare-pet.cjs');

test('pet observes only the selected service and bundled local assets', () => {
  const root = path.resolve('/fixture/app/.pet-runtime');
  const asset = file => pathToFileURL(path.join(root, file)).href;
  const ws = observerUrl('http://127.0.0.1:8787');
  assert.equal(ws, 'ws://127.0.0.1:8787/ws-pet');
  assert.equal(observerUrl('https://studio.example.com'), 'wss://studio.example.com/ws-pet');
  assert.equal(observerUrl('http://[::1]:8787'), 'ws://[::1]:8787/ws-pet');
  assert.throws(() => observerUrl('http://untrusted.example.com'));
  for (const url of [asset('index.html'), asset('models/sit/noctelle-sit.moc3'), ws]) assert.equal(resourceAllowed(url, root, ws), true);
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

test('pet bundle reuses original animation code and includes complete offline resources only', async t => {
  const destination = await fs.mkdtemp(path.join(process.env.VOICEMEM_TEST_TMP || os.tmpdir(), 'studio-pet-test-'));
  t.after(() => fs.rm(destination, { recursive: true, force: true }));
  const inventory = await preparePet({ destination });
  const source = path.resolve(__dirname, '../../../pet');
  for (const file of sourceFiles) assert.deepEqual(await fs.readFile(path.join(destination, file)), await fs.readFile(path.join(source, file)), file);
  const html = await fs.readFile(path.join(destination, 'index.html'), 'utf8');
  for (const [, file] of html.matchAll(/(?:src|href)="([^"]+)"/g)) await fs.access(path.join(destination, file));
  assert.equal(html.includes('node_modules/'), false);
  assert.ok(html.includes("script-src 'self' 'wasm-unsafe-eval'"));
  for (const pose of ['sit', 'lie']) {
    const directory = path.join(destination, 'models', pose);
    const model = JSON.parse(await fs.readFile(path.join(directory, `noctelle-${pose}.model3.json`), 'utf8')).FileReferences;
    for (const file of [model.Moc, model.DisplayInfo, ...model.Textures, ...Object.values(model.Motions).flat().map(motion => motion.File)]) await fs.access(path.join(directory, file));
  }
  assert.equal(inventory.some(file => /\.cmo3|psd2live|checks|node_modules|package-lock|\.env/.test(file)), false);
  assert.equal(inventory.filter(file => file.endsWith('.LICENSE.txt')).length, 3);
  await fs.writeFile(path.join(destination, 'unexpected-private-file'), 'synthetic fixture');
  await assert.rejects(preparePet({ destination }), /Unexpected files/);
});
