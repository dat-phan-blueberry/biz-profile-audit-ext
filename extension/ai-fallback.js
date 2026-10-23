/**
 * AI Fallback cho Địa Bạ Chrome Extension
 * Gọi AI Gateway (POST /v1/llm/chat) khi script trích xuất DOM cố định bị gãy.
 */

// Lấy cấu hình AI Gateway từ chrome.storage.local
async function getGatewayConfig() {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    return { gatewayUrl: "http://localhost:8000", gatewayKey: "" };
  }
  return new Promise((resolve) => {
    chrome.storage.local.get(["gatewayUrl", "gatewayKey"], (items) => {
      resolve({
        gatewayUrl: (items.gatewayUrl || "http://localhost:8000").replace(/\/+$/, ""),
        gatewayKey: items.gatewayKey || "",
      });
    });
  });
}

// Chụp bản tóm tắt giao diện (text + danh sách nút tương tác)
function capturePageSnapshot() {
  const mainPane =
    document.querySelector('div[role="main"]') ||
    document.querySelector('div[aria-label]') ||
    document.body;

  const rawText = mainPane.innerText || "";
  const textSnapshot = rawText.slice(0, 3500);

  // Tìm các phần tử bấm được (button, role="tab", role="button", a)
  const candidateElements = Array.from(
    mainPane.querySelectorAll('button, [role="tab"], [role="button"], a[role="button"]')
  ).filter((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== "none";
  });

  // Giới hạn tối đa 35 phần tử tương tác đầu tiên
  const interactiveElements = candidateElements.slice(0, 35);
  const clickableItems = interactiveElements.map((el, index) => {
    const label = (
      el.getAttribute("aria-label") ||
      el.innerText ||
      el.getAttribute("title") ||
      el.tagName
    ).trim().replace(/\s+/g, " ");
    const role = el.getAttribute("role") || el.tagName.toLowerCase();
    return {
      index,
      element: el,
      description: `[${index}] <${role}> "${label.slice(0, 60)}"`,
    };
  });

  const clickableListText = clickableItems.map((c) => c.description).join("\n");

  return {
    textSnapshot,
    clickableItems,
    clickableListText,
  };
}

// Chờ thời gian mili-giây
var waitMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Mỗi lượt gọi AI tối đa 25s: gateway/Groq treo thì bỏ, không để cả phiên thu thập đứng mãi.
var AI_CALL_TIMEOUT_MS = 25000;

// Gọi API Chat - hỗ trợ cả background và content script (chuyển tiếp background để tránh Mixed Content)
async function sendChatRequest(payload) {
  // Nếu chạy trong context content script (không có chrome.tabs), gửi qua background
  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage && !chrome.tabs) {
    const response = await Promise.race([
      chrome.runtime.sendMessage({ type: "diaba:llm_chat", body: payload }),
      waitMs(AI_CALL_TIMEOUT_MS + 2000).then(() => ({ ok: false, error: `AI không phản hồi sau ${AI_CALL_TIMEOUT_MS / 1000}s` })),
    ]);
    if (response?.ok) return response.data;
    throw new Error(response?.error || "Không gọi được AI qua extension.");
  }

  const { gatewayUrl, gatewayKey } = await getGatewayConfig();
  const res = await fetch(`${gatewayUrl}/v1/llm/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": gatewayKey,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(AI_CALL_TIMEOUT_MS),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gateway HTTP ${res.status}: ${errText.slice(0, 100)}`);
  }
  return await res.json();
}

/**
 * Vòng lặp AI Fallback điều khiển DOM tối đa 6 bước
 */
