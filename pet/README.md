# VoiceMem 桌面伙伴

置顶的 Electron 桌宠。当前形象由 Canvas 直接渲染，不依赖 Live2D、Cubism 或 PixiJS。

## 启动

```bash
cd pet
npm install
npm start
```

正常与 VoiceMem 一起运行时不需要单独启动：打开 `http://127.0.0.1:8787/?pet=1`，后端会启动桌宠并连接 `/ws-pet`。

## 行为

- 助手音频实际播放时张嘴，停止播放时闭嘴。
- backchannel 触发点头。
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
