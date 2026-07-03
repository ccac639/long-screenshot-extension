// stitch.js - 图片拼接逻辑（参考实现）
// 这个文件可以作为 content script 或者在 background 中通过 executeScript 调用

/**
 * 拼接多张图片为一张长图
 * @param {string[]} imageDataUrls - 图片的 data URL 数组
 * @returns {Promise<string>} - 拼接后的图片 data URL
 */
async function stitchImages(imageDataUrls) {
  // 加载所有图片
  const images = await Promise.all(
    imageDataUrls.map(dataUrl => loadImage(dataUrl))
  );

  // 计算总高度和最大宽度
  let totalHeight = 0;
  let maxWidth = 0;

  images.forEach((img) => {
    totalHeight += img.height;
    maxWidth = Math.max(maxWidth, img.width);
  });

  // 创建 canvas
  const canvas = document.createElement('canvas');
  canvas.width = maxWidth;
  canvas.height = totalHeight;

  const ctx = canvas.getContext('2d');

  // 拼接图片
  let yOffset = 0;
  images.forEach((img) => {
    ctx.drawImage(img, 0, yOffset);
    yOffset += img.height;
  });

  // 返回 data URL
  return canvas.toDataURL('image/png');
}

/**
 * 加载图片
 * @param {string} dataUrl - 图片的 data URL
 * @returns {Promise<HTMLImageElement>}
 */
function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

/**
 * 去重图片帧（可选功能）
 * @param {string[]} frames - 图片帧数组
 * @returns {Promise<string[]>} - 去重后的帧数组
 */
async function deduplicateFrames(frames) {
  const hashes = new Set();
  const uniqueFrames = [];

  for (const frame of frames) {
    const hash = await computeImageHash(frame);
    if (!hashes.has(hash)) {
      hashes.add(hash);
      uniqueFrames.push(frame);
    }
  }

  return uniqueFrames;
}

/**
 * 计算图片哈希（简单版本）
 * @param {string} dataUrl - 图片的 data URL
 * @returns {Promise<string>}
 */
async function computeImageHash(dataUrl) {
  // 简化版本：使用图片尺寸和部分像素作为哈希
  const img = await loadImage(dataUrl);

  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 8;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, 8, 8);

  const data = ctx.getImageData(0, 0, 8, 8).data;
  let hash = '';

  for (let i = 0; i < data.length; i += 4) {
    hash += (data[i] + data[i + 1] + data[i + 2]) > 382 ? '1' : '0';
  }

  return hash;
}
