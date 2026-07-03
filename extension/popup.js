// popup.js - 弹出窗口逻辑 (v4.1 多章采集版)
let isCapturing = false;
let port = null;
let currentMode = 'single';
let detectedNovelName = '';   // 自动获取的小说名

// ===== DOM 元素 =====
const modeSingleBtn = document.getElementById('modeSingle');
const modeMultiBtn = document.getElementById('modeMulti');
const multiSettings = document.getElementById('multiSettings');
const novelNameDisplay = document.getElementById('novelNameDisplay');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');

// ===== 模式切换 =====
modeSingleBtn.addEventListener('click', () => {
  currentMode = 'single';
  modeSingleBtn.classList.add('active');
  modeMultiBtn.classList.remove('active');
  multiSettings.classList.add('hidden');
  singleSettings.classList.remove('hidden');
});

modeMultiBtn.addEventListener('click', async () => {
  currentMode = 'multi';
  modeMultiBtn.classList.add('active');
  modeSingleBtn.classList.remove('active');
  multiSettings.classList.remove('hidden');
  singleSettings.classList.add('hidden');

  // 切换到多章模式时，自动获取小说名
  await autoDetectNovelName();
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

// ===== 开始截图 =====
function startCapture() {
  // 收集参数
  const scrollDelay = parseInt(document.getElementById('scrollDelay').value) || 800;
  const chapterDelay = parseInt(document.getElementById('chapterDelay').value) || 1500;

  let params = {
    action: 'start',
    mode: currentMode,
    scrollDelay: scrollDelay,
    chapterDelay: chapterDelay,
  };

  // 多章模式额外参数
  if (currentMode === 'multi') {
    // 使用自动获取的小说名
    if (!detectedNovelName) {
      alert('正在识别小说名称，请稍候...');
      return;
    }
    params.novelName = detectedNovelName;

    // 获取采集模式
    const collectModeEl = document.querySelector('input[name="collectMode"]:checked');
    params.collectMode = collectModeEl ? collectModeEl.value : '10';

    // 自定义数量（优先级最高）
    const customCount = parseInt(document.getElementById('customCount').value);
    if (customCount && customCount > 0) {
      params.chapterCount = customCount;
    } else {
      // 根据模式映射
      const modeMap = { '10': 10, '30': 30, 'all': 9999 };
      params.chapterCount = modeMap[params.collectMode] || 10;
    }

    // 清空日志
    const logArea = document.getElementById('logArea');
    logArea.innerHTML = '';
    logArea.classList.remove('hidden');

    // 显示多章进度区
    document.getElementById('chapterInfo').classList.remove('hidden');
    document.getElementById('totalChapters').textContent = params.chapterCount >= 9999 ? '?' : params.chapterCount;
  } else {
    document.getElementById('chapterInfo').classList.add('hidden');
  }

  isCapturing = true;
  updateUI();

  // 连接 background
  const p = chrome.runtime.connect({ name: 'popup' });
  p.postMessage(params);
  p.onMessage.addListener((msg) => handleMsg(msg));
  p.onDisconnect.addListener(() => { port = null; });
}

// ===== 停止截图 =====
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
      // 单章帧进度
      if (msg.frameCount !== undefined) {
        const total = msg.totalFrames ?? '--';
        document.getElementById('frameCount').textContent =
          `已捕获: ${msg.frameCount} 帧${total !== '--' ? ` / ${total}` : ''}`;
      }
      // 状态文字
      if (msg.status) {
        document.getElementById('statusText').textContent = msg.status;
      }
      // 页面信息
      if (msg.totalFrames && msg.scrollHeight) {
        showPageInfo(msg);
      }
      // 进度条
      if (msg.totalFrames && msg.frameCount && msg.totalFrames > 0) {
        const pct = Math.min(100, Math.round((msg.frameCount / msg.totalFrames) * 100));
        document.getElementById('progressFill').style.width = `${pct}%`;
      }
      // 多章：当前章节
      if (msg.currentChapter !== undefined) {
        document.getElementById('currentChapter').textContent = msg.currentChapter;
      }
      break;

    case 'chapterStart':
      addLog(`📖 开始第 ${msg.chapter} 章: ${msg.title || ''}`, 'info');
      // 重置单章进度条
      document.getElementById('progressFill').style.width = '0%';
      document.getElementById('frameCount').textContent = '已捕获: 0 帧';
      break;

    case 'chapterDone':
      addLog(`✅ 第 ${msg.chapter} 章完成 → ${msg.filename}`, 'success');
      // 更新章节进度条
      if (msg.currentChapter && msg.totalChapters) {
        const pct = Math.min(100, Math.round((msg.currentChapter / msg.totalChapters) * 100));
        document.getElementById('chapterFill').style.width = `${pct}%`;
        document.getElementById('currentChapter').textContent = msg.currentChapter + 1; // 下一个
      }
      break;

    case 'complete':
      isCapturing = false;
      updateUI();
      const totalMsg = msg.mode === 'multi'
        ? `采集完成! 共 ${msg.totalChapters} 章, ${msg.totalFrames} 帧`
        : `截图完成! 共 ${msg.totalFrames} 帧`;
      document.getElementById('statusText').textContent = totalMsg;
      document.getElementById('progressFill').style.width = '100%';
      if (msg.mode === 'multi') {
        document.getElementById('chapterFill').style.width = '100%';
      }
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

    case 'novelNameDetected':
      // 由 autoDetectNovelName 中的 listener 处理
      break;
  }
}

// ===== 辅助函数 =====
function showPageInfo(info) {
  const el = document.getElementById('pageInfo');
  document.getElementById('infoHeight').textContent = info.scrollHeight || '--';
  document.getElementById('infoFrames').textContent = info.totalFrames || '--';
  el.classList.remove('hidden');
}

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
