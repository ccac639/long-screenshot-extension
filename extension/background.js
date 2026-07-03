// background.js - MV3 长截图（v2.1 稳定版）
// 核心修复：兼容 SPA/自定义滚动容器 + 强制滚动检测 + 最大帧保护

let frames = [];
let running = false;
let delay = 800;
let step = 800;
let ports = [];
let lastImagePrefix = '';
const MAX_FRAMES = 100; // 安全上限

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  ports.push(port);
  port.onMessage.addListener((msg) => {
    if (msg.action === 'start') start(msg.scrollDelay, msg.scrollStep);
    if (msg.action === 'stop')  stop();
  });
  port.onDisconnect.addListener(() => {
    const i = ports.indexOf(port);
    if (i > -1) ports.splice(i, 1);
  });
});

async function start(d, s) {
  delay = d || 800;
  step = s || 800;
  running = true;
  frames = [];
  lastImagePrefix = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    send('update', { frameCount: 0 });

    // 等待字体加载完成
    await waitForFonts(tab.id);

    await loop(tab);
  } catch (e) {
    send('error', { error: e.message });
  } finally {
    running = false;
  }
}

async function loop(tab) {
  // 第1帧：截图当前视口（顶部）
  let url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  frames.push(url);
  lastImagePrefix = url.slice(0, 2000);
  send('update', { frameCount: frames.length, status: `已截 ${frames.length} 帧...` });

  let duplicateCount = 0;

  for (let i = 1; i < MAX_FRAMES && running; i++) {
    try {
      // 滚动页面（智能查找滚动容器）
      const scrollResult = await smartScrollDown(tab.id);

      if (!scrollResult.didMove) {
        // 页面没有移动 → 可能到底了
        duplicateCount++;
        console.log(`[loop] 滚动未生效 (${duplicateCount}次)，可能到达底部`);
        if (duplicateCount >= 3) break;
      } else {
        duplicateCount = 0;
      }

      // 等待渲染稳定
      await sleep(delay);

      // 截图当前帧
      url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

      // 轻量去重
      if (!isDuplicate(url)) {
        frames.push(url);
        lastImagePrefix = url.slice(0, 2000);
        duplicateCount = 0;
        send('update', { frameCount: frames.length, status: `已截 ${frames.length} 帧...` });
        console.log(`[loop] 第 ${i+1} 帧 ✓ (共 ${frames.length} 帧)`);
      } else {
        duplicateCount++;
        console.log(`[loop] 重复帧 (${duplicateCount}/3)`);
        if (duplicateCount >= 3) break;
      }

      // 底部双重确认
      if (scrollResult.atBottom) {
        await sleep(200);
        const recheck = await checkAtBottom(tab.id);
        if (recheck) break;
      }

    } catch (e) {
      console.error('[loop] error:', e);
      break;
    }
  }

  console.log(`[loop] 完成，共截取 ${frames.length} 帧`);
  if (frames.length > 0) await save();
  send('complete', { totalFrames: frames.length });
}

/**
 * 智能滚动：自动找到页面的真实滚动容器并执行滚动
 * 兼容：window 滚动 / documentElement 滚动 / body 滚动 / 自定义 overflow 容器
 */
async function smartScrollDown(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: (stepSize) => {
      const beforeTop = getScrollTop();

      // 尝试多种方式滚动
      window.scrollBy(0, stepSize);
      document.documentElement.scrollTop += stepSize;
      document.body.scrollTop += stepSize;

      // 尝试找到最大的 overflow 容器并滚动它
      tryFindAndScrollContainer(stepSize);

      const afterTop = getScrollTop();
      return {
        didMove: beforeTop !== afterTop,
        beforeTop: beforeTop,
        afterTop: afterTop,
        atBottom: isAtBottom(),
      };

      function getScrollTop() {
        return Math.max(
          window.pageYOffset || 0,
          document.documentElement.scrollTop || 0,
          document.body.scrollTop || 0,
          0
        );
      }

      function isAtBottom() {
        const st = getScrollTop();
        const ch = window.innerHeight;
        const sh = Math.max(
          document.body.scrollHeight || 0,
          document.documentElement.scrollHeight || 0,
          ch
        );
        return st + ch >= sh - 10;
      }

      function tryFindAndScrollContainer(size) {
        // 遍历所有可能的滚动容器
        const candidates = [];
        const allElements = document.querySelectorAll('*');
        
        for (const el of allElements) {
          const style = getComputedStyle(el);
          if ((style.overflow === 'auto' || style.overflow === 'scroll' ||
               style.overflowY === 'auto' || style.overflowY === 'scroll')) {
            if (el.scrollHeight > el.clientHeight + 5) {
              candidates.push(el);
            }
          }
        }

        // 找到最大的滚动容器（通常是主内容区）
        if (candidates.length > 0) {
          candidates.sort((a, b) => b.scrollHeight - a.scrollHeight);
          candidates[0].scrollTop += size;
        }
      }
    },
    args: [step],
  });

  return result;
}

async function waitForFonts(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: async () => {
        if (document.fonts && document.fonts.ready) {
          await document.fonts.ready;
        }
      },
    });
  } catch (_) {}
}

async function checkAtBottom(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: () => {
      const st = Math.max(
        window.pageYOffset || 0,
        document.documentElement.scrollTop || 0,
        document.body.scrollTop || 0
      );
      const ch = window.innerHeight;
      const sh = Math.max(
        document.body.scrollHeight || 0,
        document.documentElement.scrollHeight || 0,
        ch
      );
      return st + ch >= sh - 10;
    },
  });
  return result;
}

function isDuplicate(imgDataUrl) {
  if (!lastImagePrefix) return false;
  return imgDataUrl.slice(0, 2000) === lastImagePrefix;
}

function stop() { running = false; }

async function save() {
  try {
    const url = await stitch(frames);
    await new Promise((ok, fail) => {
      chrome.downloads.download(
        { url: url, filename: 'long_screenshot.png', saveAs: true },
        (id) => {
          if (chrome.runtime.lastError) fail(chrome.runtime.lastError);
          else ok(id);
        }
      );
    });
  } catch (e) {
    console.error('save err:', e);
    send('error', { error: e.message });
  }
}

async function stitch(list) {
  const imgs = await Promise.all(list.map(load));
  let h = 0, w = 0;
  for (const im of imgs) { h += im.height; w = Math.max(w, im.width); }
  const cv = new OffscreenCanvas(w, h);
  const cx = cv.getContext('2d');
  let y = 0;
  for (const im of imgs) { cx.drawImage(im, 0, y); y += im.height; }
  const bl = await cv.convertToBlob({ type: 'image/png' });
  return new Promise((ok, fail) => {
    const rd = new FileReader();
    rd.onloadend = () => ok(rd.result);
    rd.onerror = () => fail(rd.error);
    rd.readAsDataURL(bl);
  });
}

function load(url) {
  return fetch(url).then(r => r.blob()).then(b => createImageBitmap(b));
}

function send(act, dat) {
  ports.forEach(p => {
    try { p.postMessage({ action: act, ...dat }); } catch (_) {}
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
