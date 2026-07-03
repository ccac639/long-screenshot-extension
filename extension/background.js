// background.js - MV3 长截图（v3.0 自动测高版）
// 核心逻辑：自动获取页面总高度 → 计算帧数 → 固定次数循环 → 滚动到底

let frames = [];
let running = false;
let delay = 800;
let ports = [];
const MAX_FRAMES = 200; // 安全上限

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  ports.push(port);
  port.onMessage.addListener((msg) => {
    if (msg.action === 'start') start(msg.scrollDelay);
    if (msg.action === 'stop')  stop();
  });
  port.onDisconnect.addListener(() => {
    const i = ports.indexOf(port);
    if (i > -1) ports.splice(i, 1);
  });
});

async function start(d) {
  delay = d || 800;
  running = true;
  frames = [];
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    send('update', { frameCount: 0, status: '正在测量页面高度...' });

    // 等待字体加载完成
    await waitForFonts(tab.id);

    // 获取页面信息：总高度、视口高度、自动计算帧数
    const pageInfo = await getPageInfo(tab.id);
    if (!pageInfo.canScroll) {
      send('update', { frameCount: 0, status: '单屏页面，直接截图' });
    } else {
      send('update', {
        frameCount: 0,
        status: `页面总高 ${pageInfo.scrollHeight}px，视口 ${pageInfo.viewportH}px，预计 ${pageInfo.totalFrames} 帧`,
        totalFrames: pageInfo.totalFrames,
        scrollHeight: pageInfo.scrollHeight,
      });
    }

    await loop(tab, pageInfo);

  } catch (e) {
    send('error', { error: e.message });
  } finally {
    running = false;
  }
}

async function loop(tab, pageInfo) {
  // 第1帧：当前视口（顶部）
  let url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  frames.push(url);
  send('update', {
    frameCount: frames.length,
    status: `已截 ${frames.length}/${pageInfo.totalFrames} 帧...`,
    totalFrames: pageInfo.totalFrames,
  });

  // 如果只有一屏，直接保存
  if (!pageInfo.canScroll) {
    console.log('[loop] 单屏页面，只保存1帧');
    if (frames.length > 0) await save();
    send('complete', { totalFrames: frames.length });
    return;
  }

  // 固定循环：totalFrames-1 次（第1帧已截）
  const loopCount = Math.min(pageInfo.totalFrames - 1, MAX_FRAMES - 1);

  for (let i = 0; i < loopCount && running; i++) {
    try {
      // 滚动一整个视口高度
      await scrollByViewport(tab.id, pageInfo.viewportH);

      // 等待渲染稳定
      await sleep(delay);

      // 截图
      url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      frames.push(url);

      send('update', {
        frameCount: frames.length,
        status: `已截 ${frames.length}/${pageInfo.totalFrames} 帧 (${Math.round(frames.length / pageInfo.totalFrames * 100)}%)`,
        totalFrames: pageInfo.totalFrames,
      });

      console.log(`[loop] 第 ${i + 2}/${pageInfo.totalFrames} 帧 ✓`);

    } catch (e) {
      console.error('[loop] error:', e);
      break;
    }
  }

  console.log(`[loop] 完成！共截取 ${frames.length} 帧`);
  if (frames.length > 0) await save();
  send('complete', { totalFrames: frames.length });
}

/**
 * 获取页面信息：总高度、视口高度、是否可滚动、预计帧数
 */
async function getPageInfo(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: () => {
      const viewportH = window.innerHeight;

      // 获取最大可滚动高度（兼容多种容器）
      const bodySH = document.body ? document.body.scrollHeight : 0;
      const docSH = document.documentElement ? document.documentElement.scrollHeight : 0;
      let scrollHeight = Math.max(bodySH, docSH, viewportH);

      // 尝试找最大的 overflow 容器
      let containerEl = null;
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        try {
          const style = getComputedStyle(el);
          if ((style.overflow === 'auto' || style.overflow === 'scroll' ||
               style.overflowY === 'auto' || style.overflowY === 'scroll')) {
            if (el.scrollHeight > el.clientHeight + 5 && el.scrollHeight > scrollHeight) {
              scrollHeight = el.scrollHeight;
              containerEl = el;
            }
          }
        } catch (_) {}
      }

      const canScroll = scrollHeight > viewportH + 10;
      const totalFrames = canScroll ? Math.ceil(scrollHeight / viewportH) : 1;

      return {
        scrollHeight: scrollHeight,
        viewportH: viewportH,
        canScroll: canScroll,
        totalFrames: totalFrames,
        hasCustomContainer: !!containerEl,
      };
    },
  });

  return result;
}

/**
 * 滚动一个视口高度的量（兼容多种滚动容器）
 */
async function scrollByViewport(tabId, amount) {
  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: (stepSize) => {
      // 方式1: window.scrollBy
      window.scrollBy(0, stepSize);

      // 方式2: scrollTop 直接赋值
      if (document.documentElement) {
        document.documentElement.scrollTop += stepSize;
      }
      if (document.body) {
        document.body.scrollTop += stepSize;
      }

      // 方式3: 找 overflow 容器并滚动
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        try {
          const style = getComputedStyle(el);
          if ((style.overflow === 'auto' || style.overflow === 'scroll' ||
               style.overflowY === 'auto' || style.overflowY === 'scroll')) {
            if (el.scrollHeight > el.clientHeight + 10) {
              el.scrollTop += stepSize;
            }
          }
        } catch (_) {}
      }
    },
    args: [amount],
  });
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
