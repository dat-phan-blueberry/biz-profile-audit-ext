/**
 * Options script quản lý lưu và đọc cấu hình Gateway từ chrome.storage.local
 */

const inputUrl = document.getElementById("gatewayUrl");
const inputKey = document.getElementById("gatewayKey");
const inputForceAi = document.getElementById("forceAi");
const btnSave = document.getElementById("btnSave");
const msgDiv = document.getElementById("msg");

// Đọc cài đặt khi mở trang
document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.local.get(["gatewayUrl", "gatewayKey", "forceAi"], (items) => {
    inputUrl.value = items.gatewayUrl || "http://localhost:8000";
    inputKey.value = items.gatewayKey || "";
    inputForceAi.checked = !!items.forceAi;
  });
});

// Lưu cài đặt
btnSave.addEventListener("click", () => {
  const gatewayUrl = (inputUrl.value || "http://localhost:8000").trim();
  const gatewayKey = (inputKey.value || "").trim();

  chrome.storage.local.set({ gatewayUrl, gatewayKey, forceAi: inputForceAi.checked }, () => {
    msgDiv.textContent = "Đã lưu cấu hình thành công!";
    msgDiv.style.color = "#059669";
    setTimeout(() => {
      msgDiv.textContent = "";
    }, 3000);
  });
});
