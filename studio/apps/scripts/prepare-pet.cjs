'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

const sourceFiles = [
  'style.css', 'state.cjs', 'renderer.js', 'rig.js', 'voicemem-link.js',
  'tilted-smile.js', 'transparency.js', 'face-calibration.js', 'motion-calibration.js',
  'assets/sit.png', 'assets/lie.png', 'vendor/live2dcubismcore.min.js', 'THIRD_PARTY_NOTICES.md',
  ...['sit', 'lie'].flatMap(pose => [
    ...['model3.json', 'moc3', 'cdi3.json', 'idle.motion3.json', 'blink.motion3.json', 'nod.motion3.json', 'shake.motion3.json']
      .map(suffix => `models/${pose}/noctelle-${pose}.${suffix}`),
    `models/${pose}/noctelle-${pose}.2048/texture_00.png`,
  ]),
];
const vendors = [
  ['pixi.js', 'dist/browser/pixi.min.js', 'pixi.min.js'],
  ['@pixi/unsafe-eval', 'dist/browser/unsafe-eval.min.js', 'unsafe-eval.min.js'],
  ['pixi-live2d-display', 'dist/cubism4.min.js', 'cubism4.min.js'],
];

function desktopHtml(html) {
  for (const [pkg, source, destination] of vendors) {
    const reference = `node_modules/${pkg}/${source}`;
    if (!html.includes(reference)) throw new Error(`Pet asset reference changed: ${reference}`);
    html = html.replace(reference, `vendor/${destination}`);
  }
  const policy = /connect-src [^;]+;/;
  if (!policy.test(html)) throw new Error('Pet connection policy is missing.');
  // The dedicated Electron session further restricts this to the selected observer URL.
  return html.replace(policy, "connect-src 'self' ws://127.0.0.1:* ws://localhost:* ws://[::1]:* wss:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none';")
    .replace('id="quit" title="退出" aria-label="退出"', 'id="quit" title="隐藏桌宠" aria-label="隐藏桌宠"');
}

async function preparePet({ apps = path.resolve(__dirname, '..'), destination = path.join(apps, '.pet-runtime') } = {}) {
  const source = path.resolve(apps, '../../pet');
  await fs.mkdir(destination, { recursive: true });
  const inventory = ['index.html', ...sourceFiles];
  for (const file of sourceFiles) {
    await fs.mkdir(path.dirname(path.join(destination, file)), { recursive: true });
    await fs.copyFile(path.join(source, file), path.join(destination, file));
  }
  await fs.writeFile(path.join(destination, 'index.html'), desktopHtml(await fs.readFile(path.join(source, 'index.html'), 'utf8')));
  for (const [pkg, entry, name] of vendors) {
    const root = path.join(apps, 'node_modules', pkg);
    await fs.copyFile(path.join(root, entry), path.join(destination, 'vendor', name));
    const license = (await fs.readdir(root)).find(file => /^licen[cs]e(?:\.md|\.txt)?$/i.test(file));
    if (!license) throw new Error(`Missing package license: ${pkg}`);
    const notice = `vendor/${pkg.replaceAll('/', '-')}.LICENSE.txt`;
    await fs.copyFile(path.join(root, license), path.join(destination, notice));
    inventory.push(`vendor/${name}`, notice);
  }
  // Reject stale or extra files instead of accidentally shipping local pet experiments.
  const actual = [];
  async function visit(relative = '') {
    for (const entry of await fs.readdir(path.join(destination, relative), { withFileTypes: true })) {
      const file = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) actual.push(file);
      else throw new Error(`Unexpected pet resource type: ${file}`);
    }
  }
  await visit();
  if (actual.sort().join('\n') !== inventory.sort().join('\n')) throw new Error('Unexpected files in generated .pet-runtime; inspect the build directory before packaging.');
  return inventory;
}

if (require.main === module) preparePet().then(files => console.log(`[desktop] Pet resources prepared: ${files.length} files`))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { sourceFiles, vendors, desktopHtml, preparePet };
