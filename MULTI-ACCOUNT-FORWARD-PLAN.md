# Kế hoạch: Multi-account Zalo cho forward (acc chính + acc phụ chia tải)

> Mục tiêu: acc chính nghe nhóm nguồn (master group) như hiện tại, nhưng khi
> forward ra nhiều nhóm đích, các nhóm đó được **chia cho nhiều acc Zalo phụ**
> gửi song song thay vì dồn hết vào 1 acc — mượt hơn, nhanh hơn, và né rate
> limit vì mỗi acc có quota/delay riêng.

> **Trước khi làm phần multi-account: đã tìm ra + cần fix 1 bug thật** khiến
> "login acc dev thì acc customer bị disconnect" — xem mục 0. Không fix cái
> này thì thêm acc phụ sẽ đá nhau y hệt.

---

## 0. Root cause: login acc A đá acc B (đã xác nhận trong code, chưa fix)

**Bằng chứng:**

- `extensions/extension-login-zalo/content.js:346` — khi phát hiện login
  thành công, extension đọc `window.localStorage.getItem("z_uuid")` ngay trên
  trang `chat.zalo.me`. Giá trị `z_uuid` này là device-id **do chính Zalo Web
  sinh ra và lưu theo origin của trình duyệt**, KHÔNG theo tài khoản đang đăng
  nhập.
- `extensions/extension-login-zalo/background.js:444-445, 701-703, 926-927` —
  giá trị đó được cache vào `chrome.storage.local` dưới **1 key global duy
  nhất `"imei"`** (không phân theo `account_id`), rồi được gửi lên backend ở
  mọi lần import session (dòng 848-851: `if (!imei) { ...local.imei... }`).
- `services/zalo-bridge/src/services/sessionManager.js:1012-1020` —
  `loginWithCookies()` dùng thẳng `creds.imei` nếu có (chỉ sinh random khi rỗng
  hẳn), rồi persist vào `data/sessions/<accountId>.json` (dòng 1046) — tin
  tưởng tuyệt đối giá trị extension gửi lên.

**Hệ quả:** nếu bạn dùng **cùng 1 trình duyệt** để login acc `customer` rồi
sau đó login acc `dev`, `z_uuid` đọc được ở lần 2 vẫn là giá trị cũ (localStorage
theo origin, không đổi theo tài khoản) → cả 2 accountId khác nhau trong hệ
thống của mình bị đăng ký lên Zalo server với **cùng 1 device-id**. Zalo chỉ
cho 1 phiên hoạt động trên 1 device-id tại 1 thời điểm → login acc sau kick
acc trước (đúng như mô tả). Đây là bug ở tầng extension, không phải giới hạn
cứng của Zalo/zca-js.

**Fix đề xuất:**

1. `background.js`: đổi key cache từ `imei` (global) sang keyed theo
   `account_id` (vd. object `{ [accountId]: imei }` trong
   `chrome.storage.local`). Mỗi account_id mới → không fallback vào imei của
   account khác.
2. Khi import 1 `account_id` **lần đầu**, vẫn lấy `z_uuid` hiện tại của tab
   (đúng cho account đang thật sự active trong tab đó lúc đó) và lưu riêng
   cho account_id này. Các lần sau (reconnect) dùng lại đúng giá trị đã lưu
   cho account_id đó — giữ được "cùng 1 thiết bị" cho 1 account, tránh Zalo
   nghi ngờ đổi device liên tục.
3. **Khuyến nghị vận hành song song** (không cần chờ fix code): mỗi acc Zalo
   (dev, customer, và các acc phụ sau này) nên login từ 1 **browser
   profile/incognito riêng** (hoặc dùng QR login trong app thay vì extension
   — `sessionManager.startQrLogin()` không phụ thuộc `z_uuid`, zca-js tự sinh
   device credentials riêng cho mỗi phiên QR). Đây cũng là điều kiện bắt buộc
   cho acc phụ ở mục 2 dưới, nên nên áp dụng luôn.

---

## 1. Thiết kế multi-account forward (chia tải acc phụ)

