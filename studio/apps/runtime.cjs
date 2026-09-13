'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const DEFAULTS = Object.freeze({ serverUrl: 'http://127.0.0.1:8787', autoStartDocker: false, projectDir: '' });

function loopback(hostname) {
  return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function serverUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('请输入完整服务地址，例如 http://127.0.0.1:8787'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('服务地址只填写 HTTP/HTTPS 根地址，不包含用户名、密码、路径或查询参数。');
  }
  if (url.protocol === 'http:' && !loopback(url.hostname)) {
    if (url.hostname === '0.0.0.0') throw new Error('0.0.0.0 是监听地址，请改填 http://127.0.0.1:8787 或实际服务器地址。');
    throw new Error('远程服务请使用 HTTPS；也可以通过 SSH 转发后连接 http://127.0.0.1:8787。');
  }
  return url.origin;
}

function settings(value = DEFAULTS) {
  if (!value || typeof value !== 'object' || typeof value.autoStartDocker !== 'boolean' || typeof value.projectDir !== 'string') {
    throw new Error('连接配置格式不正确，请重新设置。');
  }
  return { serverUrl: serverUrl(value.serverUrl), autoStartDocker: value.autoStartDocker, projectDir: value.projectDir };
}

function sameOrigin(value, origin) {
  try { return new URL(value).origin === origin; } catch { return false; }
}

function audioPermission(permission, details, origin, requestingUrl) {
  if (permission !== 'media' || details.isMainFrame === false || !sameOrigin(requestingUrl, origin)) return false;
  if (Array.isArray(details.mediaTypes)) return details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio';
  return details.mediaType === 'audio';
}

async function loadSettings(file) {
  try { return settings(JSON.parse(await fs.readFile(file, 'utf8'))); }
  catch (error) {
    if (error.code === 'ENOENT') return { ...DEFAULTS };
    throw new Error('无法读取连接配置，请在连接页重新保存设置。');
  }
}

async function saveSettings(file, value) {
  const validated = settings(value);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(validated, null, 2), { mode: 0o600 });
  await fs.rename(`${file}.tmp`, file);
}

async function validateProject(directory) {
  if (!directory || !path.isAbsolute(directory)) throw new Error('请选择已配置好的 VoiceMem-Studio 项目目录。');
  const root = await fs.realpath(directory);
  for (const name of ['compose.yaml', 'pyproject.toml']) {
    if (!(await fs.stat(path.join(root, name))).isFile()) throw new Error('所选目录不是完整的 VoiceMem-Studio 项目。');
  }
  return root;
}

function command(file, args, { cwd, signal, timeoutMs = 60000, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const control = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
    let output = '', errors = '';
    const child = spawnImpl(file, args, { cwd, signal: control, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { output = (output + data.toString()).slice(-16000); });
    child.stderr.on('data', data => { errors = (errors + data.toString()).slice(-16000); });
    child.once('error', error => reject(error.code === 'ENOENT' ? new Error('找不到 Docker 命令，请先安装 Docker 和 Compose。') : error));
    child.once('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(errors.trim() || `Docker 命令退出，状态码 ${code}`)));
  });
}

function publishedUrl(output) {
  const line = output.trim().split('\n')[0];
  const match = /:(\d+)$/.exec(line);
  if (!match || +match[1] < 1 || +match[1] > 65535) throw new Error('无法取得 studio 容器的发布端口，请检查 Compose 配置。');
  return `http://127.0.0.1:${+match[1]}`;
}

async function startDocker(directory, { signal, run = command, platform = process.platform, env = process.env } = {}) {
  if (!['win32', 'linux'].includes(platform)) throw new Error('桌面 Docker 自动启动用于 Windows 的 WSL2/NVIDIA 后端。Mac 请连接原生 MLX 或远程服务。');
  const root = await validateProject(directory);
  const isLocal = endpoint => typeof endpoint === 'string' && (platform === 'win32'
    ? /^npipe:\/{2,4}\.\/pipe\/[A-Za-z0-9_.-]+$/.test(endpoint)
    : endpoint.startsWith('unix://'));
  if (env.DOCKER_HOST && !isLocal(env.DOCKER_HOST)) throw new Error('自动启动只支持本机 Docker；远程服务请直接填写服务地址。');
  const endpoint = JSON.parse(await run('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'], { cwd: root, signal }));
  if (!isLocal(endpoint)) throw new Error('当前 Docker context 不是本机，请切换到本机 context。');
  const compose = ['compose', '--project-directory', root, '-f', path.join(root, 'compose.yaml')];
  try {
    if ((await fs.stat(path.join(root, 'compose.override.yaml'))).isFile()) compose.push('-f', path.join(root, 'compose.override.yaml'));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await run('docker', [...compose, 'up', '-d', '--no-build', '--no-recreate', '--pull', 'never', 'studio'], { cwd: root, signal });
  return publishedUrl(await run('docker', [...compose, 'port', 'studio', '8787'], { cwd: root, signal }));
}

async function probe(url, { signal, timeoutMs = 2500, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${serverUrl(url)}/`, {
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]), redirect: 'error',
  });
  let reader;
  try {
    if (!response.ok) throw new Error(`服务返回 HTTP ${response.status}`);
    reader = response.body.getReader();
    let html = '';
    while (html.length < 16384) {
      const { value, done } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value.subarray(0, 16384 - html.length));
      if (/<title>\s*VoiceMem(?: Studio)?\s*<\/title>/i.test(html)) return;
    }
    throw new Error('该地址没有返回 VoiceMem 页面，请检查服务地址。');
  } finally {
    try { await (reader ? reader.cancel() : response.body?.cancel()); } catch { /* The request may already have been aborted. */ }
  }
}

async function waitForStudio(url, { signal, timeoutMs = 180000, intervalMs = 1500, check = probe, onWait = () => {} } = {}) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    signal?.throwIfAborted();
    try { await check(url, { signal }); return; }
    catch (error) { signal?.throwIfAborted(); lastError = error; }
    onWait(Math.floor((Date.now() - started) / 1000));
    await delay(intervalMs, undefined, { signal });
  }
  throw new Error(`服务尚未就绪，请检查 Docker 日志或稍后重试。${lastError?.message || ''}`);
}

module.exports = { DEFAULTS, serverUrl, settings, sameOrigin, audioPermission, loadSettings, saveSettings,
  validateProject, command, publishedUrl, startDocker, probe, waitForStudio };
