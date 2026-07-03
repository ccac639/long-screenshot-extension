// popup.js - 弹出窗口逻辑 (v5.0 多章采集版，删除单章模式)
let isCapturing = false;
let port = null;
let detectedNovelName = '';   // 自动获取的小说名

// ===== DOM 元素 =====
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const novelNameDisplay = document.getElementById('novelNameDisplay');

// ===== 页面加载时自动检测小说名 =====
window.addEventListener('DOMContentLoaded', () => {
  autoDetectNovelName();
});

/**
 * 自动检测小说名称（从当前页面）
 */
async function autoDetectNovelName() {
  novelNameDisplay.textContent = '正在识别...';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const p = chrome.runtime.connect({ name: 'popup' });
    p.onMessage.addListener(function handler(msg) {
      if (msg.action === 'novelNameDetected') {
        detectedNovelName = msg.novelName;
        novelNameDisplay.textContent = msg.novelName;
        p.onMessage.removeListener(handler);
        p.disconnect();
      }
    });
    p.postMessage({ action: 'detectNovelName', tabId: tab.id });
  } catch (e) {
    novelNameDisplay.textContent = '识别失败，将使用默认名';
    detectedNovelName = '';
  }
}

// ===== 按钮事件 =====
startBtn.addEventListener('click', startCapture);
stopBtn.addEventListener('click', stopCapture);

// ===== 开始采集 =====
function startCapture() {
  if (!detectedNovelName) {
    alert('正在识别小说名称，请稍候...');
    return;
  }

  const scrollDelay = parseInt(document.getElementById('scrollDelay').value) || 800;
  const chapterDelay = parseInt(document.getElementById('chapterDelay').value) || 1500;

  let params = {
    action: 'start',
    scrollDelay: scrollDelay,
    chapterDelay: chapterDelay,
  };

  // 获取采集模式
  const collectModeEl = document.querySelector('input[name="collectMode"]:checked');
  params.collectMode = collectModeEl ? collectModeEl.value : '10';

  // 自定义数量（优先级最高）
  const customCount = parseInt(document.getElementById('customCount').value);
  if (customCount && customCount > 0) {
    params.chapterCount = customCount;
  } else {
    const modeMap = { '10': 10, '30': 30, 'all': 9999 };
    params.chapterCount = modeMap[params.collectMode] || 10;
  }

  // 清空日志
  const logArea = document.getElementById('logArea');
  logArea.innerHTML = '';
  logArea.classList.remove('hidden');

  // 显示章节进度区
  document.getElementById('chapterInfo').classList.remove('hidden');
  document.getElementById('totalChapters').textContent = params.chapterCount >= 9999 ? '?' : params.chapterCount;

  isCapturing = true;
  updateUI();

  // 连接 background 并发送参数
  port = chrome.runtime.connect({ name: 'popup' });
  port.postMessage(params);
  port.onMessage.addListener((msg) => handleMsg(msg));
  port.onDisconnect.addListener(() => { port = null; });
}

// ===== 停止采集 =====
function stopCapture() {
  isCapturing = false;
  updateUI();
  addLog('⛔ 用户手动停止', 'error');
  chrome.runtime.connect({ name: 'popup' }).postMessage({ action: 'stop' });
}

// ===== UI 更新 =====
function updateUI() {
  startBtn.disabled = isCapturing;
  stopBtn.disabled = !isCapturing;
}

// ===== 消息处理 =====
function handleMsg(msg) {
  switch (msg.action) {

    case 'update':
      // 章节信息
      if (msg.currentChapter !== undefined) {
        document.getElementById('currentChapter').textContent = msg.currentChapter;
      }
      // 帧进度
      if (msg.frameCount !== undefined) {
        const total = msg.totalFrames ?? '--';
        document.getElementById('frameCount').textContent =
          `已捕获: ${msg.frameCount} 帧${total !== '--' ? ` / ${total}` : ''}`;
      }
      if (msg.status) {
        document.getElementById('statusText').textContent = msg.status;
      }
      // 进度条
      if (msg.totalFrames && msg.frameCount && msg.totalFrames > 0) {
        const pct = Math.min(100, Math.round((msg.frameCount / msg.totalFrames) * 100));
        document.getElementById('progressFill').style.width = `${pct}%`;
      }
      break;

    case 'chapterStart':
      addLog(`📖 开始第 ${msg.chapter} 章: ${msg.title || ''}`, 'info');
      document.getElementById('progressFill').style.width = '0%';
      document.getElementById('frameCount').textContent = '已捕获: 0 帧';
      break;

    case 'chapterDone':
      addLog(`✅ 第 ${msg.chapter} 章完成 → ${msg.filename}`, 'success');
      if (msg.currentChapter && msg.totalChapters) {
        const pct = Math.min(100, Math.round((msg.currentChapter / msg.totalChapters) * 100));
        document.getElementById('chapterFill').style.width = `${pct}%`;
        document.getElementById('currentChapter').textContent = msg.currentChapter + 1;
      }
      break;

    case 'complete':
      isCapturing = false;
      updateUI();
      const totalMsg = `采集完成! 共 ${msg.totalChapters} 章, ${msg.totalFrames} 帧`;
      document.getElementById('statusText').textContent = totalMsg;
      document.getElementById('progressFill').style.width = '100%';
      document.getElementById('chapterFill').style.width = '100%';
      addLog(`🎉 ${totalMsg}`, 'success');
      break;

    case 'error':
      isCapturing = false;
      updateUI();
      document.getElementById('statusText').textContent = `错误: ${msg.error}`;
      addLog(`❌ 错误: ${msg.error}`, 'error');
      break;

    case 'log':
      addLog(msg.text, msg.type || 'info');
      break;
  }
}

// ===== 辅助函数 =====
function addLog(text, type) {
  const logArea = document.getElementById('logArea');
  if (!logArea) return;
  const line = document.createElement('div');
  line.className = type ? `log-${type}` : '';
  line.textContent = text;
  logArea.appendChild(line);
  logArea.scrollTop = logArea.scrollHeight;
}

// 全局消息监听（备用）
chrome.runtime.onConnect.addListener((p) => {
  if (p.name !== 'popup') return;
  port = p;
  p.onMessage.addListener((msg) => handleMsg(msg));
});
