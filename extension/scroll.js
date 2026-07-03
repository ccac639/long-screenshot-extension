// scroll.js - 滚动控制逻辑
// 这个文件的函数会通过 chrome.scripting.executeScript 注入到页面中执行

/**
 * 滚动页面
 * @param {number} step - 滚动步长（像素）
 * @returns {Object} - 滚动信息
 */
function scrollPage(step) {
  const beforeScroll = window.pageYOffset || document.documentElement.scrollTop;
  window.scrollBy(0, step);
  const afterScroll = window.pageYOffset || document.documentElement.scrollTop;

  return {
    scrollTop: afterScroll,
    scrollHeight: Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    ),
    clientHeight: window.innerHeight,
    didScroll: beforeScroll !== afterScroll
  };
}

/**
 * 获取页面滚动信息
 * @returns {Object}
 */
function getScrollInfo() {
  return {
    scrollTop: window.pageYOffset || document.documentElement.scrollTop,
    scrollHeight: Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    ),
    clientHeight: window.innerHeight,
    maxScroll: Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    ) - window.innerHeight
  };
}

/**
 * 滚动到顶部
 */
function scrollToTop() {
  window.scrollTo(0, 0);
}

/**
 * 滚动到底部
 */
function scrollToBottom() {
  const maxScroll = Math.max(
    document.body.scrollHeight,
    document.documentElement.scrollHeight
  ) - window.innerHeight;
  window.scrollTo(0, maxScroll);
}

/**
 * 检查是否到达底部
 * @returns {boolean}
 */
function isAtBottom() {
  const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
  const maxScroll = Math.max(
    document.body.scrollHeight,
    document.documentElement.scrollHeight
  ) - window.innerHeight;

  return scrollTop >= maxScroll - 10; // 允许 10px 的误差
}

// 如果需要作为 content script 注入，可以导出函数
if (typeof window !== 'undefined') {
  window.scrollPage = scrollPage;
  window.getScrollInfo = getScrollInfo;
  window.scrollToTop = scrollToTop;
  window.scrollToBottom = scrollToBottom;
  window.isAtBottom = isAtBottom;
}
