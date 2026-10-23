// Chọn version phát hành cho workflow Release (chạy trên GitHub Actions khi push lên main có đổi extension/).
// - manifest.json đã được nâng cao hơn tag mới nhất (dev tự đặt, vd 1.2.0) → phát hành đúng version đó.
// - Ngược lại → tự tăng patch so với tag mới nhất (1.1.1 → 1.1.2) và ghi vào manifest (workflow commit lại).
// In ra cho $GITHUB_OUTPUT: version=…, bumped=true|false, previous=vX.Y.Z|.
// Thử ở máy (không cần git): TAGS="v1.1.0 v1.1.1" node scripts/next-version.mjs --dry-run
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST = join(ROOT, "extension", "manifest.json");
const DRY = process.argv.includes("--dry-run");

const parse = (v) => (/^v?(\d+)\.(\d+)\.(\d+)$/.exec(v || "") || []).slice(1).map(Number);
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const tagList = process.env.TAGS !== undefined
  ? process.env.TAGS.split(/\s+/)
  : execFileSync("git", ["tag", "--list", "v*"], { cwd: ROOT, encoding: "utf8" }).split(/\r?\n/);
const tags = tagList.map(parse).filter((t) => t.length === 3).sort(cmp);
const latest = tags.at(-1) || null;

const manifestText = readFileSync(MANIFEST, "utf8");
const current = parse(JSON.parse(manifestText).version);
if (current.length !== 3) {
  console.error(`manifest.json có version không đúng dạng X.Y.Z: ${JSON.parse(manifestText).version}`);
  process.exit(1);
}

let next = current;
let bumped = false;
if (latest && cmp(current, latest) <= 0) {
  next = [latest[0], latest[1], latest[2] + 1];
  bumped = true;
}
const version = next.join(".");

if (bumped && !DRY) {
  // Chỉ thay đúng chuỗi version, giữ nguyên định dạng file (key, thứ tự trường…).
  writeFileSync(MANIFEST, manifestText.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`));
}

console.log(`version=${version}`);
console.log(`bumped=${bumped}`);
console.log(`previous=${latest ? `v${latest.join(".")}` : ""}`);