### Ràng buộc thực tế (không phải giới hạn code)
- Acc phụ phải là **tài khoản Zalo thật, khác acc chính**, và phải **đã là
  thành viên của group đích** được giao cho nó — Zalo không cho gửi vào group
  mình không ở trong.
- Acc phụ nên là acc có lịch sử dùng thật, login theo mục 0.3 để tránh bị kick
  chéo hoặc bị Zalo flag là farm.

### Data model
Thêm cột nullable vào `zalo_forward_targets`:

```sql
ALTER TABLE public.zalo_forward_targets
  ADD COLUMN sender_account_id TEXT
    REFERENCES public.zalo_accounts(account_id) ON DELETE SET NULL;
```

- `NULL` = giữ hành vi hiện tại (acc sở hữu rule tự gửi — không breaking
  change cho rule cũ).
- Có giá trị = target đó được gửi bởi acc phụ tương ứng.

Cập nhật view `v_zalo_forward_rules_active` để trả thêm
`t.sender_account_id`.

### forwardEngine.js
- `loadRulesByMaster()`: nạp thêm `sender_account_id` mỗi target.
- Khi xử lý 1 rule, **partition targets theo sender account** (target không
  có `sender_account_id` → dùng `rule.account_id` như cũ).
- Text: nhánh dùng acc chính vẫn giữ `api.forwardMessage()` fan-out 1 lệnh
  (nhanh, giữ tag "Đã chuyển tiếp"). Nhánh acc phụ **không thể forward-by-
  reference** (acc phụ chưa từng nhận tin đó) → phải gửi lại bằng
  `sendMessage({ msg: text })` từ chính acc phụ — **mất tag "đã chuyển tiếp"**
  cho các bản acc phụ gửi, cần báo trước cho bạn để chấp nhận đánh đổi này.
- Media/sticker: đã sẵn cơ chế tải về rồi gửi lại qua `sendMessage`/
  `sendSticker` per target — chỉ cần đổi `api` instance theo acc được gán,
  không đổi logic tải/gộp album.
- **Chạy song song theo acc**: mỗi partition (theo acc) chạy vòng lặp tuần tự
  với delay/rate-limit riêng của chính acc đó (`Promise.all` giữa các
  partition) — đây là phần mang lại tốc độ, vì acc phụ không phải xếp hàng
  chờ delay 5s của acc chính.
- Cần thêm `sessionManager.getConnectedApi(accountId)` — trả `api` nếu
  `logged_in && isWsConnected`, ngược lại `null` để forwardEngine bỏ qua +
  ghi `zalo_forward_logs` với lỗi `sender_offline` thay vì throw.

### UI (`app/zalo/forward-rules`)
- Thêm dropdown "Tài khoản gửi" khi thêm/sửa 1 target, mặc định = acc sở hữu
  rule, liệt kê các acc đang `connected` kèm badge trạng thái online.
- Hiển thị cảnh báo nếu acc phụ được chọn đang offline (target sẽ bị skip cho
  tới khi acc đó login lại).

---

## 2. Rollout theo bước

1. Fix bug imei ở extension (mục 0) — làm trước, không phụ thuộc phần còn lại.
2. Migration thêm `sender_account_id` + cập nhật view.
3. `sessionManager.getConnectedApi()`.
4. `forwardEngine.js`: partition + gửi song song theo acc.
5. UI chọn acc gửi theo từng target trong forward-rules.
6. Test: 1 acc chính + 2 acc phụ, 1 rule có target chia cả 3 acc → xác nhận
   gửi song song, acc phụ đúng group được gán, không acc nào bị kick chéo.

## 3. Việc KHÔNG làm trong phạm vi này
- Không tự động round-robin/auto-detect acc phụ nào đang là member group nào
  — admin tự gán tay qua UI (đơn giản, đúng nhu cầu "khách có acc nằm sẵn
  trong group nhất định").
- Không giảm thêm delay 5s/60 msg-phút của từng acc khi scale — mục tiêu là
  nhiều "làn" chạy song song, không phải 1 làn nhanh hơn.