async function runAiFallback(missingType) {
  const maxSteps = 6;
  const steps = [];
  const clicked = []; // nhãn đã bấm: đưa vào prompt để AI không bấm vòng quanh, bấm lại cùng nút thì dừng

  const progress = (detail) => { if (typeof reportProgress === "function") reportProgress(missingType, "running", detail); };
  progress("Script không đọc được, chuyển sang AI…");

  for (let step = 0; step < maxSteps; step++) {
    // Phần này đã hết giờ (content.js đặt cờ) thì dừng, không bấm tiếp trên trang.
    if (window.__diabaStop?.[missingType]) {
      return { ok: false, source: "ai", error: "Dừng vì quá thời gian", steps };
    }
    progress(`AI bước ${step + 1}/${maxSteps}: đang đọc trang…`);
    const snapshot = capturePageSnapshot();
    const systemPrompt = `Bạn là AI điều khiển trình duyệt hỗ trợ trích xuất dữ liệu Google Maps cho quán ăn khi script DOM bị gãy.
Nhiệm vụ: Tìm và trích xuất dữ liệu cho mục '${missingType}'.
Có thể trang đang ở tab khác hoặc cần bấm nút (vd: tab Menu, tab Giới thiệu, nút xem thêm).

BẠN CHỈ ĐƯỢC PHÉP TRẢ LỜI ĐÚNG MỘT JSON OBJECT theo một trong 3 mẫu:
1. Yêu cầu bấm phần tử có index N:
   { "action": "click", "index": N }
2. Đã nhìn thấy đủ dữ liệu trên màn hình để trích xuất:
   { "action": "extract", "data": <dữ liệu theo schema> }
3. Không tìm thấy thông tin trên trang sau khi đã thử hoặc hồ sơ không có:
   { "action": "give_up", "reason": "Lý do không tìm thấy" }

QUY TẮC DỪNG:
- Đã bấm đúng tab liên quan (Thực đơn cho menu, Giới thiệu cho tiện ích, Tổng quan/bảng giờ cho giờ đặc biệt) mà vẫn không thấy dữ liệu → give_up, không bấm tab khác.
- Không bấm lại nút đã có trong "Đã bấm". Không bấm nút chia sẻ, chỉ đường, lưu, đặt bàn, gọi điện hay link ra ngoài.
- Giờ đặc biệt chỉ là dòng ngày lễ/giờ khác thường trong bảng giờ; bảng chỉ có 7 ngày giờ thường → give_up.
- Chỉ trích dữ liệu thấy trong text, không suy đoán.

SCHEMA CHO "data" TÙY THEO MỤC:
- Nếu missingType là "menu":
  {
    "categories": [
      {
        "section": "Tên nhóm (ví dụ: Khai vị)",
        "items": [{ "name": "Tên món", "description": "mô tả nếu có", "price": "giá tiền" }]
      }
    ],
    "menuPhotosOnly": false
  }
  (Nếu chỉ thấy ảnh chụp thực đơn mà không có món chữ, đặt menuPhotosOnly = true và categories = [])
- Nếu missingType là "attributes":
  {
    "available": [{ "group": "Nhóm", "label": "Tên tiện ích có" }],
    "unavailable": [{ "group": "Nhóm", "label": "Tên tiện ích không có" }]
  }
- Nếu missingType là "special_hours":
  ["24 thg 12: Đóng cửa", "31 thg 12: 10:00 - 18:00"]`;

    const userPrompt = `Mục cần thu thập: ${missingType} (Bước ${step + 1}/${maxSteps})
Đã bấm: ${clicked.length ? clicked.join(" → ") : "(chưa bấm gì)"}
Text hiển thị hiện tại trên trang:
---
${snapshot.textSnapshot}
---

Danh sách các nút/tab có thể bấm:
${snapshot.clickableListText || "(Không có nút nào)"}`;

    try {
      const resData = await sendChatRequest({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
      });

      const contentStr = resData.choices?.[0]?.message?.content || "{}";
      let parsed = {};
      try {
        parsed = JSON.parse(contentStr);
      } catch {
        steps.push({ step, error: "AI không trả JSON hợp lệ" });
        continue;
      }

      if (parsed.action === "extract") {
        steps.push({ step, action: "extract", data: parsed.data });
        return { ok: true, source: "ai", data: parsed.data, steps };
      }

      if (parsed.action === "give_up") {
        steps.push({ step, action: "give_up", reason: parsed.reason });
        return { ok: false, source: "ai", error: parsed.reason || "AI đã dừng lại", steps };
      }

      if (parsed.action === "click" && typeof parsed.index === "number") {
        const target = snapshot.clickableItems.find((c) => c.index === parsed.index);
        if (target && clicked.includes(target.description.replace(/^\[\d+\]\s*/, ""))) {
          steps.push({ step, action: "repeat_click_stop", label: target.description });
          return { ok: false, source: "ai", error: "AI không tìm thấy dữ liệu (bấm lặp lại cùng nút)", steps };
        }
        if (target && target.element) {
          clicked.push(target.description.replace(/^\[\d+\]\s*/, ""));
          target.element.scrollIntoView?.({ block: "center" });
          target.element.click();
          steps.push({ step, action: "click", index: parsed.index, label: target.description });
          progress(`AI bước ${step + 1}/${maxSteps}: bấm ${target.description.replace(/^\[\d+\]\s*/, "").slice(0, 50)}`);
          await waitMs(1200); // Chờ DOM render sau khi click
          continue;
        } else {
          steps.push({ step, error: `Không tìm thấy nút index ${parsed.index}` });
          continue;
        }
      }

      steps.push({ step, error: "Hành động AI không xác định", raw: parsed });
    } catch (err) {
      steps.push({ step, error: err.message });
      return { ok: false, source: "ai", error: err.message, steps };
    }
  }

  return { ok: false, source: "ai", error: "Hết 6 bước AI fallback mà chưa trích xuất được", steps };
}
