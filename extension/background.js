// background.js - MV3 长截图采集 v6.3（彻底修复跳章+0帧+scrollHeight报错）
// 功能：多章采集 / 自动翻页 / 文件夹保存 / 自动识别小说名

let frames = [];
let running = false;
let delay = 800;
let ports = [];
const MAX_FRAMES = 200;
let offscreenReady = false;

// 多章模式状态
let multiMode = true;
let novelName = '';
let totalChapters = 1;
let currentChapterNum = 1;

// ============================================================
// 章节锁（彻底修复跳章）
// ============================================================
let lastChapterKey = '';
let isSwitchingChapter = false;

// ============================================================
// 帧去重
// ============================================================
let lastFrameDataUrl = '';

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  ports.push(port);
  port.onMessage.addListener((msg) => {
    if (msg.action === 'start') {
      startMultiCapture(msg);
    }
    if (msg.action === 'stop') stop();
    if (msg.action === 'detectNovelName') {
      handleDetectNovelName(msg, port);
    }
  });
  port.onDisconnect.addListener(() => {
    const i = ports.indexOf(port);
    if (i > -1) ports.splice(i, 1);
  });
});

// ============================================================
// 多章采集主循环
// ============================================================

async function startMultiCapture(params) {
  delay = params.scrollDelay || 800;
  const chapterDelay = params.chapterDelay || 2000; // 加长到 2s，等页面稳定
  totalChapters = params.chapterCount || 10;
  currentChapterNum = 1;
  running = true;
  multiMode = true;
  let totalFrameCount = 0;

  send('log', { text: '🔍 正在自动识别小说名称...', type: 'info' });
  novelName = await detectNovelName((await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
  send('log', { text: `📚 小说名称: ${novelName}`, type: 'success' });
  send('log', { text: `⚙️ 滚动延迟: ${delay}ms | 章节间隔: ${chapterDelay}ms`, type: 'info' });

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    send('update', { totalChapters: totalChapters >= 9999 ? '?' : totalChapters });

    for (let ch = 1; ch <= totalChapters && running; ch++) {
      currentChapterNum = ch;

      const pageTitle = await getPageTitle(tab.id);
      send('chapterStart', { chapter: ch, title: pageTitle || `第${ch}章` });
      send('update', { currentChapter: ch });

      const currentUrl = await getCurrentUrl(tab.id);
      send('log', { text: `📍 第${ch}章 开始 | URL: ${currentUrl}`, type: 'info' });

      try {
        // 等待页面稳定
        await waitForStable(tab.id);

        // 测量当前章（带容错）
        const pageInfo = await getPageInfo(tab.id);
        if (!pageInfo) {
          send('log', { text: `⚠️ 第${ch}章 无法获取页面信息，跳过`, type: 'warn' });
          continue;
        }

        send('update', {
          frameCount: 0,
          status: `第${ch}章 | 高度:${pageInfo.scrollHeight}px 预计:${pageInfo.totalFrames}帧`,
          totalFrames: pageInfo.totalFrames,
          scrollHeight: pageInfo.scrollHeight,
        });

        // 截取当前章
        const capturedFrames = await captureChapter(tab, pageInfo, ch);

        // 保存（只要有帧就保存）
        if (capturedFrames.length > 0) {
          const safeName = sanitizeFilename(novelName);
          const chTitle = await getPageTitle(tab.id) || `${ch}`;
          const filename = `${safeName}/第${String(ch).padStart(3, '0')}章_${chTitle}.png`;
          await saveChapter(capturedFrames, filename, ch);
          totalFrameCount += capturedFrames.length;

          send('chapterDone', {
            chapter: ch,
            filename: filename,
            currentChapter: ch,
            totalChapters: totalChapters >= 9999 ? '?' : totalChapters,
          });
        } else {
          send('log', { text: `⚠️ 第${ch}章 0帧（页面可能无内容）`, type: 'warn' });
        }

      } catch (chErr) {
        send('log', { text: `❌ 第${ch}章出错: ${chErr.message}`, type: 'error' });
      }

      // 翻到下一章
      if (ch < totalChapters && running) {
        send('update', {
          currentChapter: ch,
          status: `⏳ 第${ch}章完成，翻到第${ch + 1}章...`,
          frameCount: -1,
        });

        const navigated = await safeNextChapter(tab.id);
        if (!navigated) {
          send('log', { text: `⚠️ 无法翻到下一页（第${ch}章后停止）`, type: 'error' });
          break;
        }

        // 等页面渲染
        await sleep(chapterDelay);

        const titleAfter = await getPageTitle(tab.id);
        send('log', { text: `📍 翻页后标题: ${titleAfter}`, type: 'info' });

        send('update', {
          currentChapter: ch + 1,
          status: `⏳ 准备采集第${ch + 1}章: ${titleAfter || ''}`,
        });
      }
    }

    send('complete', {
      totalChapters: currentChapterNum - 1,
      totalFrames: totalFrameCount,
    });

  } catch (e) {
    send('error', { error: e.message });
  } finally {
    running = false;
    multiMode = false;
  }
}

// ============================================================
// 等待页面稳定（font + DOM）
// ============================================================
async function waitForStable(tabId, timeoutMs) {
  timeoutMs = timeoutMs || 3000;
  const start = Date.now();
  try {
    // 等 font ready
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: async () => {
        if (document.fonts && document.fonts.ready) {
          await document.fonts.ready;
        }
      },
    }).catch(() => {});

    // 等 DOM 稳定（reader-content 出现）
    for (let i = 0; i < 30; i++) {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: () => {
          const el = document.querySelector('.reader-content') || document.querySelector('[class*="reader"]');
          return !!(el && el.innerText && el.innerText.length > 50);
        },
      }).catch(() => [{ result: false }]);
      if (result) break;
      await sleep(100);
      if (Date.now() - start > timeoutMs) break;
    }
  } catch (_) {}
}

