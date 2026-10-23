/**
 * AI agent điều khiển trang Google Maps cho Địa Bạ — như một browser MCP thu nhỏ.
 *
 * Script trong content.js chỉ là đường tắt cho nhanh. Khi script gãy (Google đổi giao diện), không chắc, hoặc kết luận
 * "không có", agent này phải làm xong việc: nhìn trang (bản chụp có đánh số phần tử), bấm / cuộn / chờ, đọc nội dung
 * bằng một lượt AI trích dữ liệu riêng, kiểm kết quả có thật trên trang rồi mới trả về.
 *
 * Chỉ dừng khi: hết quota AI trong ngày, cấu hình AI sai (không tự sửa được), hoặc phiên bị huỷ / hết thời gian.
 * Hết lượt theo phút (429) thì chờ đúng thời gian gateway báo rồi làm tiếp.
 */

var AGENT_MAX_STEPS = 40;
/** Lượt điều hướng: tối đa 80 phần tử bấm được + 1.200 ký tự nội dung (giới hạn token/phút của gói free). */
var AGENT_MAX_REFS = 80;
var AGENT_TEXT_PREVIEW = 1200;
/** Lượt trích dữ liệu: chia nội dung thành từng khúc ~3.500 ký tự (khúc lớn dễ bị cắt câu trả lời → mất món). */
var AGENT_EXTRACT_CHUNK = 3500;
/** Cầu dao: tối đa 80 lượt AI mỗi mục (bình thường menu ~13–25, tiện ích ~4, giờ ~6) — chặn vòng lặp lỗi đốt quota. */
var AGENT_MAX_CALLS = 80;
/** Mỗi lượt gọi AI cách nhau ≥ 2s (kể cả khi thử lại). */
var AGENT_MIN_GAP_MS = 2000;
var agentLastCallAt = 0;

