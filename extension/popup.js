// popup.js - 弹出窗口逻辑 (v3.0)
let isCapturing = false;
let port = null;
let totalFrames = 0;

document.getElementById('startBtn').addEventListener('click', startCapture);
document.getElementById('stopBtn').addEventListener('click', stopCapture);

function startCapture() {
  const scrollDelay = parseInt(document.getElementById('scrollDelay').value) || 800;

  isCapturing = true;
  updateUI();

  // 连接 background 并发送开始消息
  const p = chrome.runtime.connect({ name: 'popup' });
  p.postMessage({ action: 'start', scrollDelay });

  // 监听这个连接的消息
  p.onMessage.addListener((msg) => handleMsg(msg));

  // 如果 port 断开，重新连接监听全局消息
  p.onDisconnect.addListener(() => {
    port = null;
  });
}

function stopCapture() {
  isCapturing = false;
  updateUI();
  chrome.runtime.connect({ name: 'popup' }).postMessage({ action: 'stop' });
}

function updateUI() {
  document.getElementById('startBtn').disabled = isCapturing;
  document.getElementById('stopBtn').disabled = !isCapturing;
}

// 处理来自 background 的消息
function handleMsg(msg) {
  if (msg.action === 'update') {
    // 显示帧数
    document.getElementById('frameCount').textContent =
      `已捕获帧数: ${msg.frameCount} / ${msg.totalFrames ?? '--'}`;

    // 显示状态文字
    if (msg.status) {
      document.getElementById('statusText').textContent = msg.status;
    }

    // 显示页面信息（首次收到时）
    if (msg.totalFrames && msg.scrollHeight) {
      showPageInfo(msg);
    }

    // 更新进度条
    if (msg.totalFrames && msg.totalFrames > 0) {
      const pct = Math.min(100, Math.round((msg.frameCount / msg.totalFrames) * 100));
      document.getElementById('progressFill').style.width = `${pct}%`;
    }

  } else if (msg.action === 'complete') {
    isCapturing = false;
    updateUI();
    document.getElementById('statusText').textContent = `截图完成! 共 ${msg.totalFrames} 帧`;
    document.getElementById('frameCount').textContent = `已捕获帧数: ${msg.totalFrames} / ${msg.totalFrames}`;
    document.getElementById('progressFill').style.width = '100%';

  } else if (msg.action === 'error') {
    isCapturing = false;
    updateUI();
    document.getElementById('statusText').textContent = `错误: ${msg.error}`;
  }
}

// 显示页面测高信息
function showPageInfo(info) {
  const el = document.getElementById('pageInfo');
  document.getElementById('infoHeight').textContent = info.scrollHeight || '--';
  document.getElementById('infoFrames').textContent = info.totalFrames || '--';
  el.classList.remove('hidden');
}

// 全局消息监听（备用）
chrome.runtime.onConnect.addListener((p) => {
  if (p.name !== 'popup') return;
  port = p;
  p.onMessage.addListener((msg) => handleMsg(msg));
});