// ============================================================
// 获取章节唯一指纹（用于章节锁）
// 用 URL + title + body文本前200字 作为指纹
// ============================================================
async function getChapterKeyFromTab(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        const url = location.href;
        const title = document.querySelector('.muye-reader-title')?.innerText || '';
        // 用 body.innerText 前200字（最可靠，不依赖特定容器）
        const bodyText = (document.body?.innerText || '').slice(0, 200);
        return url + '||' + title + '||' + bodyText;
      },
    });
    return result || '';
  } catch (_) {
    return '';
  }
}

// ============================================================
// 安全翻章（带章节稳定锁，彻底修复跳章）
// 点击后等待章节"稳定"（连续多次指纹不变）
// ============================================================
async function safeNextChapter(tabId) {
  if (isSwitchingChapter) return false;
  isSwitchingChapter = true;

  const beforeKey = await getChapterKeyFromTab(tabId);
  send('log', { text: `🔒 翻章前指纹: ${beforeKey.slice(0, 60)}`, type: 'info' });

  // 点击"下一章"按钮
  let clicked = false;
  try {
    const [{ result: clickResult }] = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        const allButtons = document.querySelectorAll('button, a, [role="button"]');
        let foundBtn = null;

        for (const el of allButtons) {
          const rect = el.getBoundingClientRect();
          if (rect.width < 1 || rect.height < 1) continue; // 跳过不可见元素
          const text = (el.textContent || '').trim();
          if (text === '下一章' && !text.includes('上一')) {
            foundBtn = el;
            break;
          }
          const spans = el.querySelectorAll('span');
          for (const span of spans) {
            if ((span.textContent || '').trim() === '下一章') {
              foundBtn = el;
              break;
            }
          }
          if (foundBtn) break;
        }

        if (foundBtn) {
          // 用 instant 滚动（避免 smooth 触发额外事件）
          foundBtn.scrollIntoView?.({ behavior: 'instant', block: 'center' });
          // 只 click 一次（避免双击）
          foundBtn.click();
          return { success: true, text: (foundBtn.textContent || '').trim().slice(0, 30) };
        }
        return { success: false };
      },
    });

    if (clickResult && clickResult.success) {
      send('log', { text: `🖱️ 已点击按钮: ${clickResult.text}`, type: 'success' });
      clicked = true;
    }
  } catch (e) {
    send('log', { text: `⚠️ 点击按钮失败: ${e.message}`, type: 'warn' });
  }

  if (!clicked) {
    isSwitchingChapter = false;
    return false;
  }

  // 等待章节稳定（连续多次指纹不变 = 稳定）
  // 这能防止 SPA 连续跳章（1→2→3）
  let lastKey = beforeKey;
  let stableCount = 0;
  const REQUIRED_STABLE = 4; // 连续 4 次（~800ms）不变才认为稳定

  for (let i = 0; i < 50; i++) {
    await sleep(200);
    const nowKey = await getChapterKeyFromTab(tabId);

    if (!nowKey) continue;

    if (nowKey !== lastKey) {
      // 章节还在变化，重置计数器
      send('log', { text: `⏳ 章节变化中: ${nowKey.slice(0, 50)}`, type: 'info' });
      lastKey = nowKey;
      stableCount = 0;
      continue;
    }

    // 指纹没变
    if (nowKey !== beforeKey) {
      stableCount++;
      if (stableCount >= REQUIRED_STABLE) {
        lastChapterKey = nowKey;
        send('log', { text: `✅ 章节已稳定: ${nowKey.slice(0, 60)}`, type: 'success' });
        isSwitchingChapter = false;
        return true;
      }
    }
  }

  // 超时：可能已到最后一章（没有下一章）
  send('log', { text: `⚠️ 翻章后未完全稳定（可能已到最后一章）`, type: 'warn' });
  isSwitchingChapter = false;
  return true;
}

