/**
 * Popup script điều khiển giao diện extension khi người dùng bấm vào icon
 */

const btnCollect = document.getElementById("btnCollect");
const chkMenu = document.getElementById("chkMenu");
const chkAttributes = document.getElementById("chkAttributes");
const chkSpecialHours = document.getElementById("chkSpecialHours");
const statusDiv = document.getElementById("status");
const resultBox = document.getElementById("resultBox");
const lnkOptions = document.getElementById("lnkOptions");

lnkOptions.addEventListener("click", () => {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    window.open(chrome.runtime.getURL("options.html"));
  }
});

btnCollect.addEventListener("click", async () => {
  const missing = [];
  if (chkMenu.checked) missing.push("menu");
  if (chkAttributes.checked) missing.push("attributes");
  if (chkSpecialHours.checked) missing.push("special_hours");

  if (missing.length === 0) {
    statusDiv.textContent = "Vui lòng chọn ít nhất một mục để thu thập.";
    statusDiv.style.color = "#dc2626";
    return;
  }

  btnCollect.disabled = true;
  statusDiv.textContent = "Đang thu thập dữ liệu từ trang Google Maps...";
  statusDiv.style.color = "#0f766e";
  resultBox.style.display = "none";
  resultBox.textContent = "";

  try {
    const response = await chrome.runtime.sendMessage({
      type: "diaba:collect_active_tab",
      missing,
    });

    if (!response || !response.ok) {
      statusDiv.textContent = `Thất bại: ${response?.error || response?.errors?.[0] || "Không lấy được dữ liệu"}`;
      statusDiv.style.color = "#dc2626";
    } else {
      statusDiv.textContent = "Thu thập thành công!";
      statusDiv.style.color = "#059669";
    }

    if (response) {
      resultBox.style.display = "block";
      resultBox.textContent = JSON.stringify(response, null, 2);
    }
  } catch (err) {
    statusDiv.textContent = `Lỗi: ${err.message}`;
    statusDiv.style.color = "#dc2626";
  } finally {
    btnCollect.disabled = false;
  }
});