var agentNorm = (s) => (s || "").replace(/\s+/g, " ").trim();
var agentFold = (s) => agentNorm(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d");

/** Chờ bằng đồng hồ của background khi có thể: tab chạy ngầm bị Chrome bóp setTimeout khi ẩn lâu. */
async function agentSleep(ms) {
  const until = Date.now() + ms;
  try {
    if (typeof chrome !== "undefined" && chrome.runtime?.id && !window.__diabaLlmCall) {
      await chrome.runtime.sendMessage({ type: "diaba:sleep", ms });
    }
  } catch { /* background không trả lời → dùng setTimeout */ }
  // Background cũ / không đếm giờ thì trả về ngay: luôn chờ bù cho đủ, không bao giờ "chờ 0 giây".
  const left = until - Date.now();
  if (left > 0) await new Promise((r) => setTimeout(r, left));
}

function agentError(message, kind) {
  const e = new Error(message);
  e.kind = kind; // "quota" | "config" | "stopped"
  return e;
}

/* ---------- Gọi AI (qua web Địa Bạ → AI Gateway), tự chờ khi bị giới hạn theo phút ---------- */
async function agentLlm(ctx, messages, maxTokens) {
  const body = { messages, response_format: { type: "json_object" }, temperature: 0, reasoning_effort: "low", max_tokens: maxTokens };
  let transient = 0;
  for (;;) {
    ctx.checkStop();
    if (ctx.attempts >= AGENT_MAX_CALLS) throw agentError(`Vượt ${AGENT_MAX_CALLS} lượt gọi AI cho mục này (chặn vòng lặp lỗi)`, "budget");
    const gap = agentLastCallAt + AGENT_MIN_GAP_MS - Date.now();
    if (gap > 0) await agentSleep(gap);
    agentLastCallAt = Date.now();
    let res;
    try {
      // Không chạy đua với đồng hồ: chờ request trả về (web huỷ sau 30s, background sau 33s) rồi mới gọi lượt mới —
      // tránh bắn request mới khi request cũ vẫn đang tới provider.
      res = typeof window.__diabaLlmCall === "function"
        ? await window.__diabaLlmCall(body) // smoke test chạy ngoài extension
        : await chrome.runtime.sendMessage({ type: "diaba:llm_chat", body });
    } catch (err) {
      res = { ok: false, status: 0, error: err.message };
    }
    // Lượt bị chặn 429 (gateway không gọi provider) không tính vào cầu dao: chờ quota không phải vòng lặp lỗi.
    if (res?.status !== 429) ctx.attempts++;
    if (res?.ok) {
      ctx.calls++;
      const content = res.data?.choices?.[0]?.message?.content || "";
      try { return JSON.parse(content); } catch { /* có model (qua 9router) bọc JSON trong ```json … ``` hoặc thêm chữ */ }
      const block = content.match(/\{[\s\S]*\}/);
      try { if (block) return JSON.parse(block[0]); } catch { /* vẫn không phải JSON */ }
      return { __invalid: content.slice(0, 300) };
    }
    if (res?.status === 429 && res.quotaPeriod === "day") throw agentError("Hết quota AI trong ngày", "quota");
    if (res?.status === 429) {
      const secs = Math.min(Math.max(Number(res.retryAfterSeconds) || 20, 2), 120);
      for (let left = secs; left > 0; left -= 5) {
        ctx.progress(`Chờ quota AI ${left}s… (bước ${ctx.step})`);
        await agentSleep(Math.min(5, left) * 1000);
        ctx.checkStop();
      }
      continue;
    }
    if ([400, 401, 403].includes(res?.status) && !/token/i.test(res?.error || "")) {
      throw agentError(`Cấu hình AI lỗi: ${res?.error || res?.status}`, "config");
    }
    // Lỗi mạng / 5xx / quá thời gian / token hết hạn: thử lại với thời gian chờ tăng dần (tới khi phiên hết giờ).
    transient++;
    const backoff = Math.min(3000 * 2 ** Math.min(transient - 1, 4), 30000);
    ctx.progress(`AI lỗi tạm (${agentNorm(res?.error).slice(0, 60)}), thử lại sau ${Math.round(backoff / 1000)}s…`);
    await agentSleep(backoff);
  }
}

/* ---------- Nhìn trang: bản chụp có đánh số phần tử bấm được ---------- */
function agentRoot() {
  return document.querySelector('div[role="main"]') || document.body;
}

function agentSnapshot() {
  const refs = new Map();
  const actions = [];
  const lines = [];
  let n = 0;
  const INTERACTIVE = /^(button|tab|link|radio|checkbox|menuitem|option|switch|combobox|menuitemradio)$/;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };
  const walk = (el) => {
    if (!(el instanceof Element)) return;
    if (/^(SCRIPT|STYLE|NOSCRIPT|SVG|IMG|CANVAS|IFRAME|VIDEO)$/i.test(el.tagName)) return;
    if (el.getAttribute("aria-hidden") === "true" || !visible(el)) return;
    const tag = el.tagName;
    const role = el.getAttribute("role") || (tag === "BUTTON" ? "button" : tag === "A" && el.hasAttribute("href") ? "link" : tag === "INPUT" || tag === "SELECT" ? "input" : "");
    const aria = agentNorm(el.getAttribute("aria-label"));
    if (INTERACTIVE.test(role) || role === "input") {
      const name = (aria || agentNorm(el.innerText) || agentNorm(el.getAttribute("title")) || agentNorm(el.getAttribute("data-tooltip"))).slice(0, 90);
      const ref = `e${++n}`;
      refs.set(ref, el);
      const state = [
        el.getAttribute("aria-selected") === "true" && "đang chọn",
        el.getAttribute("aria-checked") === "true" && "đang bật",
        el.getAttribute("aria-expanded") === "true" && "đang mở",
        el.getAttribute("aria-expanded") === "false" && "đang thu gọn",
        el.disabled && "không bấm được",
      ].filter(Boolean).join(", ");
      const line = `[${ref}] ${role} "${name}"${state ? ` (${state})` : ""}`;
      actions.push(line);
      lines.push(line);
      return; // tên nút đã đại diện cho phần bên trong
    }
    if (/^H[1-6]$/.test(tag) || role === "heading") {
      lines.push(`# ${agentNorm(el.textContent).slice(0, 120)}`);
      return;
    }
    const own = agentNorm(Array.from(el.childNodes).filter((c) => c.nodeType === 3).map((c) => c.textContent).join(" "));
    // aria-label mang nghĩa mà chữ không có (vd: "Không có chỗ đỗ xe cho xe lăn" trong khi chữ chỉ là "Chỗ đỗ xe cho xe lăn").
    if (aria && agentFold(aria) !== agentFold(own)) lines.push(own ? `${own.slice(0, 300)} (aria: ${aria.slice(0, 120)})` : `(aria: ${aria.slice(0, 120)})`);
    else if (own) lines.push(own.slice(0, 300));
    for (const c of el.children) walk(c);
  };
  walk(agentRoot());
  const dedupe = (arr) => arr.filter((l, i) => l && l !== arr[i - 1]);
  const text = dedupe(lines).join("\n");
  return { refs, actions: actions.slice(0, AGENT_MAX_REFS), text, fold: agentFold(text) };
}

