// 临时调试脚本：检查页面结构
console.log("=== 页面调试信息 ===");
console.log("document.title:", document.title);
console.log(".muye-reader-nav-title:", document.querySelector(".muye-reader-nav-title")?.textContent);
console.log("h1:", document.querySelector("h1")?.textContent);
console.log("所有包含'章'的元素:");
document.querySelectorAll("*").forEach(el => {
  const txt = el.textContent?.trim() || "";
  if (txt.includes("第") && txt.includes("章") && txt.length < 100) {
    console.log(el.tagName, el.className, txt.slice(0, 50));
  }
});
