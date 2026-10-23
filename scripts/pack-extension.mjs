// Đóng gói extension/ thành dist/diaba-extension-vX.Y.Z.zip để đính kèm GitHub Release.
// Workflow .github/workflows/release.yml gọi khi push lên main có đổi extension/; chạy tay: node scripts/pack-extension.mjs
// In ra đường dẫn file zip ở dòng cuối (workflow đọc). Không cần thư viện ngoài.
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "extension");
const VERSION = JSON.parse(readFileSync(join(SRC, "manifest.json"), "utf8")).version;
const OUT_DIR = join(ROOT, "dist");
const OUT = join(OUT_DIR, `diaba-extension-v${VERSION}.zip`);

// Tag phát hành phải khớp version trong manifest (web Địa Bạ so version extension báo về với version release).
const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
if (tag && tag !== `v${VERSION}`) {
  console.error(`[pack-extension] Tag ${tag} không khớp manifest version ${VERSION}`);
  process.exit(1);
}
// Zip phẳng (manifest.json ở gốc): "Giải nén tất cả" của Windows / Archive Utility của macOS tạo đúng một thư mục
// diaba-extension-vX.Y.Z chứa manifest → kéo thư mục đó vào trang tiện ích là cài được, không có thư mục lồng.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

// 01/01/1980 00:00 (ngày DOS hợp lệ nhỏ nhất; 0 là ngày không hợp lệ, Explorer có thể báo lỗi).
const DOS_TIME = (0x21 << 16) >>> 0;

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else files.push(full);
  }
};
walk(SRC);

const locals = [];
const centrals = [];
let offset = 0;
for (const full of files) {
  const name = Buffer.from(relative(SRC, full).split(sep).join("/"), "utf8");
  const data = readFileSync(full);
  const packed = deflateRawSync(data);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // tên file UTF-8
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(DOS_TIME, 10); // giờ/ngày cố định → zip giống hệt giữa các lần build
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  locals.push(local, name, packed);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(DOS_TIME, 12);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  centrals.push(central, name);
  offset += local.length + name.length + packed.length;
}
const centralSize = centrals.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, Buffer.concat([...locals, ...centrals, end]));
console.error(`[pack-extension] ${files.length} file, v${VERSION}`);
console.log(relative(ROOT, OUT).split(sep).join("/"));
