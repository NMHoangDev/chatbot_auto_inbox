# Kế hoạch: Chatbot tư vấn sản phẩm tự động qua Zalo

> Mục tiêu: khi khách chat với shop trên Zalo, hệ thống tự đọc đoạn chat (chạy
> ngầm, không cần mở app), hiểu khách đang cần sản phẩm gì, rồi tự gửi lại
> **link Shopee + mô tả** sản phẩm phù hợp nhất — không cần nhân viên can
> thiệp. Xây dựng trên nền `zalo-bridge` (Express + zca-js) đang chạy ổn định
> cho tính năng forward.

> **Trạng thái (đã triển khai):** Phần "kho tri thức sản phẩm" (mục 5b) đã
> code xong — bảng `shopee_shops`/`products` (migration
> `supabase/migrations/0003_shopee_products_kb.sql`), API `/api/shopee/*`,
> trang quản trị `/zalo/shopee-shops`, và Chrome extension
> `extensions/extension-shopee-crawl` (crawl sản phẩm từ 1 link shop Shopee,
> xem README trong đó). Phần `chatbotEngine.js` đọc kho này + debounce 20s +
> gọi Claude (mục 1-4, 6-11 dưới đây) **vẫn còn là kế hoạch, chưa code.**

---

## 1. Luồng hoạt động (tổng quan)

```
Khách gửi tin nhắn Zalo
        │
        ▼
zca-js listener (services/zalo-bridge/src/services/sessionManager.js)
        │  (đã có – nơi forwardEngine.js đang hook vào)
        ▼
chatbotEngine.onIncomingMessage(accountId, threadId, msg)
        │
        ├─ Nếu chatbot bị tắt cho account/thread này → dừng
        ├─ Nếu tin nhắn là do NHÂN VIÊN tự gửi (isSelf) → coi là "human
        │   takeover", tạm dừng bot cho thread này N phút → dừng
        │
        ▼
   Debounce timer theo threadId (mặc định 20s, dùng setTimeout giống
   pattern IMAGE_BATCH_MS trong forwardEngine.js — mỗi tin mới tới thì
   reset lại timer)
        │  (khách gõ thêm vài tin trong 20s → timer reset liên tục,
        │   chỉ xử lý khi khách "im lặng" đủ 20s = coi như chốt yêu cầu)
        ▼
Khi timer bắn: gom toàn bộ tin nhắn khách gửi trong cửa sổ này (+ ít tin
nhắn gần nhất trước đó để có ngữ cảnh) → gọi Claude API
        │
        ▼
Claude (Haiku 4.5, structured output JSON) đọc đoạn chat + toàn bộ danh
mục sản phẩm (đã cache) → trả về:
  { intent_summary, matched: true/false, product_id, confidence, reply_message }
        │
        ├─ matched=false hoặc confidence thấp → không gửi gì (tránh gửi
        │   sai sản phẩm), log lại để review
        ▼
   confidence đủ cao → sessionManager.sendMessage(accountId, threadId,
   'user', { msg: reply_message + '\n' + shopee_url })
        │
        ▼
   Ghi log vào bảng zalo_chatbot_replies (giống zalo_forward_logs)
```

Toàn bộ logic mới chạy **trong cùng process `zalo-bridge`** (không cần thêm
service/container) — đúng kiến trúc hiện tại: `forwardEngine.js` xử lý
forward, `chatbotEngine.js` (mới) xử lý trả lời tự động, cả hai đều được gọi
từ listener `message` trong `sessionManager.js`.

---

## 2. Vì sao debounce 20s theo threadId (không phải global)

- Mỗi cuộc chat (thread) độc lập — khách A gõ chậm không ảnh hưởng khách B.
- Cơ chế giống hệt `queueImageForBatch` trong `forwardEngine.js` (đã có
  sẵn, đã chạy ổn định): mỗi tin mới tới cùng thread → `clearTimeout` +
  `setTimeout` lại. Chỉ khi không có tin mới trong 20s thì mới flush.
