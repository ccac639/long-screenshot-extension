// background.js - MV3 长截图采集 v5.0（仅多章模式）
// 功能：多章采集 / 自动翻页 / 文件夹保存 / 自动识别小说名

let frames = [];
let running = false;
let delay = 800;
let ports = [];
const MAX_FRAMES = 200;
let offscreenReady = false;

// 多章模式状态
let multiMode = true;        // 默认多章模式
let novelName = '';           // 小说名称
let totalChapters = 1;        // 总章节数
let currentChapterNum = 1;    // 当前章节号

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
// 多章采集模式
// ============================================================

async function startMultiCapture(params) {
  delay = params.scrollDelay || 800;
  const chapterDelay = params.chapterDelay || 1500;
  totalChapters = params.chapterCount || 10;
  currentChapterNum = 1;
  running = true;
  multiMode = true;

  // 自动获取小说名（不再依赖手动输入）
  send('log', { text: '🔍 正在自动识别小说名称...', type: 'info' });
  novelName = await detectNovelName((await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
  send('log', { text: `📚 小说名称: ${novelName}`, type: 'success' });
  send('log', { text: `⚙️ 滚动延迟: ${delay}ms | 章节间隔: ${chapterDelay}ms`, type: 'info' });

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    send('update', { totalChapters: totalChapters >= 9999 ? '?' : totalChapters });

    // 主循环：逐章采集
    for (let ch = 1; ch <= totalChapters && running; ch++) {
      currentChapterNum = ch;

      // 每次重新获取当前页标题（不能复用旧值）
      const pageTitle = await getPageTitle(tab.id);
      send('chapterStart', { chapter: ch, title: pageTitle || `第${ch}章` });
      send('update', { currentChapter: ch });

      // 记录当前 URL（用于调试跳章问题）
      const currentUrl = await getCurrentUrl(tab.id);
      send('log', { text: `📍 第${ch}章 开始 | URL: ${currentUrl}`, type: 'info' });

      try {
        // 等待字体加载 + 页面稳定
        await waitForFonts(tab.id);
        await sleep(300);

        // 测量当前章
        const pageInfo = await getPageInfo(tab.id);
        send('update', {
          frameCount: 0,
          status: `第${ch}章 | 高度:${pageInfo.scrollHeight}px 预计:${pageInfo.totalFrames}帧`,
          totalFrames: pageInfo.totalFrames,
          scrollHeight: pageInfo.scrollHeight,
        });

        // 截取当前章
        const capturedFrames = await captureChapter(tab, pageInfo, ch);

        // 保存当前章（自动创建小说文件夹）
        if (capturedFrames.length > 0) {
          const safeName = sanitizeFilename(novelName);
          const chTitle = await getPageTitle(tab.id) || `${ch}`;
          const filename = `${safeName}/第${String(ch).padStart(3, '0')}章_${chTitle}.png`;
          await saveChapter(capturedFrames, filename, ch);

          send('chapterDone', {
            chapter: ch,
            filename: filename,
            currentChapter: ch,
            totalChapters: totalChapters >= 9999 ? '?' : totalChapters,
          });
        }

      } catch (chErr) {
        send('log', { text: `❌ 第${ch}章出错: ${chErr.message}`, type: 'error' });
        // 继续下一章，不中断整体
      }

      // 如果不是最后一章，翻到下一页
      if (ch < totalChapters && running) {
        send('update', {
          currentChapter: ch,
          status: `⏳ 第${ch}章已完成，准备翻到第${ch+1}章... (${chapterDelay}ms)`,
          frameCount: -1,
        });
        await sleep(chapterDelay);

        // 记录翻页前的 URL 和章节标题
        const urlBefore = await getCurrentUrl(tab.id);
        const titleBefore = await getPageTitle(tab.id);
        send('log', { text: `📍 [翻页前] URL: ${urlBefore} | 标题: ${titleBefore}`, type: 'info' });

        // 执行翻页
        const navigated = await navigateNextPage(tab.id);
        if (!navigated) {
          send('log', { text: `⚠️ 无法翻到下一页（第${ch}章后停止）`, type: 'error' });
          break;
        }

        // 翻页后等待页面加载 + 验证
        send('log', { text: `→ 已执行翻页操作，等待页面加载...`, type: 'info' });

        // 分阶段等待：先短等，检查是否开始加载
        await sleep(800);
        let urlAfter1 = await getCurrentUrl(tab.id);
        let titleAfter1 = await getPageTitle(tab.id);
        send('log', { text: `📍 [翻页后-800ms] URL: ${urlAfter1} | 标题: ${titleAfter1}`, type: 'info' });

        // 再等一段时间让页面完全加载
        await sleep(Math.max(chapterDelay - 800, 1000));

        const urlAfter = await getCurrentUrl(tab.id);
        const titleAfter = await getPageTitle(tab.id);
        send('log', { text: `📍 [翻页后-最终] URL: ${urlAfter} | 标题: ${titleAfter}`, type: 'info' });

        // 检测是否真的翻页了
        if (urlBefore === urlAfter && titleBefore === titleAfter) {
          send('log', { text: `⚠️ 警告：翻页后页面未变化！可能翻页失败`, type: 'error' });
          // 再尝试一次
          send('log', { text: `🔄 重试翻页...`, type: 'info' });
          await sleep(500);
          await navigateNextPage(tab.id);
          await sleep(1500);
        }

        // 检测章节号是否跳变（从标题中提取数字）
        const chNumBefore = extractChapterNumber(titleBefore);
        const chNumAfter = extractChapterNumber(titleAfter);
        if (chNumBefore > 0 && chNumAfter > 0) {
          const jump = chNumAfter - chNumBefore;
          if (jump > 1) {
            send('log', { text: `⚠️ 检测到跳章！从第${chNumBefore}章跳到第${chNumAfter}章（跳过${jump-1}章）`, type: 'error' });
          } else if (jump === 0) {
            send('log', { text: `⚠️ 检测到重复！翻页前后都是第${chNumBefore}章`, type: 'warn' });
          }
        }

        send('update', {
          currentChapter: ch + 1,
          status: `⏳ 准备采集第${ch+1}章: ${titleAfter || ''}`,
        });
      }
    }

    send('complete', {
      totalChapters: currentChapterNum,
      totalFrames: frames.reduce((sum, f) => sum + f.length, 0),
    });

  } catch (e) {
    send('error', { error: e.message });
  } finally {
    running = false;
    multiMode = false;
  }
}

/**
 * 截取单个完整章节
 * 返回捕获的帧数组（用于拼接）
 */
async function captureChapter(tab, pageInfo, chapterNum) {
  let chapterFrames = [];

  // 第1帧：当前视口顶部
  let url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  chapterFrames.push(url);

  send('update', {
    frameCount: 1,
    status: `第${chapterNum}章: 1/${pageInfo.totalFrames}帧`,
    totalFrames: pageInfo.totalFrames,
  });

  if (!pageInfo.canScroll) {
    return chapterFrames;
  }

  const loopCount = Math.min(pageInfo.totalFrames - 1, MAX_FRAMES - 1);
  for (let i = 0; i < loopCount && running; i++) {
    try {
      await scrollByViewport(tab.id, pageInfo.viewportH);
      await sleep(delay);

      url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      chapterFrames.push(url);

      send('update', {
        frameCount: chapterFrames.length,
        status: `第${chapterNum}章: ${chapterFrames.length}/${pageInfo.totalFrames}帧 (${Math.round(chapterFrames.length / pageInfo.totalFrames * 100)}%)`,
        totalFrames: pageInfo.totalFrames,
      });
    } catch (e) {
      console.error(`[captureChapter-${chapterNum}] error:`, e);
      break;
    }
  }

  return chapterFrames;
}

/**
 * 保存单章图片（带文件夹路径）
 */
async function saveChapter(chapterFrames, filename, chapterNum) {
  try {
    const dataUrl = await stitch(chapterFrames);

    // 用 offscreen document 下载（最可靠，支持自动创建文件夹）
    await downloadViaOffscreen(dataUrl, filename);

    console.log(`[saveChapter] 第${chapterNum}章已保存: ${filename}`);
    send('log', { text: `✅ 第${chapterNum}章已保存 → ${filename}`, type: 'success' });
  } catch (e) {
    console.error(`[saveChapter-${chapterNum}] err:`, e);
    send('log', { text: `❌ 第${chapterNum}章保存失败: ${e.message}`, type: 'error' });
    throw e;
  }
}

/**
 * 翻到下一页（优先点击"下一章"按钮）
 * 用户网站按钮：<button class="byte-btn ... muye-button"><span>下一章</span></button>
 */
async function navigateNextPage(tabId) {
  // 方法1（优先）：尝试查找并点击"下一章"按钮
  try {
    const [{ result: clickResult }] = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        // 优先匹配用户的网站按钮结构
        const prioritySelectors = [
          // 精确匹配用户提供的按钮 HTML 结构
          'button.muye-button span',
          'button.muye-button',
          '.muye-button',
          // 包含"下一章"文字的按钮
          'button:contains("下一章")',  // jQuery 风格，JS 需手动过滤
          // 通用选择器
          'a.next-chapter', 'button.next-chapter',
          '.next-chapter', '.nextChapter',
        ];

        // 方法 A：遍历所有按钮/链接，匹配文字
        const nextPatterns = [
          '下一章', '下 一 章', '下一页', '后一页',
          'next chapter', 'next', '»', '>>', '→',
        ];

        // 先尝试精确匹配按钮结构
        const allButtons = document.querySelectorAll('button, a, [role="button"], [onclick]');
        let foundBtn = null;

        // 第一遍：精确匹配"下一章"文字
        for (const el of allButtons) {
          const text = (el.textContent || '').trim();
          const html = el.innerHTML || '';

          // 精确匹配"下一章"
          if (text === '下一章' || text.includes('下一章')) {
            // 排除"上一章"（有些网站两个按钮挨着）
            if (!text.includes('上一章') || text === '下一章') {
              foundBtn = el;
              break;
            }
          }

          // 匹配 span 内的文字（用户网站结构）
          const spans = el.querySelectorAll('span');
          for (const span of spans) {
            const spanText = (span.textContent || '').trim();
            if (spanText === '下一章') {
              foundBtn = el;
              break;
            }
          }
          if (foundBtn) break;
        }

        // 第二遍：模糊匹配
        if (!foundBtn) {
          for (const el of allButtons) {
            const text = (el.textContent || '').trim().toLowerCase();
            for (const pattern of nextPatterns) {
              if (text.includes(pattern.toLowerCase()) && !text.includes('上一')) {
                foundBtn = el;
                break;
              }
            }
            if (foundBtn) break;
          }
        }

        if (foundBtn) {
          // 滚动到按钮可见
          foundBtn.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
          // 多种点击方式确保触发
          foundBtn.click();
          foundBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return {
            success: true,
            method: 'click',
            text: (foundBtn.textContent || '').trim().slice(0, 30),
            tag: foundBtn.tagName,
          };
        }

        return { success: false, reason: 'no_next_button_found' };
      },
    });

    if (clickResult && clickResult.success) {
      console.log(`[navigateNextPage] 点击了 "${clickResult.text}" (${clickResult.tag})`);
      send('log', { text: `🖱️ 已点击按钮: ${clickResult.text}`, type: 'success' });
      return true;
    }

    console.warn('[navigateNextPage] 未找到下一章按钮，尝试键盘方法');

  } catch (e) {
    console.warn('[navigateNextPage] 点击方法失败:', e.message);
  }

  // 方法2（备用）：模拟键盘 ArrowRight 键
  try {
    const [{ result: keyResult }] = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        const eventInit = {
          key: 'ArrowRight',
          code: 'ArrowRight',
          keyCode: 39,
          which: 39,
          bubbles: true,
          cancelable: true,
        };
        document.dispatchEvent(new KeyboardEvent('keydown', eventInit));
        document.dispatchEvent(new KeyboardEvent('keypress', eventInit));
        document.dispatchEvent(new KeyboardEvent('keyup', eventInit));
        const el = document.activeElement || document.body;
        el.dispatchEvent(new KeyboardEvent('keydown', eventInit));
        el.dispatchEvent(new KeyboardEvent('keyup', eventInit));
        return { success: true, method: 'keyboard' };
      },
    });

    if (keyResult && keyResult.success) {
      console.log('[navigateNextPage] 使用键盘 ArrowRight');
      send('log', { text: `⌨️ 已模拟键盘 → 键翻页`, type: 'info' });
      return true;
    }
  } catch (e) {
    console.warn('[navigateNextPage] 键盘方法失败:', e.message);
  }

  return false;
}

