# Địa Bạ - Google Maps Profiler (extension)

**[⬇ Tải bản mới nhất](https://github.com/dat-phan-blueberry/biz-profile-audit-ext/releases/latest)**

Extension trình duyệt (Manifest V3, Chrome / Edge / Brave) chuyên dụng cho đội ngũ Sale và chuyên viên tư vấn GoDine nhằm thu thập các dữ liệu bổ sung bị Google Maps ẩn khi chưa đăng nhập (Menu chữ, Tab Giới thiệu / Tiện ích, Giờ đặc biệt).

## Kiến trúc: script là đường tắt, AI agent đảm bảo hoàn thành
1. **Script** (`extension/content.js`) đọc DOM Maps cho nhanh, không tốn AI. Script lỗi, hết giờ hoặc ra 0 → giao cho AI agent. Script kết luận "không có" (không menu chữ, không tab Giới thiệu, không bảng giờ) → AI kiểm lại.
2. **AI agent** (`extension/ai-fallback.js`) như một browser MCP thu nhỏ: nhìn trang qua bản chụp có đánh số phần tử (kèm `aria-label`), bấm / cuộn / chờ / đọc từng nhóm, một lượt AI riêng trích dữ liệu theo khúc, kiểm kết quả có thật trên trang; kết luận "không có" chỉ được nhận khi đã mở đúng tab và đọc. Chỉ dừng khi **hết quota AI trong ngày**, cấu hình AI sai, hoặc phiên bị huỷ (20 phút). Bị giới hạn theo phút (429) thì chờ đúng thời gian gateway báo rồi làm tiếp.
3. AI đi qua web Địa Bạ → AI Gateway bằng token ngắn hạn (extension không giữ key). Web chỉ báo lỗi khi extension im lặng quá 2 phút.
4. **Kiểm thử AI**: trang Options có ô "Kiểm thử AI: bỏ qua script" để bắt AI tự làm mọi mục.

---

## Cài đặt (sale)

Web Địa Bạ tự nhận khi chưa cài hoặc có bản mới, và hiện nút **Tải extension**, **Mở trang tiện ích**, **Xem hướng dẫn** (GIF từng bước cho Chrome, Edge, Brave). Tóm tắt:

1. Tải `diaba-extension-vX.Y.Z.zip` ở [Releases](https://github.com/dat-phan-blueberry/biz-profile-audit-ext/releases/latest).
2. Chuột phải → **Giải nén tất cả** → được thư mục `diaba-extension-vX.Y.Z`. Để cố định, đừng xoá.
3. Mở `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`), bật **Chế độ dành cho nhà phát triển**.
4. Kéo thư mục vào trang (Chrome/Brave), hoặc bấm **Tải tiện ích đã giải nén** rồi chọn thư mục (mọi trình duyệt).
5. Cập nhật: làm lại y hệt với bản mới — trình duyệt thay bản cũ (cùng ID), có thể xoá thư mục cũ.

Không cần cấu hình gì thêm:
- **ID cố định** `coonkgehlckihibjghcejllijbhjjknd` nhờ trường `key` trong `manifest.json` (cài ở thư mục nào cũng ra cùng ID; web dùng sẵn ID này).
- **AI fallback**: web Địa Bạ xin token ngắn hạn (10 phút) từ máy chủ rồi gọi thẳng AI Gateway; extension không giữ key. Trang Options chỉ dùng khi test tay từ popup.

## Phát hành bản mới (dev) — CI/CD tự động

**Chỉ cần commit + push lên `main`.** Có thay đổi trong `extension/` là workflow `.github/workflows/release.yml` tự:
1. Kiểm cú pháp các file JS và `manifest.json`.
2. Chọn version (`scripts/next-version.mjs`): `version` trong manifest cao hơn release mới nhất thì dùng đúng số đó (tự đặt khi ra bản lớn, vd `1.2.0`); không thì tự tăng patch (`1.1.1` → `1.1.2`) và bot commit lại manifest (`[skip ci]`).
3. Đóng gói zip phẳng (`scripts/pack-extension.mjs`) và tạo GitHub Release `vX.Y.Z` kèm `diaba-extension-vX.Y.Z.zip`, ghi chú lấy từ các commit.

Web Địa Bạ tự thấy bản mới và nhắc sale cập nhật. Đổi chỉ README/scripts thì không phát hành.
Chặn thu thập với bản quá cũ: nâng `REQUIRED_EXTENSION_VERSION` ở web (`src/lib/extension-bridge.ts`).

Trước khi push thay đổi `content.js` / `ai-fallback.js`, chạy smoke test ở máy (cần profile Chrome đã đăng nhập Google, không chạy được trên CI):
- Script: `PROFILE=<profile> node scripts/smoke-maps.cjs --slow`
- AI agent (tắt script, tốn quota ~20–60 lượt/quán): `PROFILE=<profile> ENV_FILE=<.env web Địa Bạ> node scripts/smoke-maps.cjs --ai`

Giao diện trang tiện ích đổi thì quay lại GIF ở repo web: `node scripts/record-extension-guides.cjs`.

## Cách kiểm tra và sử dụng

### Cách 1: Test tay qua Extension Popup
Dev: cài thẳng thư mục `extension/` của repo bằng **Tải tiện ích đã giải nén**.
1. Mở tab Google Chrome và đăng nhập tài khoản Google.
2. Mở một nhà hàng bất kỳ trên Google Maps (ví dụ: một nhà hàng có thực đơn đầy đủ).
3. Bấm vào icon Extension Địa Bạ trên thanh công cụ trình duyệt.
4. Chọn các mục muốn thu thập: Menu chữ, Tiện ích, Giờ đặc biệt.
5. Bấm nút **"Thu thập trang Maps hiện tại"**.
6. Kết quả JSON trả về sẽ hiển thị ngay trong khung popup.

### Cách 2: Thu thập tự động từ Web Địa Bạ
1. Mở trang Web Địa Bạ (`http://localhost:3000` hoặc bản production).
2. Tìm kiếm và chọn một quán ăn.
3. Khi hồ sơ hiển thị và hệ thống phát hiện Extension đã được cài đặt, giao diện sẽ xuất hiện nút **"Thu thập phần còn thiếu từ Google Maps"**.
4. Bấm nút, Extension sẽ ngầm mở tab Maps tới quán, thu thập dữ liệu còn thiếu, đóng tab và tự động cập nhật vào hồ sơ trên màn hình.

---

## Khi sale báo lỗi
Mục nào lỗi, web hiện nút **Sao chép chẩn đoán** (quán, bản extension, các tab, tiêu đề nhóm, nhãn aria, đoạn chữ đầu của panel Maps lúc lỗi). Dán nội dung đó để sửa `extension/content.js` đúng chỗ, thêm quán vào `scripts/smoke-places.json` rồi chạy lại smoke test.

## Giới hạn & Lưu ý
- **Trình duyệt**: Chrome, Edge, Brave (và trình duyệt Chromium khác) trên máy tính. Firefox chưa hỗ trợ `externally_connectable`, Safari cần đóng gói qua Xcode → chưa hỗ trợ.
- **Yêu cầu đăng nhập**: Trình duyệt phải được đăng nhập tài khoản Google để Google Maps mở đầy đủ tab Menu và tab Giới thiệu.
- **Thực đơn dạng ảnh**: Một số nhà hàng chỉ đăng ảnh chụp menu mà không nhập text menu vào hệ thống Google Business -> Extension sẽ ghi nhận `menuPhotosOnly: true` thay vì tạo thực đơn giả.
- **Tốc độ mạng**: Google Maps là Single Page Application nặng, khi mở tab ngầm cần đợi vài giây để DOM hydrate hoàn chỉnh trước khi bóc tách.
