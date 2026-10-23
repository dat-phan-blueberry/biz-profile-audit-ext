// Smoke test bộ đọc Maps — chạy trước mỗi lần đẩy tag release.
//
// Mặc định: chạy SCRIPT (extension/content.js) theo đúng thứ tự khi sale bấm thu thập (menu → tiện ích → giờ đặc biệt)
// trên các quán trong smoke-places.json; thiếu số liệu so với ngưỡng → exit 1.
// --ai : sau script, tải lại trang và cho AI AGENT (extension/ai-fallback.js) tự làm từng mục KHÔNG có script hỗ trợ,
//        gọi AI Gateway thật bằng token ngắn hạn; AI phải đạt ≥ 70% số mục script đọc được. Chứng minh khi Google đổi
//        giao diện làm script gãy, AI vẫn hoàn thành việc.
// --slow: giảm tốc CPU 4 lần để giả máy chậm.
//
// Cần: playwright-core (NODE_PATH trỏ tới node_modules có nó), Chrome, profile Chrome ĐÃ ĐĂNG NHẬP Google (sao chép ra
// chỗ khác, không dùng profile đang mở). Với --ai: ENV_FILE=<.env của web Địa Bạ> có AI_GATEWAY_URL, GATEWAY_TOKEN_SECRET.
//   PROFILE=<profile> node scripts/smoke-maps.cjs [--slow]
//   PROFILE=<profile> ENV_FILE=<.env> node scripts/smoke-maps.cjs --ai [--only "Tên quán"]
const { chromium } = require("playwright-core");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PROFILE = process.env.PROFILE;
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SLOW = process.argv.includes("--slow");
const AI = process.argv.includes("--ai");
const ONLY = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const AI_SECTIONS = (process.env.SECTIONS || "menu,attributes,special_hours").split(",");
const AI_MIN_RATIO = 0.7;
if (!PROFILE) { console.error("Đặt PROFILE=<thư mục profile Chrome đã đăng nhập Google>"); process.exit(2); }

const places = JSON.parse(fs.readFileSync(path.join(__dirname, "smoke-places.json"), "utf8")).filter((p) => !ONLY || p.query === ONLY);
const content = fs.readFileSync(path.join(ROOT, "extension", "content.js"), "utf8");
const agent = fs.readFileSync(path.join(ROOT, "extension", "ai-fallback.js"), "utf8");
// Chạy trong một hàm riêng (không đè biến toàn cục của Maps), bỏ qua listener của extension, tiến trình in ra console.
const BUNDLE = `(function () {
window.__diabaContentLoaded = true; window.__diabaStop = {};
${agent}
${content}
reportProgress = (section, status, detail) => console.log("[progress]", section, status, detail || "");
window.__diabaSmoke = { collectMenu, collectAttributes, collectSpecialHours, runAiAgent };
})();`;

function gatewayEnv() {
  const file = process.env.ENV_FILE;
  if (!file) { console.error("--ai cần ENV_FILE=<.env của web Địa Bạ>"); process.exit(2); }
  const env = Object.fromEntries(fs.readFileSync(file, "utf8").split(/\r?\n/)
    .filter((l) => /^(AI_GATEWAY_URL|GATEWAY_TOKEN_SECRET)=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "").trim()]));
  if (!env.AI_GATEWAY_URL || !env.GATEWAY_TOKEN_SECRET) { console.error("ENV_FILE thiếu AI_GATEWAY_URL hoặc GATEWAY_TOKEN_SECRET"); process.exit(2); }
  return { url: env.AI_GATEWAY_URL.replace(/\/+$/, ""), secret: env.GATEWAY_TOKEN_SECRET };
}

