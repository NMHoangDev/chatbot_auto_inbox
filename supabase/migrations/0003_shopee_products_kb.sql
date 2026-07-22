-- ============================================================================
-- 0003_shopee_products_kb.sql
--
-- Kho tri thức sản phẩm (product knowledge base) cho chatbot tư vấn Zalo.
-- Nguồn dữ liệu: Chrome extension `extensions/extension-shopee-crawl` — crawl
-- trực tiếp trong 1 tab Shopee thật đang đăng nhập (bắt request
-- search_items/rcmd_items mà chính JS của trang Shopee tự phát ra khi cuộn/
-- phân trang). Không dùng API Shopee chính thức — Shopee ký các request đó
-- bằng header chống bot (af-ac-enc-dat/x-sap-sec) tính riêng ở phía trình
-- duyệt nên không gọi được từ server thuần (xem README extension).
--
-- shopee_shops : 1 dòng / 1 shop Shopee đã (hoặc đang) crawl.
-- products     : 1 dòng / 1 sản phẩm, thuộc 1 shop, dùng để chatbot chọn
--                đúng link + mô tả trả cho khách (xem CHATBOT-PLAN.md).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.shopee_shops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Account Zalo nào dùng danh mục của shop này để tư vấn khách — NULL nếu
  -- chưa gán (shop mới thêm, hoặc dùng chung cho nhiều account).
  account_id TEXT REFERENCES public.zalo_accounts(account_id) ON DELETE SET NULL,
  shop_username TEXT NOT NULL,          -- vd "beplain.vn", trích từ shop_url
  shop_url TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | crawling | done | error
  last_crawled_at TIMESTAMPTZ,
  last_error TEXT,
  product_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shop_username)
);

CREATE INDEX IF NOT EXISTS idx_shopee_shops_account ON public.shopee_shops(account_id);

DROP TRIGGER IF EXISTS trg_shopee_shops_updated ON public.shopee_shops;
CREATE TRIGGER trg_shopee_shops_updated
  BEFORE UPDATE ON public.shopee_shops
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.shopee_shops ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_shopee_shops" ON public.shopee_shops;
CREATE POLICY "anon_all_shopee_shops" ON public.shopee_shops FOR ALL USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES public.shopee_shops(id) ON DELETE CASCADE,
  -- Sao chép account_id từ shop lúc import để chatbotEngine query 1 bảng,
  -- không cần join, khi lọc catalog theo account đang chat.
  account_id TEXT REFERENCES public.zalo_accounts(account_id) ON DELETE SET NULL,
  shopee_item_id TEXT,
  shopee_shop_id TEXT,
  name TEXT NOT NULL,
  description TEXT,               -- lấy qua bước "enrich" riêng (xem popup.js) — có thể NULL
  keywords TEXT[] NOT NULL DEFAULT '{}',
  category TEXT,
  price NUMERIC,                  -- VNĐ, đã quy đổi (Shopee trả giá * 100000)
  sold_count INTEGER,
  rating NUMERIC,
  image_url TEXT,
  shopee_url TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  raw_data JSONB,                 -- item gốc từ Shopee — phòng khi cần trích thêm field sau
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shop_id, shopee_item_id)
);

CREATE INDEX IF NOT EXISTS idx_products_shop ON public.products(shop_id);
CREATE INDEX IF NOT EXISTS idx_products_account_active ON public.products(account_id) WHERE is_active;

DROP TRIGGER IF EXISTS trg_products_updated ON public.products;
CREATE TRIGGER trg_products_updated
  BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_products" ON public.products;
CREATE POLICY "anon_all_products" ON public.products FOR ALL USING (true) WITH CHECK (true);