// ============================================================
// 截取单个完整章节（带帧去重 + 跳章检测 + 容错）
// ============================================================
async function captureChapter(tab, pageInfo, chapterNum) {
  let chapterFrames = [];
  let duplicateCount = 0;
  const MAX_DUP = 3;

  // 章节锁
  const chapterKeyBefore = await getChapterKeyFromTab(tab.id);
  lastChapterKey = chapterKeyBefore;
  send('log', { text: '🔒 章节锁: ' + chapterKeyBefore.slice(0, 50), type: 'info' });

  // 第1帧
  try {
    let url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    chapterFrames.push(url);
    lastFrameDataUrl = url;
  } catch (e) {
    send('log', { text: '❌ 第1帧捕获失败: ' + e.message, type: 'error' });
    return chapterFrames;
  }

  send('update', { frameCount: 1, status: '第' + chapterNum + '章: 1/' + pageInfo.totalFrames + '帧', totalFrames: pageInfo.totalFrames });

  if (!pageInfo.canScroll) return chapterFrames;

  const stepSize = pageInfo.viewportH - 30;
  send('log', { text: '📏 步长:' + stepSize + 'px | viewport:' + pageInfo.viewportH + 'px', type: 'info' });

  const loopCount = Math.min(pageInfo.totalFrames + 2, MAX_FRAMES);
  let noScrollCount = 0; // 连续多少次滚动没变化
  const MAX_NO_SCROLL = 3; // 连续3次没滚动则停止

  for (let i = 0; i < loopCount && running; i++) {
    try {
      // 检测跳章
      const keyNow = await getChapterKeyFromTab(tab.id);
      if (keyNow && chapterKeyBefore && keyNow !== chapterKeyBefore) {
        send('log', { text: '⚠️ 检测到跳章（截取中），停止', type: 'error' });
        break;
      }

      // 安全滚动（带日志）
      await safeScroll(tab.id, stepSize);

      // 检测是否到底（scrollTop 连续多次不变）
      const scrollTop = await getScrollTop(tab.id);
      if (scrollTop <= 0) {
        // scrollTop=0 可能还没开始滚，或者已经到顶
        // 不判断，继续
      } else if (prevScrollTop >= 0 && scrollTop === prevScrollTop) {
        noScrollCount++;
        if (noScrollCount >= MAX_NO_SCROLL) {
          send('log', { text: '⛔ 滚动停止(scrollTop=' + scrollTop + ' 连续' + MAX_NO_SCROLL + '次不变)，到底了', type: 'info' });
          break;
        }
      } else {
        noScrollCount = 0;
      }
      prevScrollTop = scrollTop;

      // 捕获帧
      let url;
      try {
        url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      } catch (e) {
        send('log', { text: '⚠️ 捕获帧失败: ' + e.message, type: 'warn' });
        continue;
      }

      // 帧去重（比较 dataUrl 长度 + 前缀）
      if (chapterFrames.length > 0) {
        if (isDupFrame(chapterFrames[chapterFrames.length - 1], url)) {
          duplicateCount++;
          if (duplicateCount >= MAX_DUP) {
            send('log', { text: '⛔ 连续' + MAX_DUP + '帧重复，停止', type: 'warn' });
            break;
          }
          continue;
        }
      }
      duplicateCount = 0;
      lastFrameDataUrl = url;

      chapterFrames.push(url);

      send('update', {
        frameCount: chapterFrames.length,
        status: '第' + chapterNum + '章: ' + chapterFrames.length + '/' + pageInfo.totalFrames + '帧',
        totalFrames: pageInfo.totalFrames,
      });

    } catch (e) {
      send('log', { text: '⚠️ 截取循环出错: ' + e.message, type: 'warn' });
      // 不 break，继续尝试下一帧
    }
  }

  send('log', { text: '✅ 第' + chapterNum + '章完成: ' + chapterFrames.length + '帧', type: 'success' });
  return chapterFrames;
}

