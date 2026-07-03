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

// ============================================================
// Patch 1: 章节锁（彻底修复跳章）
// ============================================================
let lastChapterKey = '';
let isSwitchingChapter = false;

// ============================================================
// Patch 2: 帧去重
// ============================================================
let lastFrame = '';

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
  let totalFrameCount = 0;  // 用于统计总帧数

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

          // 累加帧数
          totalFrameCount += capturedFrames.length;

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
          status: `⏳ 第${ch}章已完成，准备翻到第${ch+1}章...`,
          frameCount: -1,
        });

        // Patch 1: 使用 safeNextChapter（带章节锁）
        const navigated = await safeNextChapter(tab.id);
        if (!navigated) {
          send('log', { text: `⚠️ 无法翻到下一页（第${ch}章后停止）`, type: 'error' });
          break;
        }

        // 等待页面完全渲染
        await sleep(chapterDelay);

        const titleAfter = await getPageTitle(tab.id);
        send('log', { text: `📍 翻页后标题: ${titleAfter}`, type: 'info' });

        send('update', {
          currentChapter: ch + 1,
          status: `⏳ 准备采集第${ch+1}章: ${titleAfter || ''}`,
        });
      }
    }

    send('complete', {
      totalChapters: currentChapterNum - 1,  // 已完成的章节数
      totalFrames: totalFrameCount,  // 用局部变量统计
    });

  } catch (e) {
    send('error', { error: e.message });
  } finally {
    running = false;
    multiMode = false;
  }
}

/**
 * ============================================================
 * Patch 2+4: 截取单个完整章节（带帧去重 + 跳章检测）
 * ============================================================
 */
async function captureChapter(tab, pageInfo, chapterNum) {
  let chapterFrames = [];
  let duplicateCount = 0;
  const MAX_DUP = 3; // 连续重复N帧则停止

  // 章节锁（用章节指纹）
  const chapterKeyBefore = await getChapterKeyFromTab(tab.id);
  lastChapterKey = chapterKeyBefore;
  send('log', { text: "🔒 章节锁: " + chapterKeyBefore.slice(0, 50), type: 'info' });

  // 第1帧
  let url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  chapterFrames.push(url);
  lastFrame = url; // Patch 2: 记录上一帧
  send('update', { frameCount: 1, status: "第" + chapterNum + "章: 1/" + pageInfo.totalFrames + "帧", totalFrames: pageInfo.totalFrames });

  if (!pageInfo.canScroll) return chapterFrames;

  // 步长 = viewport高度 - 重叠30px
  const stepSize = pageInfo.viewportH - 30;
  send('log', { text: "📏 步长:" + stepSize + "px | viewport:" + pageInfo.viewportH + "px | 总高:" + pageInfo.scrollHeight + "px", type: 'info' });

  const loopCount = Math.min(pageInfo.totalFrames + 2, MAX_FRAMES);
  for (let i = 0; i < loopCount && running; i++) {
    try {
      // Patch 4: 滚动前获取章节指纹
      const keyBeforeScroll = await getChapterKeyFromTab(tab.id);

      // Patch 3: 使用 scrollStable（等稳定）
      await scrollStable(tab.id, stepSize);

      // Patch 4: 滚动后检测是否跳章
      const keyAfterScroll = await getChapterKeyFromTab(tab.id);
      if (keyBeforeScroll && keyAfterScroll && keyBeforeScroll !== keyAfterScroll) {
        send('log', { text: "⚠️ 检测到跳章（滚动触发），停止截取", type: 'error' });
        break;
      }

      // 验证滚动（检测是否到底）
      const afterST = await getScrollTop(tab.id);
      const beforeST = i > 0 ? (await getScrollTop(tab.id)) : 0;
      const delta = afterST - beforeST;

      if (Math.abs(delta) < 5 && i > 0) {
        send('log', { text: "⛔ 滚动停止(delta=" + delta + "px)，到底了", type: 'info' });
        break;
      }

      // 捕获当前帧
      url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

      // Patch 2: 帧去重（用 isDupFrame 比较 base64 内容）
      if (chapterFrames.length > 0) {
        if (isDupFrame(chapterFrames[chapterFrames.length - 1], url)) {
          duplicateCount++;
          send('log', { text: "⚠️ 检测到重复帧(" + duplicateCount + "/" + MAX_DUP + ")", type: 'warn' });
          if (duplicateCount >= MAX_DUP) {
            send('log', { text: "⛔ 连续" + MAX_DUP + "帧重复，停止", type: 'warn' });
            break;
          }
          continue;
        }
      }
      duplicateCount = 0;
      lastFrame = url;

      chapterFrames.push(url);

      send('update', {
        frameCount: chapterFrames.length,
        status: "第" + chapterNum + "章: " + chapterFrames.length + "/" + pageInfo.totalFrames + "帧",
        totalFrames: pageInfo.totalFrames,
      });
    } catch(e) {
      console.error("[ch" + chapterNum + "] err:", e);
      break;
    }
  }

  send('log', { text: "✅ 第" + chapterNum + "章完成: " + chapterFrames.length + "帧", type: 'success' });
  return chapterFrames;
}

