/**
 * Content script chạy trên trang Google Maps (https://www.google.com/maps/*)
 * Thu thập các mục còn thiếu: Menu (chữ), Tiện ích (About), Giờ đặc biệt (Special Hours).
 * Sử dụng kiến trúc lai: Script cố định -> fallback AI (ai-fallback.js) khi script gãy.
 *
 * Cấu trúc DOM đã đối chiếu trên Maps đăng nhập (2026-10-22):
 * - Panel quán: div[role="main"]; tab chính nằm trong [role="tablist"] đầu tiên (Tổng quan, Thực đơn, Bài đánh giá, Giới thiệu).
 * - Thực đơn: [role="tablist"] thứ hai là các nhóm món (tab đầu "Tổng quan" bỏ qua); món nằm trong [role="region"][aria-label="Menu"],
 *   mỗi món: tên .fontBodyMedium, mô tả .fontBodySmall, giá trong h2 (có thể không có giá).
 * - Giới thiệu: mỗi nhóm một h2, mỗi tiện ích là li > span[aria-label="Có …" | "Không có …"].
 * - Giờ: bảng <table> 7 ngày; ngày lễ sắp tới hiện kèm tên lễ / "giờ có thể khác".
 */

// runAiFallback do ai-fallback.js cung cấp (nạp trước file này trong cùng isolated world).

// Tiện ích chờ thời gian
var wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Chờ điều kiện đúng (poll 200ms), hết hạn trả về false. */
var waitFor = async (check, timeoutMs) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { if (check()) return true; } catch { /* DOM đang đổi */ }
    await wait(200);
  }
  return false;
};

var norm = (s) => (s || "").replace(/\s+/g, " ").trim();
// Giá theo locale tài khoản: "219.000 ₫", "₫219,000", "từ 99.000 đ", "120k", "$12.50".
var MENU_PRICE_RE = /^(?:từ\s*|from\s*)?(?:₫\s*\d{1,3}(?:[.,]\d{3})+(?:\s*[-–]\s*₫?\s*\d{1,3}(?:[.,]\d{3})+)?|\d{1,3}(?:[.,]\d{3})+(?:\s*[-–]\s*\d{1,3}(?:[.,]\d{3})+)?\s*(?:₫|đ|vnđ|vnd)|\d+(?:[.,]\d+)?\s*k|(?:US)?\$\s*\d+(?:[.,]\d{1,2})?)$/i;

var placePane = () => document.querySelector('div[role="main"]');

/** Chờ panel quán và thanh tab chính xuất hiện (Maps là SPA, tải chậm). */
async function waitForPlace() {
  await waitFor(() => placePane()?.querySelector('[role="tablist"] [role="tab"]'), 12000);
  return placePane();
}

/** Tab chính của panel quán theo tên (aria-label có dạng "Giới thiệu về <tên quán>"). */
function findMainTab(regex) {
  const list = placePane()?.querySelector('[role="tablist"]');
  if (!list) return null;
  return Array.from(list.querySelectorAll('[role="tab"]')).find((t) => regex.test(norm(t.getAttribute("aria-label") || t.innerText))) || null;
}

async function openMainTab(regex) {
  const tab = findMainTab(regex);
  if (!tab) return null;
  if (tab.getAttribute("aria-selected") !== "true") {
    tab.click();
    await waitFor(() => tab.getAttribute("aria-selected") === "true", 4000);
  }
  await wait(1200); // nội dung tab render sau khi chọn
  return tab;
}