- Không dùng debounce cố định kiểu "chờ đúng 20s từ tin đầu" vì khách có thể
  gõ nhiều câu rời (VD: "shop ơi" → "cho mình hỏi" → "áo thun nam size L") —
  cần chờ đến khi khách **dừng gõ** mới xử lý, không xử lý giữa chừng.

---

## 3. Vì sao cần "human takeover" guard

Nhân viên có thể đang tự trả lời khách trên điện thoại (tài khoản Zalo dùng
chung, xem README hiện tại: mỗi `account_id` là 1 tài khoản Zalo thật).
Listener hiện tại đã phân biệt `msg.isSelf` (tin do chính tài khoản gửi, kể
cả gửi từ điện thoại). Quy tắc:

- Nếu phát hiện `isSelf=true` trong 1 thread → set cờ "đang có người xử lý"
  cho thread đó trong X phút (mặc định 15 phút, cấu hình được) → chatbot
  **không tự trả lời** trong khoảng thời gian đó, tránh chatbot chen ngang
  khi nhân viên đang tư vấn tay.
- Sau khi hết X phút không có tin nhân viên mới → chatbot hoạt động lại.

---

## 4. Vì sao chọn Claude Haiku 4.5 + structured output (không phải Sonnet, không phải fine-tune/vector DB)

Đây là tác vụ **classification + extraction nhẹ**: đọc ~5-10 câu chat tiếng
Việt, chọn 1 sản phẩm khớp nhất trong danh mục vài trăm dòng. Không cần suy
luận phức tạp, không cần agent nhiều bước.

| Lựa chọn | Quyết định | Lý do |
|---|---|---|
| Model | **`claude-haiku-4-5`** | Rẻ nhất, đủ tốt cho classification/extraction tiếng Việt; nếu sau này thấy match sai nhiều → nâng cấp `claude-sonnet-5` chỉ bằng đổi 1 string, không đổi kiến trúc |
| Cách lấy JSON tin cậy | **`output_config.format` (JSON Schema)** qua `client.messages.create()` | Đảm bảo luôn parse được JSON, không cần regex/parse text lỏng lẻo; đơn giản hơn tool-calling cho tác vụ 1-lượt này |
| Cách "biết" hết sản phẩm | **Nhồi toàn bộ catalog vào system prompt + prompt caching**, KHÔNG dùng vector DB | Catalog "vài trăm dòng" đủ nhỏ để nhét thẳng vào context (ước tính vài chục nghìn token) — rẻ hơn, đơn giản hơn build pipeline embedding. Cache bằng `cache_control: {type: "ephemeral"}` trên phần catalog vì catalog ít đổi giữa các lần gọi → các lần gọi sau chỉ trả ~10% giá phần đó |
| Thinking | Không cần | Tác vụ đơn giản, không dùng `thinking` (Haiku 4.5 không hỗ trợ adaptive/effort) |

**Giá (theo bảng giá hiện tại):** Haiku 4.5 = $1/1M token input, $5/1M token
output. Với catalog ~vài trăm sản phẩm (ước lượng ~30-60K token nếu mỗi sản
phẩm ~100-150 token mô tả+từ khoá), sau khi cache: lần gọi đầu tốn full giá
phần catalog (~$0.03-0.06), các lần sau trong vòng cache TTL chỉ tốn ~10% giá
đó (~$0.003-0.006) cho phần catalog + giá đầy đủ cho phần chat ngắn (vài trăm
token) + output ngắn (~200 token). **Ước tính mỗi lượt trả lời tự động: dưới
$0.01**, tức 1000 lượt tư vấn tự động < $10.

> Nếu về sau catalog phình lên hàng nghìn sản phẩm, cân nhắc chuyển sang
> 2 bước: (1) Claude phân loại "category" khách cần → (2) lọc DB theo
> category/keyword → chỉ nhồi các sản phẩm đã lọc vào lượt gọi thứ 2. Với
> "vài trăm dòng" như hiện tại thì chưa cần bước này.

### Sơ đồ request tới Claude

