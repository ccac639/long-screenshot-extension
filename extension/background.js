// background.js - MV3 长截图（正确版 vFinal）
// Chrome API 已核对：tabs / scripting / downloads / runtime

let frames = [];
let running = false;
let delay = 800;
let step = 800;
let ports = [];

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
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    send('update', { frameCount: 0 });
    await loop(tab);
  } catch (e) {
    send('error', { error: e.message });
  } finally {
    running = false;
  }
}

async function loop(tab) {
  let stable = 0;
  while (running) {
    try {
      const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      frames.push(url);
      send('update', { frameCount: frames.length });

      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (st) => {
          const a = window.pageYOffset ?? document.documentElement.scrollTop;
          window.scrollBy(0, st);
          const b = window.pageYOffset ?? document.documentElement.scrollTop;
          return {
            top: b,
            max: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) - window.innerHeight,
            ok: a !== b,
          };
        },
        args: [step],
      });

      if (!result.ok || result.top >= result.max - 5) {
        stable++;
        if (stable >= 2) break;
      } else {
        stable = 0;
      }

      await sleep(delay);
    } catch (e) {
      console.error('loop err:', e);
      break;
    }
  }
  if (frames.length > 0) await save();
  send('complete', { totalFrames: frames.length });
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