/** Đọc các thẻ món trong vùng menu: neo theo tên món (hoặc theo giá nếu không có tên), leo lên tới khung chỉ chứa đúng một món. */
function menuItemsIn(region) {
  if (!region) return [];
  const isPrice = (el) => MENU_PRICE_RE.test(norm(el.textContent));
  let anchors = Array.from(region.querySelectorAll(".fontBodyMedium")).filter((el) => !el.closest("h2") && norm(el.textContent) && !isPrice(el));
  anchors = anchors.filter((a) => !anchors.some((o) => o !== a && o.contains(a)));
  if (!anchors.length) anchors = Array.from(region.querySelectorAll("*")).filter((el) => el.children.length === 0 && isPrice(el));
  const cards = [];
  for (const a of anchors) {
    let card = a;
    while (card.parentElement && card.parentElement !== region && anchors.filter((o) => card.parentElement.contains(o)).length === 1) card = card.parentElement;
    if (!cards.includes(card)) cards.push(card);
  }
  const items = [];
  for (const card of cards) {
    const priceEl = Array.from(card.querySelectorAll("*")).find((el) => el.children.length === 0 && isPrice(el));
    const price = priceEl ? norm(priceEl.textContent) : "";
    const nameEl = anchors.find((a) => card.contains(a) && !isPrice(a));
    const lines = (card.innerText || "").split("\n").map(norm).filter(Boolean).filter((l) => l !== price);
    const name = nameEl ? norm(nameEl.textContent) : lines[0] || "";
    const description = lines.filter((l) => l !== name).join(" ");
    if (name && !items.some((it) => it.name === name && it.price === price)) items.push({ name, description, price });
  }
  return items;
}

var menuRegion = (main) =>
  main.querySelector('[role="region"][aria-label="Menu"], [role="region"][aria-label="Thực đơn"]') ||
  Array.from(main.querySelectorAll('[role="region"]')).find((r) => /menu|thực đơn/i.test(r.getAttribute("aria-label") || ""));

/**
 * Thu thập thực đơn dạng chữ (Menu)
 */
async function collectMenu() {
  const steps = [];
  try {
    const main = await waitForPlace();
    if (!main) return { ok: false, source: "script", error: "Không mở được hồ sơ quán trên Maps", steps };
    const tab = await openMainTab(/^(thực\s*đơn|menu)\b/i);
    if (!tab) {
      return { ok: true, source: "script", data: { categories: [], noTextMenu: true }, detail: "Hồ sơ không có tab Thực đơn", steps };
    }
    steps.push({ action: "click_tab", label: "Thực đơn" });

    const lists = Array.from(main.querySelectorAll('[role="tablist"]'));
    const chips = lists.length > 1
      ? Array.from(lists[lists.length - 1].querySelectorAll('[role="tab"]')).filter((c) => !/^(tổng\s*quan|overview)$/i.test(norm(c.getAttribute("aria-label") || c.innerText)))
      : [];
    const categories = [];

    if (chips.length) {
      for (let i = 0; i < chips.length; i++) {
        if (window.__diabaStop?.menu) break;
        const chip = chips[i];
        const section = norm(chip.getAttribute("aria-label") || chip.innerText) || "Thực đơn";
        reportProgress("menu", "running", `Đọc nhóm ${i + 1}/${chips.length}: ${section}`);
        const before = norm(menuRegion(main)?.innerText);
        chip.click();
        await waitFor(() => chip.getAttribute("aria-selected") === "true", 3000);
        await waitFor(() => norm(menuRegion(main)?.innerText) !== before, 2500);
        await wait(400);
        const items = menuItemsIn(menuRegion(main));
        steps.push({ action: "read_menu_section", section, items: items.length });
        if (items.length) categories.push({ section, items });
      }
    } else {
      // Không có nhóm món: chỉ nhận món có giá — phần "Điểm nổi bật" (chỉ tên món) và thẻ link menu ngoài không phải menu chữ.
      const items = menuItemsIn(menuRegion(main)).filter((it) => it.price);
      if (items.length) categories.push({ section: "Thực đơn", items });
    }

    if (categories.length) {
      const items = categories.reduce((n, c) => n + c.items.length, 0);
      const priced = categories.reduce((n, c) => n + c.items.filter((it) => it.price).length, 0);
      // Báo rõ khi có nhóm món không đọc được (trang đổi giữa chừng / hết giờ) để không coi menu thiếu là đủ.
      const groups = chips.length ? `${categories.length}/${chips.length} nhóm` : `${categories.length} nhóm`;
      return { ok: true, source: "script", data: { categories, menuPhotosOnly: false }, detail: `${items} món trong ${groups}, ${priced} món có giá`, steps };
    }

    if (chips.length) {
      // Có nhóm món mà không đọc được món nào → giao diện đổi, nhờ AI đọc.
      steps.push({ action: "trigger_ai_fallback", target: "menu" });
      const aiResult = await runAiFallback("menu");
      return {
        ok: aiResult.ok,
        source: "ai",
        data: aiResult.data || { categories: [], menuPhotosOnly: false },
        steps: [...steps, ...(aiResult.steps || [])],
        error: aiResult.error,
      };
    }

    // Tab Thực đơn chỉ có món nổi bật / ảnh / link menu ngoài: hồ sơ không có menu chữ.
    const labels = Array.from(main.querySelectorAll("[aria-label]")).map((e) => e.getAttribute("aria-label") || "").join(" | ");
    const hasLink = /liên kết menu|menu link/i.test(labels);
    return {
      ok: true,
      source: "script",
      data: { categories: [], menuPhotosOnly: false, noTextMenu: true },
      detail: hasLink ? "Không có menu chữ trên Maps (chỉ có món nổi bật + link menu ngoài)" : "Không có menu chữ trên Maps (chỉ có món nổi bật/ảnh)",
      steps,
    };
  } catch (err) {
    return { ok: false, source: "script", error: err.message, steps };
  }
}