/**
 * 获取当前页面 URL（用于调试跳章问题）
 */
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

/**
 * 从标题中提取章节号
 * 支持格式：第9章、第009章、第9 章、9、Chapter 9 等
 */
function extractChapterNumber(title) {
  if (!title) return 0;
  // 匹配 "第X章" 或 "第X 章" 格式（支持中文/阿拉伯数字）
  const match = title.match(/第\s*([0-9零一二三四五六七八九十百千]+)\s*[章节]/i);
  if (match) {
    return parseChineseNumber(match[1]) || parseInt(match[1]) || 0;
  }
  // 匹配纯数字开头
  const numMatch = title.match(/^(\d+)/);
  if (numMatch) {
    return parseInt(numMatch[1]) || 0;
  }
  return 0;
}

/**
 * 将中文数字转为阿拉伯数字
 */
function parseChineseNumber(str) {
  const map = { '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10, '百': 100, '千': 1000 };
  if (/^\d+$/.test(str)) return parseInt(str);
  let result = 0;
  let temp = 0;
  for (const char of str) {
    const val = map[char];
    if (val === undefined) return 0; // 无法识别的字符
    if (val >= 10) { // 十/百/千是位权
      temp = temp === 0 ? val : temp * val;
      if (val >= 100) { result += temp; temp = 0; }
    } else {
      temp += val;
    }
  }
  return result + temp;
}

/**
 * 获取页面标题（用于文件命名）
 */
async function getPageTitle(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        // 1. 优先用常见章节标题选择器
        const chapterSelectors = [
          '.muye-reader-nav-title',  // 用户网站
          '.chapter-title', '.reader-chapter-title',
          '.entry-title', '.post-title',
          'h1', 'h2',
        ];
        for (const sel of chapterSelectors) {
          const el = document.querySelector(sel);
          if (el && el.textContent.trim()) {
            return el.textContent.trim().slice(0, 50);
          }
        }
        // 2. 其次用 title（去掉小说名部分）
        if (document.title && document.title.trim()) {
          // 尝试去掉 " - 小说名" 后缀
          const parts = document.title.split(/\s*[-–—]\s*/);
          if (parts.length >= 2) {
            return parts[0].trim().slice(0, 50);
          }
          return document.title.trim().slice(0, 50);
        }
        return '';
      },
    });
    return result || '';
  } catch (_) {
    return '';
  }
}

