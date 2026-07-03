// background.js - MV3 长截图（v2 轻量稳定版）
// 优化点：字体渲染锁 + 滚动稳定检测 + 去重 + 节奏控制

let frames = [];
let running = false;
let delay = 800;
let step = 800;
let ports = [];
let lastImagePrefix = ''; // 用于去重

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
    
    // 首次截图前，等待字体加载完成
    await waitForFonts(tab.id);
    
    await loop(tab);
  } catch (e) {
    send('error', { error: e.message });
  } finally {
    running = false;
  }
}

async function loop(tab) {
  // 先截图第一帧：当前视口（页面顶部）
  const firstUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  frames.push(firstUrl);
  lastImagePrefix = firstUrl.slice(0, 2000);
  send('update', { frameCount: frames.length });

  // 检查页面是否已经可以滚动了（只有一屏的情况）
  let canScroll = await canPageScroll(tab.id);
  
  if (canScroll) {
    // 循环：滚动 → 稳定 → 截图 → 检查底部
    while (running) {
      try {
        // 1. 滚动页面
        await scrollDown(tab.id);

        // 2. 等待滚动稳定
        await waitForScrollStable(tab.id);

        // 3. 额外等待渲染完成
        await sleep(150);

        // 4. 截图
        const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

        // 5. 去重检测
        if (!isDuplicate(url)) {
          frames.push(url);
          lastImagePrefix = url.slice(0, 2000);
          send('update', { frameCount: frames.length });
        } else {
          console.log('跳过重复帧');
          // 连续重复帧说明到底了
          break;
        }

        // 6. 判断是否在底部（连续3次确认）
        if (await checkAtBottom(tab.id)) {
          // 再多等一帧确认
          await sleep(200);
          if (await checkAtBottom(tab.id)) {
            console.log('已到达底部');
            break;
          }
        }
      } catch (e) {
        console.error('loop err:', e);
        break;
      }
    }
  }

  if (frames.length > 0) await save();
  send('complete', { totalFrames: frames.length });
}

// 滚动页面
async function scrollDown(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: (st) => {
      window.scrollBy(0, st);
    },
    args: [step],
  });
}

// 等待滚动稳定（使用 requestAnimationFrame 检测 scrollTop 是否不再变化）
async function waitForScrollStable(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: () => {
      return new Promise(resolve => {
        let lastTop = -1;
        let stableCount = 0;
        
        const check = () => {
          const currentTop = document.documentElement.scrollTop || document.body.scrollTop;
          
          if (currentTop === lastTop) {
            stableCount++;
          } else {
            stableCount = 0;
          }
          
          lastTop = currentTop;
          
          if (stableCount >= 3) {
            resolve();
          } else {
            requestAnimationFrame(check);
          }
        };
        
        check();
      });
    },
  });
}

// 等待字体加载完成
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
  } catch (e) {
    console.warn('字体等待失败，继续截图:', e);
  }
}

// 检查页面是否可以滚动（是否有多于一屏的内容）
async function canPageScroll(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: () => {
      const scrollHeight = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight
      );
      return window.innerHeight < scrollHeight - 5;
    },
  });
  return result;
}

// 检查是否到达底部
async function checkAtBottom(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: () => {
      const el = document.documentElement;
      const scrollTop = el.scrollTop || document.body.scrollTop;
      const clientHeight = window.innerHeight;
      const scrollHeight = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight
      );
      
      return scrollTop + clientHeight >= scrollHeight - 5;
    },
  });
  
  return result;
}

// 去重检测（比较 base64 前缀）
function isDuplicate(imgDataUrl) {
  if (!lastImagePrefix) return false;
  
  const prefix = imgDataUrl.slice(0, 2000);
  return prefix === lastImagePrefix;
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
