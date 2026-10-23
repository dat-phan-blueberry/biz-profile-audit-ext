# Địa Bạ - Google Maps Profiler (extension)

**[⬇ Tải bản mới nhất](https://github.com/dat-phan-blueberry/biz-profile-audit-ext/releases/latest)**

Extension trình duyệt (Manifest V3, Chrome / Edge / Brave) chuyên dụng cho đội ngũ Sale và chuyên viên tư vấn GoDine nhằm thu thập các dữ liệu bổ sung bị Google Maps ẩn khi chưa đăng nhập (Menu chữ, Tab Giới thiệu / Tiện ích, Giờ đặc biệt).

## Kiến trúc lai (Hybrid Extraction)
1. **Script cố định (Ưu tiên số 1)**: Thao tác DOM chuẩn qua `aria-label`, `role`, và văn bản hiển thị (hỗ trợ cả tiếng Việt và tiếng Anh). Không dựa vào class CSS bị mã hóa ngẫu nhiên.
2. **AI Fallback (Tự động kích hoạt khi script gãy)**: Nếu script không tìm thấy tab hoặc bóc tách ra 0 mục, extension sẽ chụp tóm tắt text của khung bên trái và danh sách nút bấm, nhờ web Địa Bạ gửi lên AI (máy chủ Địa Bạ giữ key, extension không giữ). AI trả về hành động: `{ "action": "click", "index": N }`, `{ "action": "extract", "data": {...} }`, hoặc `{ "action": "give_up" }` (tối đa 6 bước mỗi phần).

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

## Phát hành bản mới (dev)

1. Tăng `version` trong `extension/manifest.json`. Web Địa Bạ nhắc cập nhật khi bản cài cũ hơn release mới nhất; chặn thu thập khi cũ hơn `REQUIRED_EXTENSION_VERSION` (repo web, `src/lib/extension-bridge.ts`).
2. Commit, tạo tag `vX.Y.Z` (đúng bằng version) và đẩy tag lên GitHub.
3. Workflow `.github/workflows/release.yml` kiểm tag khớp manifest, đóng gói zip phẳng (`scripts/pack-extension.mjs`) và tạo Release kèm `diaba-extension-vX.Y.Z.zip`.
4. Chạy thử đóng gói ở máy: `node scripts/pack-extension.mjs` → `dist/`.
5. Đổi quyền/host trong `manifest.json` thì kiểm lại `externally_connectable` (các domain web Địa Bạ được gọi extension).

---

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

## Giới hạn & Lưu ý
- **Trình duyệt**: Chrome, Edge, Brave (và trình duyệt Chromium khác) trên máy tính. Firefox chưa hỗ trợ `externally_connectable`, Safari cần đóng gói qua Xcode → chưa hỗ trợ.
- **Yêu cầu đăng nhập**: Trình duyệt phải được đăng nhập tài khoản Google để Google Maps mở đầy đủ tab Menu và tab Giới thiệu.
- **Thực đơn dạng ảnh**: Một số nhà hàng chỉ đăng ảnh chụp menu mà không nhập text menu vào hệ thống Google Business -> Extension sẽ ghi nhận `menuPhotosOnly: true` thay vì tạo thực đơn giả.
- **Tốc độ mạng**: Google Maps là Single Page Application nặng, khi mở tab ngầm cần đợi vài giây để DOM hydrate hoàn chỉnh trước khi bóc tách.
