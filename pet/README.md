# VoiceMem 桌面伙伴

置顶的 Electron 桌宠。当前形象由 Canvas 直接渲染，不依赖 Live2D、Cubism 或 PixiJS。

桌宠面向 Windows/macOS 本地桌面；Linux/WSL 后端只广播事件，不自动创建桌宠窗口。
使用 [Studio 桌面 App](../studio/apps/README.md) 时，桌宠已内置，无需在本目录安装依赖或单独启动。
以下命令仍适用于独立桌宠；App 打包直接复用这里的渲染与动画文件。

## 启动

```bash
cd pet
npm install
npm start
```

Mac 原生后端在启用自动桌宠时会启动它并连接 `/ws-pet`；Linux/WSL 只广播事件。
通过 App 使用时由 App 管理桌宠，Mac 后端设置 `STUDIO_DESKTOP_PET=0` 可避免重复窗口。

## 行为

- 助手音频实际播放时张嘴，停止播放时闭嘴。
- backchannel 触发歪头笑。
- 一轮回复播放结束后有 30% 概率歪头笑。
- 启动时显示休息状态；开始对话或检测到人声时切换到交互状态，20 秒无人声后恢复休息状态。

## 文件

| 文件 | 作用 |
| --- | --- |
| `main.cjs` | Electron 窗口、托盘和桌宠进程生命周期 |
| `avatar-rig.js` | 当前人物、嘴型、眨眼、点头、歪头笑和轻微待机动作 |
| `scene.js` | 窗帘背景与落叶动画 |
| `voicemem-link.js` | 将 `/ws-pet` 播放及会话事件映射为人物动作 |
| `renderer.js` | 点击、拖动、收起等界面交互 |

`window.petRig` 提供 `show()`、`hide()`、`talk()`、`stopTalking()`、`gesture()`、`tilt()`、`status()`。