// ============================================================
// 安全滚动（容错，不抛异常）
// 增加调试日志：显示找到了哪个容器、滚动是否生效
// ============================================================
async function safeScroll(tabId, stepSize) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: (step) => {
        // 找滚动容器（按优先级）
        const candidates = [
          document.querySelector('.reader-content'),
          document.querySelector('.content'),
          document.querySelector('[class*="reader"]'),
          document.querySelector('[class*="muye"]'),
          document.scrollingElement,
          document.documentElement,
          document.body,
        ];

        let container = null;
        let containerName = '';
        for (const c of candidates) {
          if (!c) continue;
          // 检查这个元素是否真的可滚动
          const style = getComputedStyle(c);
          const canH = style.overflow === 'auto' || style.overflow === 'scroll' ||
                       style.overflowY === 'auto' || style.overflowY === 'scroll';
          const name = c === document.scrollingElement ? 'scrollingElement' :
                        c === document.documentElement ? 'documentElement' :
                        c === document.body ? 'body' :
                        (c.className || c.tagName || 'unknown');
          // 优先用可 overflow 的容器；都没有就用工件根元素
          if (canH || !container) {
            container = c;
            containerName = name;
          }
          if (canH) break; // 找到明确可滚动的容器就停
        }

        if (!container) {
          return { ok: false, msg: 'no_container' };
        }

        const beforeTop = container.scrollTop || 0;
        container.scrollBy(0, step);
        // 如果 scrollBy 不生效（某些元素需要设 scrollTop）
        const afterTop = container.scrollTop || 0;
        if (Math.abs(afterTop - beforeTop) < 2) {
          // 备用：直接设 scrollTop
          container.scrollTop = beforeTop + step;
        }

        const finalTop = container.scrollTop || 0;
        return {
          ok: true,
          container: String(containerName).slice(0, 40),
          before: beforeTop,
          after: finalTop,
          delta: finalTop - beforeTop,
        };
      },
      args: [stepSize],
    });

    if (result) {
      if (result.ok) {
        send('log', { text: `📜 滚动: ${result.container} before=${result.before} after=${result.after} delta=${result.delta}`, type: 'info' });
        if (Math.abs(result.delta) < 3) {
          send('log', { text: `⚠️ 滚动似乎没生效(delta=${result.delta})，尝试 window.scrollBy`, type: 'warn' });
        }
      } else {
        send('log', { text: `⚠️ 未找到滚动容器`, type: 'warn' });
      }
    }
  } catch (e) {
    send('log', { text: `⚠️ safeScroll 出错: ${e.message}`, type: 'warn' });
  }

  await sleep(delay);
}