/** h2 gần nhất đứng trước phần tử (tên nhóm tiện ích). */
function headingBefore(el, main) {
  let found = "";
  for (const h of main.querySelectorAll("h2")) {
    if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) found = norm(h.textContent);
    else break;
  }
  return found;
}

/**
 * Thu thập tiện ích & dịch vụ (Attributes từ tab About / Giới thiệu)
 */
async function collectAttributes() {
  const steps = [];
  try {
    const main = await waitForPlace();
    if (!main) return { ok: false, source: "script", error: "Không mở được hồ sơ quán trên Maps", steps };
    const tab = await openMainTab(/^(giới\s*thiệu|about)\b/i);
    if (!tab) return { ok: true, source: "script", data: { available: [], unavailable: [] }, detail: "Hồ sơ không có tab Giới thiệu", steps };
    steps.push({ action: "click_tab", label: "Giới thiệu" });

    const available = [];
    const unavailable = [];
    const seen = new Set();
    for (const li of main.querySelectorAll("li")) {
      const span = li.querySelector("[aria-label]");
      const aria = norm(span?.getAttribute("aria-label"));
      const label = norm(span?.textContent);
      if (!aria || !label) continue;
      const group = headingBefore(li, main);
      const key = `${group}|${label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Maps ghi rõ trong aria-label: "Có …", "Phục vụ …" = có; "Không có …", "Không phục vụ …" = không có.
      if (/^(không|chưa|no|not|doesn't|does not)\b/i.test(aria)) unavailable.push({ group, label });
      else available.push({ group, label });
    }

    if (available.length || unavailable.length) {
      return { ok: true, source: "script", data: { available, unavailable }, steps };
    }

    steps.push({ action: "trigger_ai_fallback", target: "attributes" });
    const aiResult = await runAiFallback("attributes");
    return {
      ok: aiResult.ok,
      source: "ai",
      data: aiResult.data || { available: [], unavailable: [] },
      steps: [...steps, ...(aiResult.steps || [])],
      error: aiResult.error,
    };
  } catch (err) {
    return { ok: false, source: "script", error: err.message, steps };
  }
}

/**
 * Thu thập Giờ đặc biệt (Special hours / Holiday hours)
 * Maps chỉ hiện giờ lễ của các ngày lễ sắp tới trong bảng giờ 7 ngày — không thấy không có nghĩa là quán không khai báo.
 */
async function collectSpecialHours() {
  const steps = [];
  try {
    const main = await waitForPlace();
    if (!main) return { ok: false, source: "script", error: "Không mở được hồ sơ quán trên Maps", steps };
    await openMainTab(/^(tổng\s*quan|overview)\b/i);
    await waitFor(() => main.querySelector("table"), 3000);
    const table = main.querySelector("table");
    if (!table) {
      return { ok: true, source: "script", data: [], detail: "Hồ sơ không có bảng giờ mở cửa", steps };
    }
    const specialHours = [];
    for (const tr of table.querySelectorAll("tr")) {
      const cells = Array.from(tr.querySelectorAll("td, th")).map((c) => norm(c.textContent)).filter(Boolean);
      const line = cells.join(": ");
      if (/\(|có thể khác|might differ|giờ lễ|ngày lễ|holiday|tết|giáng sinh/i.test(line) && !specialHours.includes(line)) specialHours.push(line);
    }
    steps.push({ action: "read_hours_table", rows: table.querySelectorAll("tr").length, special: specialHours.length });
    return {
      ok: true,
      source: "script",
      data: specialHours,
      detail: specialHours.length ? undefined : "Tuần này không có ngày lễ trong bảng giờ (Maps chỉ hiện giờ lễ sắp tới)",
      steps,
    };
  } catch (err) {
    return { ok: false, source: "script", error: err.message, steps };
  }
}

/**
 * Lắng nghe thông điệp từ background hoặc popup
 */
// Báo tiến trình từng mục về background → web (hiện checklist khi thu thập).
var reportProgress = (section, status, detail) => {
  try { chrome.runtime.sendMessage({ type: "diaba:progress", section, status, detail }); } catch { /* background đã đóng */ }
};
// Mỗi mục có hạn riêng (menu nhiều nhóm món cần lâu hơn); hết giờ thì đặt cờ để vòng đọc/AI dừng bấm tiếp.
var SECTION_TIMEOUT_MS = { menu: 90000, attributes: 40000, special_hours: 30000 };
var withDeadline = (section, promise) => Promise.race([
  promise,
  wait(SECTION_TIMEOUT_MS[section] || 40000).then(() => {
    window.__diabaStop = { ...(window.__diabaStop || {}), [section]: true };
    return { ok: false, error: `Quá ${(SECTION_TIMEOUT_MS[section] || 40000) / 1000}s chưa xong` };
  }),
]);
var summarize = (section, data, source) => {
  const via = source === "ai" ? " (AI)" : "";
  if (section === "menu") {
    const items = (data.categories || []).flatMap((c) => c.items || []);
    if (!items.length && data.menuPhotosOnly) return `Chỉ có ảnh thực đơn, không có menu chữ${via}`;
    if (!items.length) return `Không có menu chữ trên Maps${via}`;
    const priced = items.filter((it) => it.price).length;
    return `${items.length} món trong ${(data.categories || []).length} nhóm, ${priced} món có giá${via}`;
  }
  if (section === "attributes") return `${(data.available || []).length} có, ${(data.unavailable || []).length} không có${via}`;
  return `${(data || []).length} mốc giờ đặc biệt${via}`;
};

if (!window.__diabaContentLoaded) {
window.__diabaContentLoaded = true;
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "COLLECT_DATA") {
    const missing = request.missing || ["menu", "attributes", "special_hours"];
    window.__diabaStop = {};

    (async () => {
      const data = {};
      const steps = [];
      const errors = [];
      const sections = [
        ["menu", collectMenu, "Menu"],
        ["attributes", collectAttributes, "Attributes"],
        ["special_hours", collectSpecialHours, "Special Hours"],
      ];

      for (const [section, collect, label] of sections) {
        if (!missing.includes(section)) continue;
        reportProgress(section, "running", "Script đang đọc trang…");
        const res = await withDeadline(section, collect());
        if (res.ok && res.data) {
          if (section === "menu") data.menu = { ...res.data, source: res.source };
          else if (section === "attributes") data.attributes = { ...res.data, source: res.source };
          else { data.special_hours = res.data; data.special_hours_source = res.source; }
          reportProgress(section, "done", res.detail || summarize(section, res.data, res.source));
        } else {
          errors.push(`${label}: ${res.error || "không lấy được"}`);
          reportProgress(section, "failed", res.error || "Không lấy được");
        }
        if (res.steps) steps.push(...res.steps);
      }

      sendResponse({
        ok: errors.length === 0 || Object.keys(data).length > 0,
        data,
        steps,
        errors,
      });
    })();

    return true; // Giữ kết nối async
  }
});
}
