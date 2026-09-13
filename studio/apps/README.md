# VoiceMem Studio 桌面 App

主窗口直接加载 Studio 已有的 Web 页面，界面、语音协议、记忆面板与 Web 版一致。
桌面 App 和桌宠只面向 Windows/macOS；Linux 和 WSL 只运行后端。
桌面壳负责窗口、配置设置、麦克风授权、桌宠及可选的本机 Docker 自动启动，不包含推理模型或 Python 后端。
原有 `studio/apps/__init__.py` 保留；桌面包与 Python 包相互独立。

## 桌面方案

[DeepSeek 官方 Desktop](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md)
也使用 Electron 复用 Web UI，内置 Node 后端，通过管道、IPC 和自定义协议连接，不开放 Web 监听端口。
本项目采用相同的“桌面壳复用 Web UI”边界，但保留已有 Python/CUDA Docker 和原生 MLX 后端，
通过原有 HTTP/WebSocket 协议连接，不迁移后端通信协议。
平台分工、配置边界、目标启动流程和实现状态见 [平台设计](PLATFORMS.md)。

## 直接运行

在 Windows 或 macOS 安装 Node.js 22.12 或更新版本，在本目录执行：

```bash
npm ci
npm start
```

默认连接 `http://127.0.0.1:8787`。启动时显示黑灰配置页，服务就绪后自动打开主窗口。
服务仍在预热时最多等待三分钟；超时可以重试，不会停止后端。
通过菜单 **Studio → 配置设置**（`Ctrl/Cmd+,`）更改地址。第一次开始语音时会请求麦克风授权。

## App 内置桌宠

连接成功后默认显示雾铃，作为同一个 App 的透明置顶窗口，不再单独启动 Electron 或安装 `pet` 依赖。
菜单 **Studio → 显示桌宠** 控制本次运行中的显示/隐藏；桌宠的 × 只隐藏桌宠，不退出主窗口。
**找回桌宠位置** 将它移回主屏幕。拖拽、收起、坐姿/躺姿和动作继续使用现有交互。

- 原版 `pet/` 的渲染、动画与 `voicemem-link.js` 保留为唯一来源，不修改它的独立启动方式。
- 桌宠通过当前后端的 `/ws-pet` 只读观察真实播放进度、附和、打断和断线，不采集麦克风、不创建第二段对话。
- 切换服务会关闭旧桌宠连接；关闭 Studio 主窗口或退出 App 会关闭内置桌宠，Docker 后端继续运行。
- 打包包含坐姿/躺姿 Live2D 素材、贴图、Cubism Core 和固定版本 Pixi 依赖，桌宠不从 CDN 下载资源。
- 源码运行和打包自动执行 `prepare:pet`，按白名单生成忽略于 Git 的 `.pet-runtime/`。
  不打包 `pet/checks`、Cubism 编辑工程、PSD2Live 工具或第二份 Electron。

Linux/WSL 后端不会自动启动桌宠，Docker 也保留 `STUDIO_DESKTOP_PET=0`。
如果 App 连接同一台 Mac 的原生后端，启动后端时关闭它原来的自动桌宠，避免出现两只：

```bash
STUDIO_DESKTOP_PET=0 python -m studio
# 或给原有 scripts/run_studio_mlx.sh 加同一个环境变量
```

这只改变谁负责桌宠窗口，不关闭 `/ws-pet` 广播。App 不会终止已经独立运行的桌宠进程。

## 自动启动本机 Docker

在 Windows 配置页勾选“自动启动本机 Docker 服务”，选择已配置好的 VoiceMem-Studio 项目根目录并确认授权。
下次打开 App 会自动启动对应 `studio` 服务，并使用 Docker 实际发布的端口连接。

