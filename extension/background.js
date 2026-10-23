/**
 * Service Worker (Background) cho Địa Bạ Chrome Extension
 * Quản lý mở tab ngầm Google Maps, inject content script, điều phối AI proxy và trả kết quả về Web Địa Bạ.
 */

// Version duy nhất ở manifest.json (tag release ext-vX.Y.Z phải khớp).
const EXTENSION_VERSION = chrome.runtime.getManifest().version;

// Tiện ích chờ thời gian
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Web gửi URL vào: chỉ mở trang Google Maps, không mở URL tùy ý trong tab ngầm.
function isGoogleMapsUrl(value) {
  try {
    const u = new URL(String(value));
    if (u.protocol !== "https:") return false;
    return u.hostname === "maps.google.com" || (u.hostname === "www.google.com" && u.pathname.startsWith("/maps"));
  } catch {
    return false;
  }
}

// Lấy cấu hình Gateway từ chrome.storage.local
async function getGatewayConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["gatewayUrl", "gatewayKey"], (items) => {
      resolve({
        gatewayUrl: (items.gatewayUrl || "http://localhost:8000").replace(/\/+$/, ""),
        gatewayKey: items.gatewayKey || "",
      });
    });
  });
}

/**
 * Chờ tab tải xong hoàn toàn (status === "complete") kèm timeout
 */
function waitForTabLoad(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(); // Không reject để vẫn thử tiếp nếu mạng chậm
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * Điều phối thu thập dữ liệu trên một URL Google Maps
 */
// Tab thu thập đang chạy → hàm báo tiến trình về web (qua Port).
const progressByTab = new Map();
// Tab thu thập đang chạy → hàm nhờ web gọi AI (web dùng phiên đăng nhập + key phía server Địa Bạ).
const llmByTab = new Map();
// Cả phiên tối đa 20 phút: AI agent có thể phải chờ quota theo phút. Web chỉ báo lỗi khi 2 phút không có tiến trình.
const COLLECT_TIMEOUT_MS = 20 * 60000;

async function collectFromMapsUrl(mapsUrl, missing = ["menu", "attributes", "special_hours"], onProgress = () => {}, askLlm = null) {
  let tab = null;
  const steps = [];
  const errors = [];

  try {
    // 1. Mở tab mới ở chế độ không active (chạy ngầm)
    onProgress({ stage: "open", detail: "Đang mở Google Maps…" });
    steps.push({ action: "create_tab", url: mapsUrl });
    tab = await chrome.tabs.create({ url: mapsUrl, active: false });
    progressByTab.set(tab.id, onProgress);
    if (askLlm) llmByTab.set(tab.id, askLlm);

    // 2. Chờ trang tải hoàn tất
    await waitForTabLoad(tab.id);
    onProgress({ stage: "loaded", detail: "Đã tải trang, đang đọc hồ sơ…" });
    await wait(2500); // Chờ Google Maps SPA khởi tạo các thành phần giao diện

    // 3. Inject content script vào tab
    steps.push({ action: "inject_script", tabId: tab.id });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["ai-fallback.js", "content.js"],
    });

    await wait(500);

    // 4. Gửi lệnh thu thập dữ liệu
    steps.push({ action: "send_collect_command", missing });
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "COLLECT_DATA",
      missing,
    });

    if (response) {
      if (response.steps) steps.push(...response.steps);
      if (response.errors) errors.push(...response.errors);
      return {
        ok: response.ok,
        data: response.data || {},
        steps,
        errors,
      };
    }

    return {
      ok: false,
      data: {},
      steps,
      errors: ["Không nhận được phản hồi từ Content Script"],
    };
  } catch (err) {
    errors.push(err.message);
    return {
      ok: false,
      data: {},
      steps,
      errors,
    };
  } finally {
    // 5. Đóng tab ngầm sau khi hoàn tất
    if (tab && tab.id) {
      progressByTab.delete(tab.id);
      llmByTab.delete(tab.id);
      try {
        await chrome.tabs.remove(tab.id);
      } catch {
        // Tab có thể đã bị đóng trước đó
      }
    }
  }
}

/** Chạy thu thập có hạn tổng; hết giờ vẫn trả kết quả (tab được đóng trong finally). */
function collectWithDeadline(mapsUrl, missing, onProgress, askLlm) {
  return Promise.race([
    collectFromMapsUrl(mapsUrl, missing, onProgress, askLlm),
    wait(COLLECT_TIMEOUT_MS).then(() => ({ ok: false, data: {}, steps: [], errors: [`Quá ${COLLECT_TIMEOUT_MS / 1000}s chưa thu thập xong`] })),
  ]);
}

/**
 * 0. Kênh Port từ web (chrome.runtime.connect): gửi tiến trình theo thời gian thực rồi kết quả cuối.
 */