/**
 * 清理文件名中的非法字符
 */
function sanitizeFilename(name) {
  return name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 50)
    .trim() || '未命名';
}

// ============================================================
// 小说名自动识别
// ============================================================

/**
 * popup 请求识别小说名
 */
function handleDetectNovelName(msg, port) {
  detectNovelName(msg.tabId).then(name => {
    port.postMessage({ action: 'novelNameDetected', novelName: name });
  }).catch(() => {
    port.postMessage({ action: 'novelNameDetected', novelName: '未命名小说' });
  });
}

/**
 * 从页面中自动提取小说名称
 * 优先级：title解析 > 页面元素 > URL > 域名
 */
async function detectNovelName(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        // 1. 从 document.title 解析
        const rawTitle = document.title || '';
        // 常见格式："第X章 XXX - 小说名" 或 "小说名 - 第X章"
        // 取最后一个 " - " 后面的部分作为小说名
        const parts = rawTitle.split(/\s*[-–—]\s*/);
        if (parts.length >= 2) {
          // "第X章 XXX - 小说名 - 网站名" → 取倒数第二个
          const candidate = parts[parts.length - 2] || parts[parts.length - 1];
          // 去掉可能的章节前缀
          const cleaned = candidate
            .replace(/^第[0-9零一二三四五六七八九十百千]+章\s*/, '')
            .replace(/^第[0-9零一二三四五六七八九十百千]+节\s*/, '')
            .trim();
          if (cleaned && cleaned.length >= 2 && cleaned.length <= 30) {
            return { source: 'title', name: cleaned };
          }
        }

        // 2. 查找页面中的小说名元素（增加更多常见选择器）
        const selectors = [
          // 通用小说网站
          '.novel-name', '.book-name', '.bookname', '.novelname',
          '#book-name', '#novel-name', '#bookname',
          '.info-name', '.work-name', '.fiction-name',
          '[itemprop="name"]',
          'meta[property="og:novel"]',
          'meta[property="og:title"]',
          // 阅读器页面常见（番茄/起点/刺猬猫等）
          '.reader-book-name', '.book-info-name', '.novel-title',
          '.reader-header-book', '.reader-top-book-name',
          '[class*="book-name"]', '[class*="novel-name"]',
          // 用户网站相关
          '.muye-reader-nav-title',
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) {
            const txt = (el.textContent || el.content || '').trim();
            // 过滤掉章节名（包含"第X章"的）
            if (txt && txt.length >= 2 && txt.length <= 50 && !/第[0-9零一二三四五六七八九十百千]+[章节]/.test(txt)) {
              return { source: 'element', name: txt };
            }
          }
        }

        // 2.5 特殊：如果页面有 .muye-reader-nav-title，尝试找父级中的小说名
        const titleEl = document.querySelector('.muye-reader-nav-title');
        if (titleEl) {
          // 向上查找包含小说名的元素（通常在 header 或 nav 中）
          let parent = titleEl.parentElement;
          for (let i = 0; i < 5 && parent; i++) {
            const links = parent.querySelectorAll('a');
            for (const link of links) {
              const txt = link.textContent.trim();
              if (txt && txt.length >= 2 && txt.length <= 50 && !txt.includes('下一章') && !txt.includes('返回')) {
                return { source: 'parent-link', name: txt };
              }
            }
            parent = parent.parentElement;
          }
        }

        // 3. 从 URL 路径中提取（最后一段作为小说名）
        try {
          const pathParts = location.pathname.split('/').filter(Boolean);
          const lastPart = pathParts[pathParts.length - 1] || '';
          const decoded = decodeURIComponent(lastPart).replace(/[_-]/g, ' ').trim();
          if (decoded && decoded.length >= 2 && decoded.length <= 30 && !/^\d+$/.test(decoded)) {
            return { source: 'url', name: decoded };
          }
        } catch (_) {}

        // 4.  fallback：用域名作为小说名
        return { source: 'domain', name: location.hostname.replace(/^www\./, '').split('.')[0] || '未命名小说' };
      },
    });
    if (result && result.name) {
      return result.name;
    }
  } catch (e) {
    console.warn('[detectNovelName] 识别失败:', e.message);
  }
  return '未命名小说';
}