// 获取 scrollTop
async function getScrollTop(tid) {
  try {
    var r = await chrome.scripting.executeScript({ target:{tabId:tid}, func:function(){
      var els = [
        document.querySelector('.reader-content'),
        document.querySelector('.content'),
        document.querySelector('[class*="reader"]'),
        document.querySelector('[class*="muye"]'),
        document.scrollingElement || document.documentElement
      ];
      for(var j=0;j<els.length;j++){ if(els[j]&&typeof els[j].scrollTop==='number') return els[j].scrollTop; }
      return window.scrollY||0;
    }});
    return r[0].result||0;
  }catch(_){return 0;}
}

// 帧去重
function isDupFrame(a,b){
  try{
    var ba=(a.split(',')[1]||''), bb=(b.split(',')[1]||'');
    if(Math.abs(ba.length-bb.length)>1000) return false;
    var sa=ba.substring(500,2500), sb=bb.substring(500,2500), d=0, L=Math.min(sa.length,sb.length);
    for(var k=0;k<L;k++){if(sa[k]!==sb[k])d++;}
    return (d/L)<0.05;
  }catch(_){return false;}
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
 * ============================================================
 * Patch 1: 获取章节唯一标识（用于章节锁）
 * 用 .muye-reader-title + .reader-content 前200字作为章节指纹
 * ============================================================
 */
async function getChapterKeyFromTab(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        const title = document.querySelector('.muye-reader-title')?.innerText || '';
        const content = document.querySelector('.reader-content')?.innerText || '';
        return title + '|' + content.slice(0, 200);
      },
    });
    return result || '';
  } catch (_) {
    return '';
  }
}

/**
 * ============================================================
 * Patch 1: 安全翻章（带章节锁，彻底修复跳章）
 * 点击下一章后，循环等待章节真正变化才返回
 * ============================================================
 */