chrome.runtime.onConnectExternal.addListener((port) => {
  if (port.name !== "diaba-collect") return;
  let closed = false;
  port.onDisconnect.addListener(() => { closed = true; });
  const post = (msg) => { if (!closed) { try { port.postMessage(msg); } catch { closed = true; } } };
  // Yêu cầu AI gửi sang web, chờ "llm_result" cùng id (tối đa 25s).
  const pendingLlm = new Map();
  let llmSeq = 0;
  const askLlm = (body) => new Promise((resolve) => {
    if (closed) return resolve({ ok: false, error: "Trang Địa Bạ đã đóng kết nối." });
    const id = ++llmSeq;
    const timer = setTimeout(() => { pendingLlm.delete(id); resolve({ ok: false, error: "AI không phản hồi sau 33s" }); }, 33000);
    pendingLlm.set(id, (r) => { clearTimeout(timer); resolve(r); });
    post({ type: "llm", id, body });
  });

  port.onMessage.addListener(async (message) => {
    if (message?.type === "llm_result") {
      const done = pendingLlm.get(message.id);
      if (done) {
        pendingLlm.delete(message.id);
        done({ ok: !!message.ok, data: message.data, error: message.error, status: message.status, retryAfterSeconds: message.retryAfterSeconds, quotaPeriod: message.quotaPeriod });
      }
      return;
    }
    if (message?.type !== "diaba:collect") return;
    if (!isGoogleMapsUrl(message.mapsUrl)) {
      post({ type: "result", ok: false, errors: ["Chỉ nhận link Google Maps."] });
      return;
    }
    const result = await collectWithDeadline(message.mapsUrl, message.missing, (p) => post({ type: "progress", ...p }), askLlm);
    post({ type: "result", ...result });
  });
});

/**
 * 1. Lắng nghe thông điệp từ trang Web bên ngoài (externally_connectable)
 * Web Địa Bạ gọi qua: chrome.runtime.sendMessage(EXTENSION_ID, message)
 */
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  // Lệnh ping kiểm tra extension đã cài chưa
  if (message.type === "diaba:ping") {
    sendResponse({ ok: true, version: EXTENSION_VERSION });
    return false;
  }

  // Lệnh thu thập thông tin còn thiếu từ Google Maps
  if (message.type === "diaba:collect") {
    const { mapsUrl, missing } = message;
    if (!isGoogleMapsUrl(mapsUrl)) {
      sendResponse({ ok: false, error: "Chỉ nhận link Google Maps (https://www.google.com/maps… hoặc https://maps.google.com/…)." });
      return false;
    }

    (async () => {
      const result = await collectWithDeadline(mapsUrl, missing);
      sendResponse(result);
    })();

    return true; // Giữ channel async mở
  }

  sendResponse({ ok: false, error: `Lệnh không hỗ trợ: ${message.type}` });
  return false;
});

/**
 * 2. Lắng nghe thông điệp nội bộ (từ popup hoặc content script)
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Agent trong tab chạy ngầm nhờ background đếm giờ (Chrome bóp setTimeout của tab ẩn lâu).
  if (message.type === "diaba:sleep") {
    setTimeout(() => sendResponse(true), Math.min(Math.max(Number(message.ms) || 0, 0), 60000));
    return true;
  }

  // Tiến trình từ content script của tab đang thu thập → web
  if (message.type === "diaba:progress") {
    const relay = sender.tab && progressByTab.get(sender.tab.id);
    if (relay) relay({ stage: "section", section: message.section, status: message.status, detail: message.detail, diag: message.diag });
    return false;
  }

  // Chuyển tiếp request AI Chat từ content script để tránh Mixed Content
  if (message.type === "diaba:llm_chat") {
    // Đang thu thập theo lệnh của web → nhờ web gọi AI qua máy chủ Địa Bạ (không cần cấu hình Options).
    const viaWeb = sender.tab && llmByTab.get(sender.tab.id);
    if (viaWeb) {
      viaWeb(message.body).then(sendResponse);
      return true;
    }
    // Test tay từ popup: dùng Gateway trong Options.
    (async () => {
      try {
        const { gatewayUrl, gatewayKey } = await getGatewayConfig();
        const res = await fetch(`${gatewayUrl}/v1/llm/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": gatewayKey,
          },
          body: JSON.stringify(message.body),
          signal: AbortSignal.timeout(25000),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          sendResponse({ ok: false, error: `Gateway HTTP ${res.status}: ${text}` });
          return;
        }

        const data = await res.json();
        sendResponse({ ok: true, data });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // Thu thập trên tab Maps hiện tại từ Popup test tay
  if (message.type === "diaba:collect_active_tab") {
    (async () => {
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab || !activeTab.id) {
          sendResponse({ ok: false, error: "Không tìm thấy tab Maps đang hoạt động." });
          return;
        }

        // Đảm bảo content script đã được nạp
        await chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          files: ["ai-fallback.js", "content.js"],
        });

        const res = await chrome.tabs.sendMessage(activeTab.id, {
          type: "COLLECT_DATA",
          missing: message.missing || ["menu", "attributes", "special_hours"],
        });

        sendResponse(res || { ok: false, error: "Không có phản hồi từ tab" });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
});
