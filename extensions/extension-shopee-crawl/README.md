# Markee Shopee Product Crawler (Chrome Extension)

Crawl toàn bộ sản phẩm 1 shop Shopee (tên, giá, ảnh, lượt bán, rating, link)
và đồng bộ vào "kho tri thức" (bảng `products` trong Supabase) để chatbot tư
vấn tự động chọn đúng link sản phẩm gửi khách — xem `CHATBOT-PLAN.md` ở gốc
repo.

## Vì sao cần extension (không crawl thuần server được)

Shopee ký các request lấy danh sách sản phẩm (`search_items`/`rcmd_items`)
bằng header chống bot (`af-ac-enc-dat`, `x-sap-sec`) tính riêng bởi JS của
chính trang — gọi thẳng bằng `fetch`/`curl`/Playwright headless từ server sẽ
bị Shopee redirect sang trang captcha. Cách duy nhất hoạt động ổn định (đã
kiểm chứng ở dự án gốc `shopee-crawl`) là "nghe lén" (intercept) response mà
chính JS của Shopee tự phát ra trong 1 tab Chrome **thật, đã đăng nhập** —
đó là việc `interceptor.js` + `background.js` trong extension này làm.

## Cài đặt (Load unpacked)

1. Mở Chrome, vào `chrome://extensions`.
2. Bật **Developer mode** (góc trên phải).
3. Bấm **Load unpacked**, chọn thư mục `extensions/extension-shopee-crawl`
   (thư mục chứa file này).
4. Ghim icon extension lên toolbar cho dễ bấm.

## Cấu hình (1 lần)

1. Đăng nhập `shopee.vn` bình thường trên **chính trình duyệt Chrome này**
   (không phải Ẩn danh — extension đọc request của tab thật).
2. Bấm icon extension → mục **1. Cấu hình server**:
   - **Backend URL**: URL app Next.js (`http://localhost:3000` khi dev local,
     hoặc domain thật khi đã deploy — xem `README.md`/`DEPLOY-NOTES.md` ở
     gốc repo).
   - **API Key**: giá trị biến môi trường `SHOPEE_SYNC_API_KEY` đã set trên
     server (để trống nếu server chưa cấu hình biến này — chỉ nên bỏ trống
     khi dev local).
   - **Account Zalo áp dụng**: `account_id` (vd `shop-owner`) — chatbot của
     account này sẽ dùng danh mục sản phẩm của shop bạn crawl. Có thể để
     trống và gán account sau ở trang `/zalo/shopee-shops`.
   - Bấm **Lưu cấu hình**.

## Crawl 1 shop

1. Vào trang `/zalo/shopee-shops` trên web app, thêm link shop (vd
   `https://shopee.vn/beplain.vn`) — bước này chỉ ghi nhận, chưa crawl gì.
2. Mở popup extension, mục **2. Crawl shop**, dán lại đúng link/username đó
   → bấm **Bắt đầu crawl**.
3. Extension sẽ tự mở 1 tab Shopee, lần lượt tải các trang sản phẩm của shop
   (tối đa ~40 trang, dừng khi hết sản phẩm), gom lại rồi tự đóng tab. Có thể
   đóng popup — tiến trình vẫn chạy nền, mở lại popup bất cứ lúc nào để xem
   tiếp (badge trên icon cũng hiện số sản phẩm đang gom được).
4. Xong sẽ tự gửi kết quả lên server (`/api/shopee/import`) — quay lại trang
   `/zalo/shopee-shops` để xem danh sách sản phẩm.

**Lưu ý:** không crawl liên tục nhiều shop cùng lúc / lặp lại quá nhiều lần
trong thời gian ngắn — dễ bị Shopee tạm chặn (rate limit của chính tài khoản
Shopee bạn đang dùng để crawl).

## Bổ sung mô tả chi tiết (tuỳ chọn, chậm hơn)

Danh sách sản phẩm (bước trên) **không có** mô tả đầy đủ — Shopee chỉ trả mô
tả khi mở đúng trang chi tiết 1 sản phẩm. Mục **3. Bổ sung mô tả chi tiết**
trong popup sẽ mở lại **từng trang sản phẩm** (tuần tự, delay ~2.5-3.5s/sản
phẩm) để lấy mô tả — với shop vài trăm sản phẩm có thể mất nhiều phút. Rủi ro
bị Shopee chặn cao hơn bước crawl danh sách (nhiều request hơn) — chỉ chạy
khi cần, không bắt buộc để chatbot hoạt động (chatbot vẫn match được sản
phẩm bằng tên + từ khoá dù chưa có mô tả).

## File trong thư mục này

| File | Vai trò |
|---|---|
| `manifest.json` | Khai báo extension MV3. |
| `interceptor.js` | Chạy trong MAIN world của tab Shopee — bắt response `search_items`/`rcmd_items` (danh sách) và `pdp/get_pc` (chi tiết 1 sản phẩm, dùng cho bước bổ sung mô tả). |
| `background.js` | Service worker — chạy toàn bộ tiến trình crawl (mở tab, phân trang, gom item, gửi lên server). Không chạy trong popup vì Chrome tự đóng popup khi mất focus. |
| `popup.html/js/css` | UI: cấu hình server, bấm crawl, xem tiến trình. |

Nếu Shopee đổi shape response (field `itemid`/`price`/`image`/... đổi tên),
sửa hàm `extractProductRow()` trong `background.js` và các regex/nhánh trong
`interceptor.js` — không cần sửa gì ở phía Next.js.
