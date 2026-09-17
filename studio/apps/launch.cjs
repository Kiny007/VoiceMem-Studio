'use strict';
const path = require('node:path');
const readline = require('node:readline/promises');
const { spawn } = require('node:child_process');

const PROVIDERS = Object.freeze([
  { id: 'deepseek', label: 'DeepSeek', credential: 'DEEPSEEK_API_KEY' },
  { id: 'qwen', label: 'Qwen / DashScope', credential: 'DASHSCOPE_API_KEY' },
  { id: 'openai', label: 'OpenAI', credential: 'OPENAI_API_KEY' },
  { id: 'local', label: '本地模型 / MLX', credential: 'OPENAI_API_KEY', macOnly: true },
]);

function providerChoices(platform = process.platform) {
  return PROVIDERS.filter(provider => !provider.macOnly || platform === 'darwin');
}

function selectProvider(value, platform = process.platform) {
  const choices = providerChoices(platform);
  const selected = String(value || '1').trim().toLowerCase();
  return choices.find((provider, index) => selected === provider.id || selected === String(index + 1));
}

async function readSecret(prompt, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') return '';
  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let secret = '';
    const finish = (error, value) => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onData = chunk => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') return finish(Object.assign(new Error('已取消启动。'), { code: 'CANCELLED' }));
        if (character === '\r' || character === '\n') return finish(null, secret.trim());
        if (character === '\u007f' || character === '\b') {
          if (secret) { secret = secret.slice(0, -1); output.write('\b \b'); }
        } else if (character >= ' ') { secret += character; output.write('*'); }
      }
    };
    input.on('data', onData);
  });
}

async function launchEnvironment({ platform = process.platform, env = process.env, input = process.stdin,
  output = process.stdout, askSecret = readSecret } = {}) {
  const choices = providerChoices(platform);
  output.write('\n选择回复 API：\n');
  choices.forEach((provider, index) => output.write(`  ${index + 1}. ${provider.label}\n`));
  const terminal = readline.createInterface({ input, output });
  let provider;
  try {
    while (!provider) {
      const answer = await terminal.question('请选择 [1]：');
      provider = selectProvider(answer, platform);
      if (!provider) output.write('请输入有效编号或 API 名称。\n');
    }
  } finally { terminal.close(); }
  const inherited = String(env[provider.credential] || '').trim();
  const secret = await askSecret(
    `请输入 ${provider.credential}${inherited ? '（回车沿用当前环境变量）' : '（回车沿用项目 .env）'}：`,
    { input, output },
  );
  return {
    ...env,
    ...(secret ? { [provider.credential]: secret } : {}),
    VOICEMEM_DESKTOP_MANAGED_PROVIDER: provider.id,
    VOICEMEM_DESKTOP_PROJECT_ROOT: path.resolve(__dirname, '../..'),
  };
}

async function main() {
  if (!['darwin', 'win32'].includes(process.platform)) {
    throw new Error('桌面 App 和桌宠仅面向 Windows / macOS。Linux 请启动 Studio 后端，或从其他电脑连接。');
  }
  if (!process.stdin.isTTY) throw new Error('npm start 需要交互终端来选择 API；请在 Terminal 或 PowerShell 中运行。');
  const env = await launchEnvironment();
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), ['.', ...process.argv.slice(2)], {
    cwd: __dirname, env, stdio: 'inherit',
  });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}

if (require.main === module) main().catch(error => {
  console.error(error.message);
  process.exitCode = error.code === 'CANCELLED' ? 130 : 1;
});

module.exports = { PROVIDERS, providerChoices, selectProvider, readSecret, launchEnvironment };