// Cùng định dạng token với web Địa Bạ (src/lib/gateway-token.ts) — gateway kiểm bằng GATEWAY_TOKEN_SECRET.
function signToken(secret) {
  const body = Buffer.from(JSON.stringify({ svc: "dia-ba-smoke", scope: ["/v1/llm/chat"], exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url");
  return `gwt.${body}.${crypto.createHmac("sha256", secret).update(body).digest("base64url")}`;
}

async function openPlace(page, query) {
  await page.goto(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}&hl=vi`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.evaluate(BUNDLE); // qua CDP, không bị CSP của Maps chặn như thẻ <script>
}

const count = {
  menu: (d) => (d?.categories || []).reduce((n, c) => n + (c.items?.length || 0), 0),
  attributes: (d) => (d?.available?.length || 0) + (d?.unavailable?.length || 0),
  special_hours: (d) => (Array.isArray(d) ? d.length : 0),
};

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, { executablePath: CHROME, headless: false, viewport: { width: 1300, height: 900 }, locale: "vi-VN" });
  const page = ctx.pages()[0] || await ctx.newPage();
  if (SLOW) await (await ctx.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: 4 });
  let aiCalls = 0;
  if (AI) {
    const gw = gatewayEnv();
    page.on("console", (m) => { if (m.text().startsWith("[progress]")) console.log("    " + m.text().slice(11, 160)); });
    await page.exposeFunction("__diabaLlmCall", async (body) => {
      aiCalls++;
      try {
        const r = await fetch(`${gw.url}/v1/llm/chat`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${signToken(gw.secret)}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(35000) });
        const data = await r.json().catch(() => null);
        if (r.ok) return { ok: true, data };
        const ra = Number(data?.retryAfterSeconds ?? r.headers.get("retry-after"));
        return { ok: false, status: r.status, error: String(data?.error || r.status), retryAfterSeconds: Number.isFinite(ra) ? ra : undefined, quotaPeriod: data?.quotaPeriod };
      } catch (e) {
        return { ok: false, status: 0, error: e.message };
      }
    });
  }

  const rows = [];
  for (const p of places) {
    const t0 = Date.now();
    await openPlace(page, p.query);
    const s = await page.evaluate(async () => {
      const { collectMenu, collectAttributes, collectSpecialHours } = window.__diabaSmoke;
      const menu = await collectMenu();
      const attributes = await collectAttributes();
      const special_hours = await collectSpecialHours();
      const pick = (r) => ({ ok: r.ok && !r.needsAi, data: r.data, detail: r.detail || r.error || "", verify: !!r.verify });
      return { menu: pick(menu), attributes: pick(attributes), special_hours: pick(special_hours), diag: attributes.diag || menu.diag };
    });
    const fails = [];
    const sc = { menu: count.menu(s.menu.data), attributes: count.attributes(s.attributes.data), special_hours: count.special_hours(s.special_hours.data) };
    if (sc.attributes < (p.minAttributes || 1)) fails.push(`script: tiện ích ${sc.attributes} < ${p.minAttributes || 1}`);
    if (p.minMenuItems && sc.menu < p.minMenuItems) fails.push(`script: món ${sc.menu} < ${p.minMenuItems}`);
    console.log(`• ${p.query}\n  script (${Math.round((Date.now() - t0) / 1000)}s): menu ${s.menu.detail} · tiện ích ${sc.attributes} · giờ ${s.special_hours.detail}`);
    if (fails.length && s.diag) console.log("    chẩn đoán:", JSON.stringify(s.diag).slice(0, 600));

    if (AI) {
      for (const section of AI_SECTIONS) {
        const t1 = Date.now();
        const calls0 = aiCalls;
        await openPlace(page, p.query); // trang mới, AI tự làm từ đầu
        const r = await page.evaluate(async (sec) => {
          const res = await window.__diabaSmoke.runAiAgent(sec, { hint: "smoke test: script bị tắt" });
          return { ok: res.ok, data: res.data, detail: res.detail || res.error, steps: (res.steps || []).slice(-8) };
        }, section);
        const n = count[section](r.data);
        const base = sc[section];
        let verdict = r.ok;
        if (section === "special_hours") verdict = r.ok && n === base;
        else if (base > 0) verdict = r.ok && n >= Math.ceil(base * AI_MIN_RATIO);
        else verdict = r.ok;
        if (!verdict) fails.push(`AI ${section}: ${n} so với script ${base} (${r.detail})`);
        console.log(`  AI ${section} (${Math.round((Date.now() - t1) / 1000)}s, ${aiCalls - calls0} lượt AI): ${verdict ? "✓" : "✕"} ${n} mục (script ${base}) — ${r.detail}`);
        if (!verdict) console.log("    các bước cuối:", r.steps.join(" | ").slice(0, 400));
      }
    }
    rows.push({ place: p.query, ok: !fails.length, fails });
    if (fails.length) console.log(`  ✕ THIẾU: ${fails.join("; ")}`);
  }
  await ctx.close();
  const failed = rows.filter((r) => !r.ok).length;
  console.log(`\n${rows.length - failed}/${rows.length} quán đạt${SLOW ? " (CPU chậm x4)" : ""}${AI ? ` — AI agent, ${aiCalls} lượt AI` : ""}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("Smoke test lỗi:", e.message); process.exit(1); });