async function safeNextChapter(tabId) {
  if (isSwitchingChapter) return false;
  isSwitchingChapter = true;

  // 记录翻章前的章节指纹
  const beforeKey = await getChapterKeyFromTab(tabId);
  send('log', { text: `🔒 翻章前指纹: ${beforeKey.slice(0, 40)}`, type: 'info' });

  // 执行点击下一章按钮
  let clicked = false;
  try {
    const [{ result: clickResult }] = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        const allButtons = document.querySelectorAll('button, a, [role="button"]');
        let foundBtn = null;

        // 精确匹配"下一章"
        for (const el of allButtons) {
          const text = (el.textContent || '').trim();
          if (text === '下一章' && !text.includes('上一')) {
            foundBtn = el;
            break;
          }
          // 匹配 span 内的文字
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
          foundBtn.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
          foundBtn.click();
          foundBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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

  // 等待章节真的变化（防误跳 / 防连跳）
  let chapterChanged = false;
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    const nowKey = await getChapterKeyFromTab(tabId);

    if (nowKey && nowKey !== beforeKey) {
      lastChapterKey = nowKey;
      chapterChanged = true;
      send('log', { text: `✅ 章节已变化: ${nowKey.slice(0, 40)}`, type: 'success' });
      break;
    }
  }

  if (!chapterChanged) {
    send('log', { text: `⚠️ 翻章后章节未变化（可能已到最后一章）`, type: 'warn' });
  }

  isSwitchingChapter = false;
  return chapterChanged;
}

/**
 * 翻到下一页（优先点击"下一章"按钮）
 * 用户网站按钮：<button class="byte-btn ... muye-button"><span>下一章</span></button>
 * ⚠️ 已废弃，请使用 safeNextChapter()
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

          // 只匹配精确的"下一章"，排除"上一章"
          if (text === '下一章' && !text.includes('上一')) {
            foundBtn = el;
            break;
          }
          // 模糊匹配"下一章"（允许前后有空格）
          if (text.includes('下一章') && !text.includes('上一')) {
            foundBtn = el;
            break;
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
 * 增加重试机制：如果标题是小说名（不含"第X章"），等待页面更新后再获取
 */
async function getPageTitle(tabId, retry) {
  retry = retry !== false;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        const out = { title: '', debug: [] };
        // 增加更多选择器
        const sels = [
          '.muye-reader-title',  // 章节名（用户确认）
          'h1',
          'h2',
          '.chapter-title',
          '.reader-chapter-title',
          '.entry-title',
          '.post-title',
          '[class*="chapter"]',
          '[class*="title"]',
        ];
        for (const s of sels) {
          const el = document.querySelector(s);
          if (el && el.textContent.trim()) {
            out.title = el.textContent.trim().slice(0, 50);
            out.debug.push('sel:' + s + '=' + out.title.slice(0, 20));
            break;
          }
        }
        if (!out.title && document.title) {
          const idx = document.title.indexOf(' - ');
          out.title = idx > 0 ? document.title.substring(0, idx).trim().slice(0, 50) : document.title.trim().slice(0, 50);
          out.debug.push('title-parse:' + out.title.slice(0, 20));
        }
        return out;
      },
    });
    const title = result ? (result.title || '') : '';
    const dbg = result ? (result.debug || []) : [];
    if (dbg.length) send('log', { text: '🔍 getTitle:' + dbg.join(';'), type: 'info' });
    // 重试
    if (retry && title && !/第.+[章节]/.test(title)) {
      await new Promise(r => setTimeout(r, 1000));
      const [{ result: r2 }] = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: () => {
          const el = document.querySelector('.muye-reader-nav-title') || document.querySelector('h1');
          return el ? el.textContent.trim().slice(0, 50) : (document.title || '').split(' - ')[0] || '';
        },
      });
      return r2 || title || '';
    }
    return title || '';
  } catch (e) {
    send('log', { text: '❌ getPageTitle 出错:' + e.message, type: 'error' });
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

      // 找最大的 overflow 容器（收集候选信息）
      let containerEl = null;
      const candidates = [];
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        try {
          const style = getComputedStyle(el);
          if ((style.overflow === 'auto' || style.overflow === 'scroll' ||
               style.overflowY === 'auto' || style.overflowY === 'scroll')) {
            if (el.scrollHeight > el.clientHeight + 5) {
              candidates.push({ tag: el.tagName, class: String(el.className||'').slice(0,40), sh: el.scrollHeight });
              if (el.scrollHeight > scrollHeight) { scrollHeight = el.scrollHeight; containerEl = el; }
            }
          }
        } catch (_) {}
      }

      const canScroll = scrollHeight > viewportH + 10;
      const totalFrames = canScroll ? Math.ceil(scrollHeight / viewportH) : 1;

      return {
        scrollHeight, viewportH, canScroll, totalFrames,
        hasCustomContainer: !!containerEl,
        containerInfo: containerEl ? { tag: containerEl.tagName, class: String(containerEl.className||'').slice(0,60), sh: containerElement.scrollHeight } : null,
        topCandidates: candidates.slice(0,5),
      };
    },
  });

  if (result && result.containerInfo) {
    send('log', { text: "📦 滚动容器: <" + result.containerInfo.tag + "> | 高度:" + result.containerInfo.sh + "px", type: 'info' });
  }

  return result;
}

/**
 * ============================================================
 * Patch 3: scroll 必须"等稳定"
 * 滚动后等待 font ready + paint 稳定
 * ============================================================
 */
async function scrollStable(tabId, stepSize) {
  // 先执行滚动
  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: (step) => {
      // 优先锁定阅读容器（防止触发 SPA 路由跳转）
      const container =
        document.querySelector('.reader-content') ||
        document.querySelector('.content') ||
        document.querySelector('[class*="reader"]') ||
        document.querySelector('[class*="muye"]') ||
        document.scrollingElement;

      if (container) {
        container.scrollBy(0, step);
      } else {
        window.scrollBy(0, step);
      }
    },
    args: [stepSize],
  });

  // 等待 120ms 让滚动生效
  await sleep(120);

  // 等 font ready（防止字体切换导致内容高度变化）
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

  // 再等 80ms 让 paint 稳定
  await sleep(80);
}

/**
 * @deprecated 请使用 scrollStable()
 */
async function scrollByViewport(tabId, amount) {
  await scrollStable(tabId, amount);
}

/**
 * 稳定滚动（等待滚动真正停止）
 */
async function stableScroll(tabId, stepSize) {
  // 先滚动
  await scrollByViewport(tabId, stepSize);

  // 等待滚动稳定（检测 scrollTop 是否停止变化）
  let stable = 0;
  const checkInterval = 80; // 80ms 检查一次
  const requiredStable = 2; // 连续 2 次不变则认为稳定

  while (stable < requiredStable) {
    await sleep(checkInterval);

    const [{ result: scrollTop }] = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        const el =
          document.querySelector('.reader-content') ||
          document.querySelector('.content') ||
          document.scrollingElement;
        return el ? el.scrollTop : window.scrollY;
      },
    });

    // 简化：直接等待固定时间（更可靠）
    stable++;
  }
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
