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

// runAiAgent do ai-fallback.js cung cấp (nạp trước file này trong cùng isolated world).
// Script ở đây chỉ là đường tắt: lỗi / ra 0 → needsAi; kết luận "không có" → verify (AI kiểm lại).

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
    // Maps có thể vẽ lại cả thanh tab → tìm lại tab theo tên thay vì giữ phần tử cũ.
    await waitFor(() => findMainTab(regex)?.getAttribute("aria-selected") === "true", 5000);
  }
  await wait(600);
  return findMainTab(regex) || tab;
}

/**
 * Tóm tắt cấu trúc panel khi một mục đọc lỗi (không lấy dữ liệu cá nhân, chỉ nội dung công khai của hồ sơ):
 * web hiện nút "Sao chép chẩn đoán" để dev sửa script đúng chỗ.
 */
function diagnose(section) {
  const main = placePane();
  if (!main) return { section, url: location.pathname.slice(0, 80), lang: document.documentElement.lang, error: "không có div[role=main]" };
  const uniq = (arr, n) => [...new Set(arr.filter(Boolean))].slice(0, n);
  return {
    section,
    url: location.pathname.slice(0, 80),
    lang: document.documentElement.lang,
    tabs: Array.from(main.querySelectorAll('[role="tab"]')).slice(0, 20).map((t) => `${norm(t.getAttribute("aria-label") || t.innerText).slice(0, 40)}${t.getAttribute("aria-selected") === "true" ? " *" : ""}`),
    headings: uniq(Array.from(main.querySelectorAll('h1, h2, h3, [role="heading"]')).map((h) => norm(h.textContent).slice(0, 50)), 20),
    regions: uniq(Array.from(main.querySelectorAll('[role="region"]')).map((r) => r.getAttribute("aria-label")), 10),
    li: main.querySelectorAll("li").length,
    liWithAria: Array.from(main.querySelectorAll("li")).filter((li) => li.querySelector("[aria-label]")).length,
    aria: uniq(Array.from(main.querySelectorAll("[aria-label]")).map((e) => `${e.tagName.toLowerCase()}:${norm(e.getAttribute("aria-label")).slice(0, 60)}`), 30),
    text: norm(main.innerText).slice(0, 600),
  };
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
    let main = await waitForPlace();
    if (!main) return { ok: false, source: "script", error: "Không mở được hồ sơ quán trên Maps", steps };
    const tab = await openMainTab(/^(thực\s*đơn|menu)\b/i);
    main = placePane() || main;
    if (!tab) {
      return { ok: true, verify: true, source: "script", data: { categories: [], noTextMenu: true }, detail: "Hồ sơ không có tab Thực đơn", steps };
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
        const before = norm(menuRegion(placePane() || main)?.innerText);
        chip.click();
        await waitFor(() => chip.getAttribute("aria-selected") === "true", 3000);
        await waitFor(() => norm(menuRegion(placePane() || main)?.innerText) !== before, 2500);
        await wait(400);
        const items = menuItemsIn(menuRegion(placePane() || main));
        steps.push({ action: "read_menu_section", section, items: items.length });
        if (items.length) categories.push({ section, items });
      }
    } else {
      // Không có nhóm món: chỉ nhận món có giá — phần "Điểm nổi bật" (chỉ tên món) và thẻ link menu ngoài không phải menu chữ.
      const items = menuItemsIn(menuRegion(placePane() || main)).filter((it) => it.price);
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
      // Có nhóm món mà không đọc được món nào → giao diện đổi, giao cho AI agent.
      return { ok: false, needsAi: true, source: "script", error: `Có ${chips.length} nhóm món nhưng script không đọc được món`, steps, diag: diagnose("menu") };
    }

    // Tab Thực đơn chỉ có món nổi bật / ảnh / link menu ngoài: hồ sơ không có menu chữ.
    const labels = Array.from(main.querySelectorAll("[aria-label]")).map((e) => e.getAttribute("aria-label") || "").join(" | ");
    const hasLink = /liên kết menu|menu link/i.test(labels);
    return {
      ok: true,
      verify: true,
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

// aria-label của tiện ích trên Maps: "Có …", "Không có …", "Phục vụ …", "Bán …", "Chấp nhận …" (hoặc tiếng Anh "Has …", "No …", "Serves …").
var ATTR_ARIA_RE = /^(có|không|chưa|phục vụ|bán|chấp nhận|nhận|cho phép|thích hợp|phù hợp|dành cho|has|have|no|not|serves|accepts|offers|doesn't|does not|good for|free|paid)\b/i;
var ATTR_NEGATIVE_RE = /^(không|chưa|no|not|doesn't|does not)\b/i;

/** Danh sách tiện ích trên tab Giới thiệu: ưu tiên li > [aria-label]; giao diện khác thì quét mọi [aria-label] dạng "Có …/Không có …". */
function attributeItems(main) {
  const out = [];
  const seen = new Set();
  const add = (el, aria, label) => {
    if (!aria || !label || label.length > 80) return;
    const group = headingBefore(el, main);
    const key = `${group}|${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ group, label, negative: ATTR_NEGATIVE_RE.test(aria) });
  };
  for (const li of main.querySelectorAll("li")) {
    const span = li.querySelector("[aria-label]");
    add(li, norm(span?.getAttribute("aria-label")), norm(span?.textContent));
  }
  if (out.length) return out;
  for (const el of main.querySelectorAll("[aria-label]")) {
    if (el.closest('button, a, [role="tab"], [role="button"], [role="link"]')) continue;
    const aria = norm(el.getAttribute("aria-label"));
    if (!ATTR_ARIA_RE.test(aria)) continue;
    add(el, aria, norm(el.textContent) || aria);
  }
  return out;
}

/**
 * Thu thập tiện ích & dịch vụ (Attributes từ tab About / Giới thiệu)
 */
async function collectAttributes() {
  const steps = [];
  try {
    if (!(await waitForPlace())) return { ok: false, source: "script", error: "Không mở được hồ sơ quán trên Maps", steps, diag: diagnose("attributes") };
    const tab = await openMainTab(/^(giới\s*thiệu|about)\b/i);
    if (!tab) return { ok: true, verify: true, source: "script", data: { available: [], unavailable: [] }, detail: "Hồ sơ không có tab Giới thiệu", steps };
    steps.push({ action: "click_tab", label: "Giới thiệu" });

    // Chờ nội dung tab thật sự xuất hiện (máy chậm / sau nhiều thao tác Maps tải chậm), luôn đọc panel mới nhất.
    let items = [];
    await waitFor(() => (items = attributeItems(placePane())).length > 0, 10000);
    steps.push({ action: "read_attributes", items: items.length });

    if (items.length) {
      return {
        ok: true,
        source: "script",
        data: {
          available: items.filter((i) => !i.negative).map(({ group, label }) => ({ group, label })),
          unavailable: items.filter((i) => i.negative).map(({ group, label }) => ({ group, label })),
        },
        steps,
      };
    }

    return { ok: false, needsAi: true, source: "script", error: "Script không đọc được tiện ích ở tab Giới thiệu", steps, diag: diagnose("attributes") };
  } catch (err) {
    return { ok: false, source: "script", error: err.message, steps, diag: diagnose("attributes") };
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
    await waitFor(() => placePane()?.querySelector("table"), 5000);
    const table = placePane()?.querySelector("table");
    if (!table) {
      return { ok: true, verify: true, source: "script", data: [], detail: "Hồ sơ không có bảng giờ mở cửa", steps };
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
var reportProgress = (section, status, detail, diag) => {
  try { chrome.runtime.sendMessage({ type: "diaba:progress", section, status, detail, diag }); } catch { /* background đã đóng */ }
};
// Hạn của script (đường tắt) — hết hạn thì giao cho AI agent, không coi là lỗi.
var SECTION_TIMEOUT_MS = { menu: 90000, attributes: 40000, special_hours: 30000 };
// Hạn của AI agent mỗi mục (gồm cả thời gian chờ quota theo phút). Chỉ để chặn treo vô hạn.
var AGENT_BUDGET_MS = { menu: 10 * 60000, attributes: 5 * 60000, special_hours: 4 * 60000 };
var withDeadline = (stopKey, promise, ms) => Promise.race([
  promise,
  wait(ms).then(() => {
    window.__diabaStop = { ...(window.__diabaStop || {}), [stopKey]: true };
    return { ok: false, timedOut: true, error: `Quá ${Math.round(ms / 1000)}s chưa xong` };
  }),
]);

/** Script trước; script lỗi / ra 0 / hết giờ → AI agent làm; script kết luận "không có" → AI kiểm lại. */
async function collectSection(section, collect) {
  // Options "Kiểm thử AI": bỏ qua script để kiểm AI agent tự làm được (Google đổi giao diện).
  const forceAi = await new Promise((r) => { try { chrome.storage.local.get("forceAi", (v) => r(!!v?.forceAi)); } catch { r(false); } });
  reportProgress(section, "running", forceAi ? "Kiểm thử AI: bỏ qua script…" : "Script đang đọc trang…");
  const script = forceAi
    ? { ok: false, needsAi: true, error: "kiểm thử AI (script bị tắt)", steps: [] }
    : await withDeadline(section, collect(), SECTION_TIMEOUT_MS[section]);
  const scriptOk = script.ok && script.data && !script.needsAi;
  if (scriptOk && !script.verify) return script;
  if (typeof runAiAgent !== "function") return scriptOk ? script : { ...script, diag: script.diag || diagnose(section) };

  reportProgress(section, "running", scriptOk
    ? `Script kết luận "${script.detail}" — AI kiểm tra lại…`
    : `Script không đọc được (${script.error || "không rõ"}) — AI tự làm…`);
  const ai = await withDeadline(`ai:${section}`, runAiAgent(section, scriptOk ? { verifyClaim: script.detail } : { hint: script.error }), AGENT_BUDGET_MS[section]);
  if (ai.ok && ai.data) return { ...ai, steps: [...(script.steps || []), ...(ai.steps || [])] };
  // AI không làm được (hết quota ngày / cấu hình sai / hết giờ): giữ kết luận của script nếu có, ghi rõ chưa được AI kiểm.
  if (scriptOk) return { ...script, detail: `${script.detail} (AI chưa kiểm được: ${ai.error})` };
  return { ok: false, source: "ai", error: `Script: ${script.error || "lỗi"}; AI: ${ai.error}`, steps: [...(script.steps || []), ...(ai.steps || [])], diag: script.diag || diagnose(section) };
}
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
        const res = await collectSection(section, collect);
        if (res.ok && res.data) {
          if (section === "menu") data.menu = { ...res.data, source: res.source };
          else if (section === "attributes") data.attributes = { ...res.data, source: res.source };
          else { data.special_hours = res.data; data.special_hours_source = res.source; }
          reportProgress(section, "done", res.detail || summarize(section, res.data, res.source));
        } else {
          errors.push(`${label}: ${res.error || "không lấy được"}`);
          reportProgress(section, "failed", res.error || "Không lấy được", res.diag || diagnose(section));
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
