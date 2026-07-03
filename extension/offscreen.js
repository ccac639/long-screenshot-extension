// offscreen.js - MV3 offscreen document for reliable downloads
// This runs in an offscreen page (has DOM access, unlike service worker)

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'download') {
    handleDownload(msg.dataUrl, msg.filename)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep channel open for async response
  }
});

/**
 * Download a data URL as a file, reliably creating folders
 * Approach: write to a temporary <a> element and click it
 * This triggers Chrome's save dialog or auto-save based on user settings
 */
async function handleDownload(dataUrl, filename) {
  // Method 1: Use chrome.downloads.download (works in offscreen page)
  // The filename path with "/" will create folders automatically
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: dataUrl, filename: filename, saveAs: false },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          console.warn('[offscreen] downloads API failed:', chrome.runtime.lastError.message);
          // Fallback: use anchor tag method
          fallbackDownload(dataUrl, filename).then(resolve).catch(reject);
        } else {
          console.log('[offscreen] Download started, id:', downloadId);
          resolve();
        }
      }
    );
  });
}

/**
 * Fallback: create <a> element and click it
 * This bypasses any downloads API issues
 */
async function fallbackDownload(dataUrl, filename) {
  // Convert data URL to blob URL for better compatibility
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const blobUrl = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename; // Chrome will use the path with "/" to create folders
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();

  // Cleanup after a short delay
  setTimeout(() => {
    URL.revokeObjectURL(blobUrl);
    document.body.removeChild(a);
  }, 1000);

  return new Promise((resolve) => setTimeout(resolve, 500));
}
