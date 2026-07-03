# 📸 Long Screenshot Capture - Edge/Chrome Extension

一个基于浏览器原生渲染的**网页长截图工具**，无需 DOM 解析，完美还原视觉画面。

## ✨ 核心特性

- ✅ **真实渲染截图** — 使用 `captureVisibleTab` 获取浏览器真实渲染画面，与肉眼看到的一致
- ✅ **自动滚动拼接** — 自动滚动页面 + 分段截图 + Canvas 智能拼接
- ✅ **MV3 兼容** — 完全基于 Manifest V3，支持 Edge/Chrome 最新版本
- ✅ **零 DOM 依赖** — 不依赖 `html2canvas` / `dom-to-image`，无页面结构解析
- ✅ **智能底部检测** — 自动判断页面是否滚动到底部，避免重复截图
- ✅ **用户可控** — 可自定义滚动延迟、滚动步长，支持手动停止

## 🚀 安装使用

### 方法一：开发者模式加载

1. 打开 Edge 浏览器，访问 `edge://extensions/`
2. 开启右上角「**开发者模式**」
3. 点击「**加载已解压的扩展程序**」
4. 选择本项目的 `extension/` 文件夹
5. 完成！点击工具栏图标即可使用

### 方法二：Chrome 浏览器

1. 打开 Chrome，访问 `chrome://extensions/`
2. 同样开启「**开发者模式**」
3. 加载 `extension/` 文件夹

## 📖 使用步骤

1. 打开想要截图的网页（小说页、文档页等）
2. 点击扩展图标 📸
3. 设置参数：
   - **滚动延迟**：默认 800ms（页面加载慢可调大）
   - **滚动步长**：默认 800px（视口高度可调整）
4. 点击「**开始截图**」
5. 等待自动滚动截图完成
6. 弹出保存对话框，选择保存位置

## 📂 项目结构

```
extension/
├── manifest.json      # MV3 配置文件
├── popup.html         # 弹出窗口 UI
├── popup.js           # 弹出窗口逻辑
├── background.js      # 核心截图逻辑（Service Worker）
├── stitch.js          # 图片拼接参考实现
├── scroll.js          # 滚动控制参考实现
├── style.css          # 弹出窗口样式
├── icon16.png         # 16x16 图标
├── icon48.png         # 48x48 图标
└── icon128.png        # 128x128 图标
```

## ⚙️ 技术原理

```
┌─────────────────────────────────────────────┐
│              popup.js (用户界面)              │
│   设置参数 → 发送 start 消息到 background    │
└──────────────────┬──────────────────────────┘
                   │ Message
┌──────────────────▼──────────────────────────┐
│           background.js (Service Worker)      │
│                                             │
│  1. chrome.tabs.captureVisibleTab()        │
│     → 获取当前可视区域截图                   │
│                                             │
│  2. chrome.scripting.executeScript()       │
│     → 注入脚本执行 window.scrollBy()        │
│                                             │
│  3. 循环 1→2 直到页面底部                   │
│                                             │
│  4. OffscreenCanvas 拼接所有截图帧          │
│                                             │
│  5. chrome.downloads.download()            │
│     → 下载最终长截图                         │
└─────────────────────────────────────────────┘
```

## 🔧 技术栈

| 技术 | 用途 |
|------|------|
| `chrome.tabs.captureVisibleTab` | 获取浏览器渲染画面 |
| `chrome.scripting` | 注入滚动控制脚本 |
| `OffscreenCanvas` | Service Worker 内拼接图片 |
| `createImageBitmap` | 加载 base64 图片数据 |
| `chrome.downloads` | 触发文件下载 |

## ⚠️ 注意事项

- **Edge/Chrome 93+** 才能完整支持 `OffscreenCanvas`
- 扩展需要 `<all_urls>` 权限（访问所有网站）
- 长页面截图帧数较多时，拼接可能耗时较长
- 部分网站有滚动保护，可能需要调整滚动步长

## 🛠️ 可选增强（欢迎 PR）

- [ ] 截图帧去重算法（避免重复区域）
- [ ] 进度条实时显示
- [ ] 支持导出 PDF
- [ ] 自定义截图区域（选择起始/结束位置）
- [ ] 快捷键支持

## 📜 开源协议

MIT License — 自由使用、修改和分发。

## 🙏 致谢

灵感来源于「浏览器原生截图比 DOM 重建更可靠」的理念 💡

---

**作者**：[Your Name]  
**创建时间**：2026-07-04