// 获取 scrollTop（容错）
async function getScrollTop(tid) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => {
        const el =
          document.querySelector('.reader-content') ||
          document.querySelector('.content') ||
          document.scrollingElement ||
          document.documentElement;
        return el ? (el.scrollTop || 0) : (window.scrollY || 0);
      },
    });
    return result || 0;
  } catch (_) {
    return 0;
  }
}

// 帧去重（比较 base64 内容）
function isDupFrame(a, b) {
  try {
    const ba = (a.split(',')[1] || '');
    const bb = (b.split(',')[1] || '');
    if (Math.abs(ba.length - bb.length) > 500) return false;
    // 比较中间段（跳过 header）
    const sa = ba.substring(1000, 3000);
    const sb = bb.substring(1000, 3000);
    let d = 0;
    const L = Math.min(sa.length, sb.length);
    if (L < 10) return false;
    for (let k = 0; k < L; k++) { if (sa[k] !== sb[k]) d++; }
    return (d / L) < 0.03; // 3% 差异阈值（更严格）
  } catch (_) {
    // 如果比较失败，比较 dataUrl 长度
    return a.length === b.length;
  }
}

// ============================================================
// 获取页面信息（完全容错，不抛异常）
// 增加日志：显示检测到的 scrollHeight 和容器
// ============================================================
async function getPageInfo(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        const viewportH = window.innerHeight;

        // 安全获取各容器 scrollHeight
        let scrollHeight = viewportH;
        let containerName = 'window';

        const body = document.body;
        const docEl = document.documentElement;
        if (body && typeof body.scrollHeight === 'number') {
          if (body.scrollHeight > scrollHeight) {
            scrollHeight = body.scrollHeight;
            containerName = 'body';
          }
        }
        if (docEl && typeof docEl.scrollHeight === 'number') {
          if (docEl.scrollHeight > scrollHeight) {
            scrollHeight = docEl.scrollHeight;
            containerName = 'documentElement';
          }
        }

        // 找有 overflow 的容器
        const allEls = document.querySelectorAll('*');
        for (const el of allEls) {
          try {
            const style = getComputedStyle(el);
            const canH = style.overflow === 'auto' || style.overflow === 'scroll' ||
                         style.overflowY === 'auto' || style.overflowY === 'scroll';
            if (canH && el.scrollHeight > el.clientHeight + 5) {
              if (el.scrollHeight > scrollHeight) {
                scrollHeight = el.scrollHeight;
                containerName = (el.className || el.tagName || 'div').slice(0, 40);
              }
            }
          } catch (_) {}
        }

        const canScroll = scrollHeight > viewportH + 5;
        const totalFrames = canScroll ? Math.ceil(scrollHeight / viewportH) : 1;

        return {
          scrollHeight,
          viewportH,
          canScroll,
          totalFrames,
          containerName,
        };
      },
    });

    if (result) {
      send('log', { text: `📐 页面信息: 容器=${result.containerName} 高度=${result.scrollHeight}px viewport=${result.viewportH}px canScroll=${result.canScroll} 预计帧=${result.totalFrames}`, type: 'info' });
    }
    return result;
  } catch (e) {
    send('log', { text: '⚠️ getPageInfo 出错: ' + e.message, type: 'warn' });
    return {
      scrollHeight: 1000,
      viewportH: 800,
      canScroll: false,
      totalFrames: 1,
    };
  }
}

// ============================================================
// 保存单章图片
// ============================================================
async function saveChapter(chapterFrames, filename, chapterNum) {
  try {
    const dataUrl = await stitch(chapterFrames);
    await downloadViaOffscreen(dataUrl, filename);
    send('log', { text: `✅ 第${chapterNum}章已保存 → ${filename}`, type: 'success' });
  } catch (e) {
    send('log', { text: `❌ 第${chapterNum}章保存失败: ${e.message}`, type: 'error' });
    throw e;
  }
}