```
System prompt (cache_control: ephemeral):
  - Vai trò: "Bạn là trợ lý bán hàng, đọc đoạn chat khách và chọn 1 sản
    phẩm phù hợp nhất từ danh mục dưới đây."
  - Toàn bộ catalog: mỗi dòng "id | tên | mô tả ngắn | từ khoá"

User message:
  - N tin nhắn gần nhất của khách trong thread (chỉ text do khách gửi,
    không cần tin của bot/nhân viên)

output_config.format = json_schema:
  {
    intent_summary: string,       // khách đang cần gì, tóm tắt 1 câu
    matched: boolean,
    product_id: string | null,
    confidence: number (0-1),
    reply_message: string         // câu trả lời ngắn gọn kèm giới thiệu,
                                   // KHÔNG bao gồm link (link nối riêng)
  }
```

Ngưỡng gửi: chỉ gửi khi `matched=true` **và** `confidence >= 0.6` (cấu hình
được qua env). Dưới ngưỡng → không gửi, chỉ log để xem lại sau (tránh gửi
nhầm sản phẩm gây mất uy tín).

---

## 5. Schema database

### 5a. Kho tri thức sản phẩm — **đã triển khai** (`supabase/migrations/0003_shopee_products_kb.sql`)

Thay vì bạn tự nhập tay từng sản phẩm, bảng `products` giờ được nạp tự động
từ Chrome extension `extensions/extension-shopee-crawl` (xem mục 5b) — chỉ
cần dán 1 link shop Shopee. Vẫn sửa tay được qua `/zalo/shopee-shops` (API
`app/api/shopee/products/[id]` PATCH) nếu cần chỉnh mô tả/từ khoá cho AI dễ
match hơn.

```sql
CREATE TABLE public.shopee_shops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id TEXT REFERENCES public.zalo_accounts(account_id) ON DELETE SET NULL,
  shop_username TEXT NOT NULL UNIQUE,   -- vd "beplain.vn"
  shop_url TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | crawling | done | error
  last_crawled_at TIMESTAMPTZ,
  last_error TEXT,
  product_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES public.shopee_shops(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES public.zalo_accounts(account_id) ON DELETE SET NULL,
  shopee_item_id TEXT,
  shopee_shop_id TEXT,
  name TEXT NOT NULL,
  description TEXT,                -- lấy qua bước "enrich" riêng (chậm hơn, tuỳ chọn)
  keywords TEXT[] NOT NULL DEFAULT '{}',
  category TEXT,
  price NUMERIC,
  sold_count INTEGER,
  rating NUMERIC,
  image_url TEXT,
  shopee_url TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  raw_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shop_id, shopee_item_id)
);
```

Luồng crawl: bạn thêm link shop ở `/zalo/shopee-shops` (chỉ ghi nhận, tạo
dòng `pending`) → mở Chrome đã đăng nhập Shopee, dùng extension
`extension-shopee-crawl` để crawl thật (Shopee chặn crawl tự động thuần
server — xem giải thích trong README của extension) → extension tự POST kết
quả lên `/api/shopee/import` → route này upsert vào `products` + cập nhật
`shopee_shops.status='done'`.

### 5b. Chatbot engine (debounce + gọi Claude) — **kế hoạch, chưa code**

Migration riêng (`0004_zalo_chatbot.sql`, đặt tên tiếp theo 0003 đã dùng cho
mục 5a):