/** Bấm phần tử rồi chờ trang đổi (tối đa 5s). Trả về trang có đổi hay không. */
async function agentClick(ctx, el) {
  const root = agentRoot();
  let changed = false;
  const obs = new MutationObserver(() => { changed = true; });
  obs.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-selected", "aria-expanded", "aria-checked"] });
  el.scrollIntoView?.({ block: "center" });
  el.click();
  for (let t = 0; t < 25 && !changed; t++) await agentSleep(200);
  await agentSleep(changed ? 900 : 300); // để nội dung mới render xong
  obs.disconnect();
  ctx.checkStop();
  return changed;
}

function agentScroll(direction) {
  const root = agentRoot();
  const scrollers = [root, ...root.querySelectorAll("div")].filter((d) => d.scrollHeight > d.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(d).overflowY));
  const box = scrollers.sort((a, b) => b.clientHeight - a.clientHeight)[0];
  if (!box) return false;
  const before = box.scrollTop;
  box.scrollBy(0, (direction === "up" ? -1 : 1) * box.clientHeight * 0.85);
  return box.scrollTop !== before;
}

/* ---------- Mục tiêu & trích dữ liệu theo từng mục ---------- */
var AGENT_GOALS = {
  menu: {
    goal: "Thu thập THỰC ĐƠN DẠNG CHỮ của quán (tên món, mô tả, giá) ở tab Thực đơn/Menu. Thực đơn thường chia nhóm món dạng tab/chip (vd: Khai vị, Món chính) — phải đọc HẾT các nhóm, dùng read_each với tất cả nhóm. 'Điểm nổi bật', ảnh món, ảnh chụp thực đơn và link thực đơn ở trang ngoài KHÔNG phải thực đơn chữ.",
    tabHint: /thuc don|menu/,
    extract: 'Trích các MÓN ĂN/ĐỒ UỐNG trong phần thực đơn đang hiển thị. JSON: {"items":[{"name":"tên món","description":"mô tả nếu có","price":"giá đúng như hiển thị, không có thì \\"\\""}]}. Liệt kê TẤT CẢ món đang hiển thị, kể cả món không có giá hoặc không có mô tả (món trong combo/set cũng tính). Không lấy tên nhóm/tab, nút, tiêu đề trang, "Điểm nổi bật", chữ trên ảnh. Không có món thì {"items":[]}.',
  },
  attributes: {
    goal: "Thu thập TẤT CẢ tiện ích/thuộc tính ở tab Giới thiệu/About (các nhóm như Tùy chọn dịch vụ, Tiện nghi, Thanh toán...), kèm nhóm và quán CÓ hay KHÔNG có. Mở đúng tab rồi dùng read ngay (read đọc toàn bộ, không cần cuộn).",
    tabHint: /gioi thieu|about/,
    extract: 'Trích MỌI tiện ích/thuộc tính đang hiển thị, theo nhóm (dòng "# ..." đứng trước là tên nhóm). JSON: {"items":[{"group":"tên nhóm","label":"tên tiện ích như chữ hiển thị","available":true}]}. available=false khi aria/chữ cho biết KHÔNG có (vd "(aria: Không có ...)", "No ..."). Không lấy tên tab, nút, đánh giá. Không có thì {"items":[]}.',
  },
  special_hours: {
    goal: "Tìm GIỜ MỞ CỬA ĐẶC BIỆT (ngày lễ, Tết, giờ có thể khác) trong bảng giờ ở tab Tổng quan/Overview. Bảng giờ có thể đang thu gọn — bấm vào giờ mở cửa để mở. Ngay khi thấy giờ của các ngày trong tuần (Thứ Hai… Chủ Nhật), dùng read luôn. Bảng chỉ có giờ thường của 7 ngày = không có giờ đặc biệt.",
    tabHint: /tong quan|overview/,
    extract: 'Đọc bảng giờ mở cửa đang hiển thị. JSON: {"hoursTableSeen":true nếu thấy bảng giờ của các ngày trong tuần,"special":["dòng giờ đặc biệt, vd: Thứ Hai (Quốc khánh): Đóng cửa"]}. Chỉ đưa vào special các dòng ngày lễ / giờ khác thường / "có thể khác". Không thấy bảng giờ thì hoursTableSeen=false.',
  },
};