- 需要 Windows + NVIDIA、已运行的 Docker Desktop（WSL2 后端）、Docker Compose、已有的 Studio 镜像及项目配置。
- 这里只启动 Compose 服务，不启动 Docker Desktop，也不安装 WSL、驱动或模型环境。
- 沿用所选目录的 `compose.yaml` 和可选的 `compose.override.yaml`，不复制或修改 `.env`。
- 使用 `up -d --no-build --no-recreate --pull never studio`，不自动构建、拉取镜像或重建已有容器。
- 退出 App、取消等待均不停止容器，不删除模型、记忆或卷。
- 自动启动不操作远程 Docker context。远程 GPU 服务器请通过 HTTPS 或 SSH 转发连接。
- Mac 的 MLX 后端保持原生启动；Mac App 可以连接它，也可以连接远程 GPU 服务。
- WSL 内原生 Python 后端目前先在 WSL 中启动，Windows App 再连接 localhost；直接管理 `wsl.exe` 的适配尚未实现。
- Windows named-pipe 与命令参数已做模拟测试，完整 WSL/GPU 流程仍需 Windows 实机验收。

如果镜像还没构建，请先按 [Docker 部署说明](../../docker/README.md) 完成环境准备。
项目代码或 Docker 配置更新后仍需按原流程重新部署后端；App 不代替这一步。

## 打包

```bash
# 在 Windows x64 上构建含桌宠的 EXE 安装包
npm run dist:win

# 在 Apple Silicon Mac 上构建 DMG 和 ZIP
npm run dist:mac

# 在相应 Mac 环境中构建 Intel 版本
npm run dist:mac:x64
```

产物位于本目录的 `dist/`，不进入 Git。版本和依赖通过 `package.json`、`package-lock.json` 固定。
不再发布 Linux AppImage 或桌面便携包。已有 Linux 产物仅为历史开发测试文件，不代表最新发布。
Windows/macOS 安装包应在对应系统构建并验收；Windows 发布签名和 Mac 签名/公证需要发布者自己的凭据。
请用普通桌面用户运行，不要为日常使用关闭 Electron sandbox。
Mac 正式分发需开发者签名和公证；仓库提供麦克风用途说明和相应 entitlement，但不包含证书。
图标由仓库原有 `assets/logo.png` 裁切，生成脚本为 `scripts/make-icon.py`（仅重新生成图标时需要 Pillow）。

## 安全与数据

- 远程地址必须使用 HTTPS；HTTP 仅允许回环地址。不要通过关闭证书校验或 Web 安全性连接远程服务。
- 服务地址仅支持根地址，不带用户名、密码、路径或查询参数。LLM API Key 仍配置在后端。
- 主界面没有 Node.js 或本机 Docker IPC 权限，仅本地配置页有受限的设置接口。
- 桌宠只有受限窗口操作接口，没有连接设置、Docker 或 Node 权限。资源请求限于内置文件和当前 `/ws-pet`。
- 麦克风仅对配置的服务主页面授权，不授权摄像头、屏幕录制或第三方 iframe。
- 连接设置和页面缓存位于操作系统的 VoiceMem Studio 应用数据目录；不会导入浏览器私有缓存。
- 桌面包不含 `.env`、模型、记忆库、录音或运行日志。后端数据继续使用原位置或 Docker 卷。
- 上述模型指 ASR/TTS/LLM 等推理权重；内置桌宠的 Live2D 显示素材是 App 资源。
- 桌宠第三方声明与依赖许可证随包保留；Cubism Core 和角色素材沿用原有许可边界，打包不代表新增公开再分发授权。
- `VOICEMEM_DESKTOP_USER_DATA` 可以指定独立桌面配置目录，适合隔离测试。

## 验证

```bash
npm test
```

Linux 可用 `node scripts/smoke.cjs` 在 Xvfb 中验证真实窗口。它只使用临时假后端和假 Docker，
不调用真实容器、不打开个人记忆、不采集麦克风；截图留在其输出的临时目录。
它加载实际 Live2D 模型，用合成的 `/ws-pet` 事件验证嘴型、暂停/断线、服务切换及隐藏窗口。
可以用 `VOICEMEM_DESKTOP_BINARY` 指向已打包的程序，`VOICEMEM_XVFB` 指定 Xvfb。
`VOICEMEM_TEST_TMP` 指定临时目录；受控 root 测试额外要求 `VOICEMEM_SMOKE_ALLOW_ROOT=1`，
仅该测试启动器会临时使用 `--no-sandbox`。实际麦克风、音频设备和 Mac 权限仍需在目标桌面验收。