/**
 * 确保 offscreen document 已创建
 */
async function ensureOffscreen() {
  if (offscreenReady) return;
  try {
    // 先检查是否已有 offscreen document
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
    console.warn('[ensureOffscreen] 创建失败，将使用直连下载:', e.message);
    offscreenReady = false;
  }
}

/**
 * 通过 offscreen document 下载文件（可靠方式）
 */
async function downloadViaOffscreen(dataUrl, filename) {
  await ensureOffscreen();

  if (offscreenReady) {
    // 通过 runtime.sendMessage 发给 offscreen document
    try {
      const resp = await chrome.runtime.sendMessage({
        action: 'download',
        dataUrl: dataUrl,
        filename: filename,
      });
      if (resp && resp.ok) return;
      console.warn('[download] offscreen 失败，改用直连:', resp?.error);
    } catch (e) {
      console.warn('[download] offscreen 消息失败，改用直连:', e.message);
    }
  }

  // 直连备用：直接调用 downloads API
  return new Promise((ok, fail) => {
    chrome.downloads.download(
      { url: dataUrl, filename: filename, saveAs: false },
      (id) => {
        if (chrome.runtime.lastError) fail(chrome.runtime.lastError);
        else { console.log('[download] 直连下载启动, id:', id); ok(); }
      }
    );
  });
}

// ============================================================
// 公共工具函数
// ============================================================

function stop() { running = false; }

async function getPageInfo(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: () => {
      const viewportH = window.innerHeight;
      const bodySH = document.body ? document.body.scrollHeight : 0;
      const docSH = document.documentElement ? document.documentElement.scrollHeight : 0;
      let scrollHeight = Math.max(bodySH, docSH, viewportH);

      // 找最大的 overflow 容器
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

      return { scrollHeight, viewportH, canScroll, totalFrames, hasCustomContainer: !!containerEl };
    },
  });
  return result;
}

async function scrollByViewport(tabId, amount) {
  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: (stepSize) => {
      window.scrollBy(0, stepSize);
      if (document.documentElement) document.documentElement.scrollTop += stepSize;
      if (document.body) document.body.scrollTop += stepSize;
      // overflow 容器
      const els = document.querySelectorAll('*');
      for (const el of els) {
        try {
          const s = getComputedStyle(el);
          if ((s.overflow === 'auto' || s.overflow === 'scroll' || s.overflowY === 'auto' || s.overflowY === 'scroll')) {
            if (el.scrollHeight > el.clientHeight + 10) el.scrollTop += stepSize;
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
