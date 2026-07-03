// popup.js - 弹出窗口逻辑
let isCapturing = false;
let port = null;

document.getElementById('startBtn').addEventListener('click', startCapture);
document.getElementById('stopBtn').addEventListener('click', stopCapture);

function startCapture() {
  const scrollDelay = parseInt(document.getElementById('scrollDelay').value);
  const scrollStep = parseInt(document.getElementById('scrollStep').value);

  isCapturing = true;
  updateUI();

  chrome.runtime.connect({ name: 'popup' }).postMessage({
    action: 'start',
    scrollDelay,
    scrollStep
  });
}

function stopCapture() {
  isCapturing = false;
  updateUI();

  chrome.runtime.connect({ name: 'popup' }).postMessage({
    action: 'stop'
  });
}

function updateUI() {
  document.getElementById('startBtn').disabled = isCapturing;
  document.getElementById('stopBtn').disabled = !isCapturing;
  document.getElementById('statusText').textContent = isCapturing ? '截图中...' : '就绪';
}

// 监听来自 background 的消息
chrome.runtime.onConnect.addListener((p) => {
  port = p;
  port.onMessage.addListener((msg) => {
    if (msg.action === 'update') {
      document.getElementById('frameCount').textContent = `已捕获帧数: ${msg.frameCount}`;
      if (msg.progress) {
        document.getElementById('progressFill').style.width = `${msg.progress}%`;
      }
    } else if (msg.action === 'complete') {
      isCapturing = false;
      updateUI();
      document.getElementById('statusText').textContent = '截图完成!';
      document.getElementById('frameCount').textContent = `已捕获帧数: ${msg.totalFrames}`;
    } else if (msg.action === 'error') {
      isCapturing = false;
      updateUI();
      document.getElementById('statusText').textContent = `错误: ${msg.error}`;
    }
  });
});