```sql
-- Cấu hình chatbot theo từng account Zalo
CREATE TABLE public.zalo_chatbot_settings (
  account_id TEXT PRIMARY KEY REFERENCES public.zalo_accounts(account_id) ON DELETE CASCADE,
  is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  debounce_seconds INTEGER NOT NULL DEFAULT 20,
  confidence_threshold NUMERIC NOT NULL DEFAULT 0.6,
  staff_takeover_minutes INTEGER NOT NULL DEFAULT 15,
  reply_cooldown_seconds INTEGER NOT NULL DEFAULT 120, -- chặn spam: cách nhau
                                                         -- tối thiểu bao lâu
                                                         -- mới gửi lượt tư vấn
                                                         -- kế tiếp cho cùng 1 thread
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Log mỗi lần chatbot xử lý (kể cả không gửi) — để debug + đo chất lượng
CREATE TABLE public.zalo_chatbot_replies (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  intent_summary TEXT,
  matched_product_id UUID REFERENCES public.products(id),
  confidence NUMERIC,
  reply_message TEXT,
  status TEXT NOT NULL,     -- 'sent' | 'skipped_low_confidence' | 'skipped_disabled' | 'skipped_takeover' | 'failed'
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

(Áp dụng cùng convention RLS permissive `USING (true)` như migration 0001 —
authorization vẫn xử lý ở tầng API route Next.js, không phải ở Postgres.)

---

## 6. Thành phần code cần thêm

| File | Vai trò |
|---|---|
| `services/zalo-bridge/src/services/chatbotEngine.js` | Logic chính: debounce theo thread, gom tin nhắn, gọi classifier, gửi tin, ghi log. Cấu trúc tương tự `forwardEngine.js` (đã có `imageBatches` Map làm mẫu debounce theo key). |
| `services/zalo-bridge/src/services/llmClassifier.js` | Wrap `@anthropic-ai/sdk`: build prompt từ catalog + tin nhắn, gọi `client.messages.create` với `output_config.format`, parse kết quả. Cache catalog trong RAM (TTL ~5-10 phút, giống `RULES_CACHE_TTL_MS` trong forwardEngine) để không query Supabase mỗi lần. |
| `services/zalo-bridge/src/services/sessionManager.js` (sửa) | Trong listener `message`, sau đoạn gọi `handleIncomingGroupMessage`, thêm gọi `chatbotEngine.onIncomingMessage({accountId, threadId, msg, api})` — fire-and-forget, không `await`, giống cách forwardEngine được gọi. |
| `supabase/migrations/0004_zalo_chatbot.sql` | Schema ở mục 5b (`zalo_chatbot_settings`, `zalo_chatbot_replies`). |
| `app/api/zalo/chatbot-settings/route.ts` | Đọc/sửa cấu hình bật/tắt theo account. |
| `app/(...)/zalo/chatbot/page.tsx` | UI: toggle bật/tắt theo account, chỉnh ngưỡng confidence/debounce, xem log `zalo_chatbot_replies` gần đây (giống trang xem Log trong forward-rules). |

**Đã có sẵn (mục 5a, không cần làm lại):** `app/api/shopee/{shops,import,products}` +
`app/zalo/shopee-shops/page.tsx` + `extensions/extension-shopee-crawl`.
`llmClassifier.js` khi code sẽ đọc `products` qua Supabase filter theo
`account_id` (bảng này đã tồn tại).

Package cần thêm vào `services/zalo-bridge/package.json`: `@anthropic-ai/sdk`.

---

## 7. Cấu hình / biến môi trường mới (`.env` / `.env.local`)

```
ANTHROPIC_API_KEY=sk-ant-...
ZALO_CHATBOT_MODEL=claude-haiku-4-5
ZALO_CHATBOT_DEBOUNCE_MS=20000            # override mặc định 20s nếu cần
ZALO_CHATBOT_CATALOG_CACHE_TTL_MS=300000  # cache catalog 5 phút
```

Các tham số theo-account (ngưỡng confidence, bật/tắt, thời gian takeover)
lưu trong bảng `zalo_chatbot_settings`, sửa được qua UI — không cần restart
service khi đổi.

Trên VM (`demoweb@10.30.194.96`, xem ghi chú deploy hiện tại): chỉ cần thêm
`ANTHROPIC_API_KEY` vào `~/app/.env`, không cần sửa `docker-compose.yml` vì
`zalo-bridge` service đã khai báo `env_file: .env` (tự nạp mọi biến trong file
đó vào container).

---

## 8. Chống lỗi / an toàn khi vận hành

- **Không bao giờ throw ra listener chính** — mọi lỗi trong `chatbotEngine`
  bắt bằng try/catch + log, không làm crash việc nhận tin nhắn khác (đúng
  pattern `forwardEngine.js` đang làm).
- **Rate limit theo account** khi gọi Claude API (giống `consumeRateBudget`
  trong forwardEngine) — tránh vượt rate limit Anthropic nếu nhiều khách chat
  cùng lúc.
- **Cooldown theo thread** (`reply_cooldown_seconds`) — nếu bot vừa trả lời 1
  sản phẩm, không trả lời tiếp ngay trong X giây kể cả khách nhắn tiếp, trừ
  khi ý định rõ ràng khác hẳn (best-effort: có thể bỏ qua nhánh này ở v1,
  chỉ cooldown đơn giản theo thời gian).
- **Ngưỡng confidence** — không gửi khi không chắc, tốt hơn im lặng còn hơn
  gửi sai link.
- **Không tự trả lời trong group chat nội bộ** — chỉ áp dụng cho
  `thread_type = 'user'` (chat 1-1 với khách) trừ khi được cấu hình khác;
  group thường dùng cho nội bộ shop (forward rules), không nên chatbot tự
  nhắn vào đó.
- **Log mọi quyết định** vào `zalo_chatbot_replies` để xem lại — kể cả khi
  không gửi, biết được lý do (`status`).

---

## 9. Kế hoạch triển khai theo giai đoạn

1. **Giai đoạn 0 — chuẩn bị dữ liệu:** bạn nhập danh mục sản phẩm (tên, mô
   tả, từ khoá, link Shopee) vào bảng `products` (qua UI mới hoặc SQL trực
   tiếp trong Supabase Studio để bắt đầu ngay không cần chờ UI xong).
2. **Giai đoạn 1 — schema + service backend:** tạo migration, viết
   `llmClassifier.js` + `chatbotEngine.js`, hook vào `sessionManager.js`.
   Chạy ở **"shadow mode"**: chỉ log kết quả phân loại + sản phẩm match vào
   `zalo_chatbot_replies`, KHÔNG gửi tin thật cho khách. Mục đích: kiểm tra
   độ chính xác trước khi cho gửi thật.
3. **Giai đoạn 2 — review shadow log:** xem vài chục dòng log, đánh giá:
   match đúng sản phẩm không, confidence có hợp lý không, câu trả lời tự
   nhiên không → tinh chỉnh system prompt / ngưỡng confidence.
4. **Giai đoạn 3 — bật gửi thật cho 1 account thử nghiệm** (VD account
   `dev`/test trước, chưa bật cho account khách thật), theo dõi vài ngày.
5. **Giai đoạn 4 — bật cho account khách thật**, có UI để tắt nhanh
   (`is_enabled=false`) nếu phát sinh vấn đề.
6. **Giai đoạn 5 — theo dõi & cải thiện:** xem log định kỳ, bổ sung sản
   phẩm mới, tinh chỉnh mô tả/từ khoá để AI match tốt hơn.

---

## 10. Việc bạn cần cung cấp / quyết định

- **`ANTHROPIC_API_KEY`** (tài khoản Anthropic Console, tạo API key).
- **Danh sách sản phẩm ban đầu**: tên, mô tả, từ khoá tìm kiếm liên quan,
  link Shopee, giá (tối thiểu 3 mục đầu là bắt buộc để AI hoạt động được).
- **Quyết định**: chatbot áp dụng cho account nào trước (dev/test hay khách
  thật luôn)?
- **Ngưỡng chấp nhận rủi ro**: chấp nhận confidence bao nhiêu là gửi (mặc
  định gợi ý 0.6, có thể chỉnh sau khi xem log thật).

---

## 11. Tóm tắt kỹ thuật (cho người review code)

- Không thêm process/container mới — mọi logic nằm trong `zalo-bridge`
  Express service hiện có.
- Tái dùng tối đa pattern đã có: debounce-theo-key (như `imageBatches`),
  cache-theo-TTL (như `rulesCacheByAccount`), rate-limit-theo-account, log
  table riêng, gọi `sessionManager.sendMessage()` có sẵn để gửi tin — không
  cần đụng vào code zca-js/listener ngoài 1 dòng gọi thêm `chatbotEngine`.
- Model AI: `claude-haiku-4-5`, JSON output qua `output_config.format`
  (JSON Schema), catalog sản phẩm cache bằng `cache_control: ephemeral`.
  Không cần vector DB / embeddings ở quy mô "vài trăm sản phẩm".