// ============================================================
// 获取页面标题
// ============================================================
async function getPageTitle(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        const el = document.querySelector('.muye-reader-title');
        if (el && el.innerText && el.innerText.trim()) {
          return el.innerText.trim().slice(0, 50);
        }
        // fallback: h1
        const h1 = document.querySelector('h1');
        if (h1 && h1.innerText) return h1.innerText.trim().slice(0, 50);
        // fallback: document.title
        if (document.title) {
          const idx = document.title.indexOf(' - ');
          return idx > 0 ? document.title.substring(0, idx).trim().slice(0, 50) : document.title.trim().slice(0, 50);
        }
        return '';
      },
    });
    return result || '';
  } catch (_) {
    return '';
  }
}

// ============================================================
// 获取当前 URL
// ============================================================
async function getCurrentUrl(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => location.href,
    });
    return result || '';
  } catch (_) {
    return '';
  }
}

// ============================================================
// 小说名自动识别
// ============================================================
async function detectNovelName(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        // 从 document.title 解析："第X章 XXX - 小说名"
        const rawTitle = document.title || '';
        const parts = rawTitle.split(/\s*[-–—]\s*/);
        if (parts.length >= 2) {
          // 取倒数第二个（通常是小说名）
          const candidate = parts[parts.length - 2] || parts[parts.length - 1];
          const cleaned = candidate
            .replace(/^第[0-9零一二三四五六七八九十百千]+章\s*/, '')
            .replace(/^第[0-9零一二三四五六七八九十百千]+节\s*/, '')
            .trim();
          if (cleaned && cleaned.length >= 2 && cleaned.length <= 30 && !/第.+[章节]/.test(cleaned)) {
            return cleaned;
          }
        }

        // 从页面元素找
        const el = document.querySelector('.muye-reader-nav-title');
        if (el) {
          const txt = el.innerText || el.textContent || '';
          // .muye-reader-nav-title 是小说名（不是章节名）
          if (txt && txt.length >= 2 && txt.length <= 30 && !/第.+[章节]/.test(txt)) {
            return txt.trim();
          }
        }

        return '未命名小说';
      },
    });
    return result || '未命名小说';
  } catch (_) {
    return '未命名小说';
  }
}

function handleDetectNovelName(msg, port) {
  detectNovelName(msg.tabId).then(name => {
    port.postMessage({ action: 'novelNameDetected', novelName: name });
  }).catch(() => {
    port.postMessage({ action: 'novelNameDetected', novelName: '未命名小说' });
  });
}

// ============================================================
// 图片拼接（stitch）
// ============================================================
async function stitch(list) {
  const imgs = await Promise.all(list.map(loadImg));
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

function loadImg(url) {
  return fetch(url).then(r => r.blob()).then(b => createImageBitmap(b));
}

// ============================================================
// 下载（offscreen）
// ============================================================
async function ensureOffscreen() {
  if (offscreenReady) return;
  try {
    const existing = await chrome.offscreen.hasDocument?.()?.catch?.(() => false);
    if (!existing) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.DOWNLOAD],
        justification: '用于处理图片下载，支持文件夹自动创建',
      });
    }
    offscreenReady = true;
  } catch (e) {
    offscreenReady = false;
  }
}

async function downloadViaOffscreen(dataUrl, filename) {
  await ensureOffscreen();
  if (offscreenReady) {
    try {
      const resp = await chrome.runtime.sendMessage({
        action: 'download',
        dataUrl: dataUrl,
        filename: filename,
      });
      if (resp && resp.ok) return;
    } catch (_) {}
  }
  // 直连备用
  return new Promise((ok, fail) => {
    chrome.downloads.download(
      { url: dataUrl, filename: filename, saveAs: false },
      (id) => {
        if (chrome.runtime.lastError) fail(chrome.runtime.lastError);
        else ok();
      }
    );
  });
}

// ============================================================
// 工具函数
// ============================================================
function sanitizeFilename(name) {
  return name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 50)
    .trim() || '未命名';
}

function stop() { running = false; }

function send(act, dat) {
  ports.forEach(p => {
    try { p.postMessage({ action: act, ...dat }); } catch (_) {}
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