async function agentExtract(ctx, text, label) {
  const g = AGENT_GOALS[ctx.section];
  const chunks = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur.length + line.length > AGENT_EXTRACT_CHUNK && cur) { chunks.push(cur); cur = ""; }
    cur += `${line}\n`;
  }
  if (cur) chunks.push(cur);
  const out = { items: [], special: [], hoursTableSeen: false };
  for (let i = 0; i < chunks.length; i++) {
    ctx.progress(`AI đọc nội dung${label ? ` "${label}"` : ""} ${chunks.length > 1 ? `(${i + 1}/${chunks.length})` : ""}…`);
    const r = await agentLlm(ctx, [
      { role: "system", content: `Bạn trích dữ liệu có cấu trúc từ nội dung trang Google Maps (đã chụp thành dòng chữ; "[eN] ..." là nút, "# ..." là tiêu đề, "(aria: ...)" là nhãn trợ năng). Chỉ trích thứ CÓ trong nội dung, không bịa. Trả về đúng một JSON object.\n${g.extract}` },
      { role: "user", content: `${label ? `Nhóm đang hiển thị: ${label}\n` : ""}Nội dung:\n${chunks[i]}` },
    ], ctx.section === "menu" ? 3500 : 2500);
    if (Array.isArray(r?.items)) out.items.push(...r.items);
    if (Array.isArray(r?.special)) out.special.push(...r.special);
    if (r?.hoursTableSeen) out.hoursTableSeen = true;
  }
  return out;
}

/* ---------- Gộp & kiểm kết quả ---------- */
function agentMerge(ctx, extracted, label) {
  ctx.reads++;
  ctx.seen += `\n${agentFold(extracted.__source || "")}`;
  if (ctx.section === "menu") {
    const key = label || "Thực đơn";
    const list = ctx.menu.get(key) || [];
    for (const it of extracted.items) {
      const name = agentNorm(it?.name);
      if (!name || list.some((x) => x.name === name && x.price === agentNorm(it.price))) continue;
      list.push({ name, description: agentNorm(it.description), price: agentNorm(it.price) });
    }
    if (list.length) ctx.menu.set(key, list);
    return extracted.items.length;
  }
  if (ctx.section === "attributes") {
    let added = 0;
    for (const it of extracted.items) {
      const label2 = agentNorm(it?.label);
      if (!label2) continue;
      const k = `${agentNorm(it.group)}|${label2}`;
      if (ctx.attrs.has(k)) continue;
      ctx.attrs.set(k, { group: agentNorm(it.group), label: label2, available: it.available !== false });
      added++;
    }
    return added;
  }
  if (extracted.hoursTableSeen) ctx.hoursSeen = true;
  for (const s of extracted.special) if (agentNorm(s) && !ctx.special.includes(agentNorm(s))) ctx.special.push(agentNorm(s));
  return extracted.special.length;
}

/** Tỷ lệ mục AI trả về có thật trong nội dung đã đọc (chống AI bịa). */
function agentGrounded(ctx, labels) {
  if (!labels.length) return 1;
  const hit = labels.filter((l) => {
    const f = agentFold(l).slice(0, 40);
    return f && ctx.seen.includes(f);
  }).length;
  return hit / labels.length;
}

function agentClickedTab(ctx) {
  return ctx.clicked.some((name) => AGENT_GOALS[ctx.section].tabHint.test(agentFold(name)));
}

/** Kiểm khi AI muốn kết thúc. Trả { data, detail } nếu nhận; { feedback } nếu phải làm tiếp. */
function agentVerdict(ctx, snap) {
  const tabExists = Array.from(snap.refs.values()).some((el) => AGENT_GOALS[ctx.section].tabHint.test(agentFold(el.getAttribute("aria-label") || el.innerText)));
  if (ctx.section === "menu") {
    const cats = Array.from(ctx.menu, ([section, items]) => ({ section, items }));
    const items = cats.flatMap((c) => c.items);
    if (items.length) {
      const g = agentGrounded(ctx, items.map((i) => i.name));
      if (g < 0.7) return { feedback: `Chỉ ${Math.round(g * 100)}% món tìm thấy trong nội dung đã đọc — có thể trích nhầm. Hãy đọc lại (read/read_each) đúng phần thực đơn.` };
      return { data: { categories: cats, menuPhotosOnly: false }, detail: `${items.length} món trong ${cats.length} nhóm, ${items.filter((i) => i.price).length} món có giá (AI)` };
    }
    if (ctx.reads >= 1 && (agentClickedTab(ctx) || !tabExists)) return { data: { categories: [], menuPhotosOnly: false, noTextMenu: true }, detail: "Không có menu chữ trên Maps (AI đã kiểm)" };
    return { feedback: tabExists ? "Chưa mở tab Thực đơn/Menu và đọc nội dung. Hãy bấm tab đó rồi read/read_each." : "Chưa đọc nội dung trang (read) để chắc chắn." };
  }
  if (ctx.section === "attributes") {
    const all = Array.from(ctx.attrs.values());
    if (all.length) {
      const g = agentGrounded(ctx, all.map((a) => a.label));
      if (g < 0.7) return { feedback: `Chỉ ${Math.round(g * 100)}% tiện ích tìm thấy trong nội dung đã đọc — đọc lại đúng tab Giới thiệu.` };
      return {
        data: {
          available: all.filter((a) => a.available).map(({ group, label }) => ({ group, label })),
          unavailable: all.filter((a) => !a.available).map(({ group, label }) => ({ group, label })),
        },
        detail: `${all.filter((a) => a.available).length} có, ${all.filter((a) => !a.available).length} không có (AI)`,
      };
    }
    if (ctx.reads >= 1 && (agentClickedTab(ctx) || !tabExists)) return { data: { available: [], unavailable: [] }, detail: "Hồ sơ không có tiện ích nào (AI đã kiểm)" };
    return { feedback: tabExists ? "Chưa mở tab Giới thiệu/About và đọc nội dung. Hãy bấm tab đó rồi read." : "Chưa đọc nội dung trang (read)." };
  }
  if (ctx.hoursSeen) return { data: ctx.special, detail: ctx.special.length ? `${ctx.special.length} mốc giờ đặc biệt (AI)` : "Tuần này không có ngày lễ trong bảng giờ (AI đã kiểm)" };
  return { feedback: "Chưa thấy bảng giờ mở cửa. Ở tab Tổng quan, bấm vào giờ mở cửa để mở bảng giờ rồi read." };
}

/* ---------- Vòng lặp agent ---------- */
var AGENT_SYSTEM = `Bạn là agent điều khiển trình duyệt trên trang Google Maps của MỘT quán (đã đăng nhập). Mỗi lượt bạn nhận bản chụp trang:
- "[eN] role \\"tên\\" (trạng thái)" là phần tử bấm được, gọi theo eN.
- "# ..." là tiêu đề; "(aria: ...)" là nhãn trợ năng.
Trả về ĐÚNG MỘT JSON object, chọn một hành động:
{"action":"click","ref":"eN"}                       bấm một phần tử (tab, nút, nhóm...)
{"action":"read"}                                   trích dữ liệu từ TOÀN BỘ nội dung đang hiển thị (không bị cắt)
{"action":"read_each","refs":["eA","eB"],"labels":["tên A","tên B"]}  bấm lần lượt từng mục rồi trích dữ liệu sau mỗi lần (dùng cho các nhóm món)
{"action":"scroll","direction":"down"}             cuộn khung nội dung (up/down) để tải thêm
{"action":"wait","ms":2000}                         chờ trang tải (tối đa 5000)
{"action":"more"}                                   xem thêm phần nội dung bị cắt của bản chụp
{"action":"finish"}                                 kết thúc khi đã đọc đủ (hệ thống sẽ kiểm, thiếu sẽ báo lại)
Quy tắc: làm việc đến khi xong mục tiêu, không bỏ cuộc. Bấm mà trang không đổi thì thử wait, scroll hoặc phần tử khác. Không bấm nút chia sẻ, chỉ đường, lưu, gọi, đặt bàn, đăng nhập, link mở trang khác.`;

async function runAiAgent(section, opts = {}) {
  const stopKey = `ai:${section}`;
  const ctx = {
    section, step: 0, calls: 0, attempts: 0, reads: 0, seen: "", clicked: [], log: [],
    menu: new Map(), attrs: new Map(), special: [], hoursSeen: false,
    progress: (detail) => { if (typeof reportProgress === "function") reportProgress(section, "running", detail); },
    checkStop: () => { if (window.__diabaStop?.[stopKey]) throw agentError("Dừng vì hết thời gian của phiên", "stopped"); },
  };
  const g = AGENT_GOALS[section];
  let feedback = opts.hint ? `Script tự động đã thất bại: ${opts.hint}. Bạn phải tự làm.` : "";
  if (opts.verifyClaim) feedback = `Script kết luận: "${opts.verifyClaim}". Hãy kiểm tra lại trên trang (mở đúng tab, đọc nội dung) rồi finish.`;
  let textOffset = 0;
  let lastFold = "";
  try {
    for (ctx.step = 1; ctx.step <= AGENT_MAX_STEPS; ctx.step++) {
      ctx.checkStop();
      const snap = agentSnapshot();
      if (snap.fold !== lastFold) { textOffset = 0; lastFold = snap.fold; }
      const preview = snap.text.slice(textOffset, textOffset + AGENT_TEXT_PREVIEW);
      const summary = section === "menu"
        ? `${Array.from(ctx.menu.values()).flat().length} món trong ${ctx.menu.size} nhóm (${Array.from(ctx.menu.keys()).join(", ").slice(0, 300) || "chưa có"})`
        : section === "attributes" ? `${ctx.attrs.size} tiện ích` : `${ctx.hoursSeen ? "đã thấy bảng giờ" : "chưa thấy bảng giờ"}, ${ctx.special.length} mốc đặc biệt`;
      ctx.progress(`AI bước ${ctx.step}: đang xem trang…`);
      const action = await agentLlm(ctx, [
        { role: "system", content: AGENT_SYSTEM },
        {
          role: "user",
          content: `MỤC TIÊU: ${g.goal}\nĐÃ LÀM: ${ctx.log.slice(-12).join(" | ") || "(chưa)"}\nDỮ LIỆU ĐÃ CÓ: ${summary}\n${feedback ? `PHẢN HỒI HỆ THỐNG: ${feedback}\n` : ""}\nPHẦN TỬ BẤM ĐƯỢC:\n${snap.actions.join("\n")}\n\nNỘI DUNG (${textOffset}-${textOffset + preview.length}/${snap.text.length} ký tự):\n${preview}`,
        },
      ], 1000);
      feedback = "";
      const act = action?.action;
      if (action?.__invalid || !act) { feedback = "Phản hồi trước không phải JSON hợp lệ theo mẫu. Trả về đúng một JSON object."; continue; }

      if (act === "click") {
        const el = snap.refs.get(action.ref);
        if (!el) { feedback = `Không có phần tử ${action.ref} trong bản chụp hiện tại.`; continue; }
        const name = agentNorm(el.getAttribute("aria-label") || el.innerText).slice(0, 60);
        ctx.progress(`AI bước ${ctx.step}: bấm "${name}"`);
        const changed = await agentClick(ctx, el);
        ctx.clicked.push(name);
        ctx.log.push(`bấm "${name}" → ${changed ? "trang đổi" : "trang KHÔNG đổi"}`);
        continue;
      }
      if (act === "read" || act === "read_each") {
        const targets = act === "read_each" && Array.isArray(action.refs) ? action.refs : [null];
        let total = 0;
        for (let i = 0; i < targets.length; i++) {
          ctx.checkStop();
          let label = act === "read_each" ? agentNorm(action.labels?.[i]) : "";
          if (targets[i]) {
            // Phần tử đã đánh số có thể bị Maps vẽ lại sau lần bấm trước → tìm lại theo đúng tên.
            const orig = snap.refs.get(targets[i]);
            const name = orig ? agentNorm(orig.getAttribute("aria-label") || orig.innerText) : "";
            let el = orig?.isConnected ? orig : null;
            if (!el && name) el = Array.from(agentSnapshot().refs.values()).find((e) => agentNorm(e.getAttribute("aria-label") || e.innerText) === name) || null;
            if (!el) { ctx.log.push(`không thấy ${targets[i]}`); continue; }
            label = label || name.slice(0, 60);
            ctx.progress(`AI đọc nhóm ${i + 1}/${targets.length}: ${label}`);
            await agentClick(ctx, el);
            ctx.clicked.push(label);
          }
          const now = agentSnapshot();
          const extracted = await agentExtract(ctx, now.text, label);
          extracted.__source = now.text;
          const got = agentMerge(ctx, extracted, label || (section === "menu" ? "Thực đơn" : ""));
          total += got;
          ctx.log.push(`đọc${label ? ` "${label}"` : ""} → ${got} mục`);
        }
        // Đã có dữ liệu hợp lệ thì kết thúc luôn, đỡ một lượt AI.
        if (total > 0 && (section !== "menu" || act === "read_each")) {
          const v = agentVerdict(ctx, agentSnapshot());
          if (v.data) return { ok: true, source: "ai", data: v.data, detail: v.detail, steps: ctx.log };
        }
        if (section === "special_hours" && ctx.hoursSeen) {
          const v = agentVerdict(ctx, agentSnapshot());
          if (v.data) return { ok: true, source: "ai", data: v.data, detail: v.detail, steps: ctx.log };
        }
        continue;
      }
      if (act === "scroll") {
        const moved = agentScroll(action.direction);
        await agentSleep(900);
        ctx.log.push(`cuộn ${action.direction === "up" ? "lên" : "xuống"} → ${moved ? "đã cuộn" : "không cuộn được"}`);
        continue;
      }
      if (act === "wait") {
        await agentSleep(Math.min(Math.max(Number(action.ms) || 1500, 300), 5000));
        ctx.log.push("chờ");
        continue;
      }
      if (act === "more") {
        if (textOffset + AGENT_TEXT_PREVIEW >= snap.text.length) feedback = "Đã xem hết nội dung bản chụp. Dùng read để trích dữ liệu, hoặc scroll để tải thêm.";
        else textOffset += AGENT_TEXT_PREVIEW;
        continue;
      }
      if (act === "finish" || act === "give_up" || act === "extract") {
        const v = agentVerdict(ctx, snap);
        if (v.data) return { ok: true, source: "ai", data: v.data, detail: v.detail, steps: ctx.log };
        feedback = v.feedback;
        ctx.log.push(`muốn kết thúc → bị từ chối: ${v.feedback.slice(0, 80)}`);
        continue;
      }
      feedback = `Hành động "${act}" không hợp lệ.`;
    }
    const v = agentVerdict(ctx, agentSnapshot());
    if (v.data) return { ok: true, source: "ai", data: v.data, detail: v.detail, steps: ctx.log };
    return { ok: false, source: "ai", error: `AI chưa xong sau ${AGENT_MAX_STEPS} bước (${v.feedback})`, steps: ctx.log };
  } catch (err) {
    // Trả phần đã đọc được nếu đủ điều kiện (vd: hết quota giữa chừng nhưng đã có dữ liệu hợp lệ).
    const v = agentVerdict(ctx, agentSnapshot());
    if (v.data && (ctx.menu.size || ctx.attrs.size || ctx.hoursSeen)) {
      return { ok: true, source: "ai", data: v.data, detail: `${v.detail} — dừng sớm: ${err.message}`, steps: ctx.log };
    }
    return { ok: false, source: "ai", error: err.message, errorKind: err.kind, steps: ctx.log };
  }
}

/** Tương thích chỗ gọi cũ. */
async function runAiFallback(section) {
  return runAiAgent(section);
}
