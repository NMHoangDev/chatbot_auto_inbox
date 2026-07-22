/**
 * Trang quản lý "kho tri thức sản phẩm" (crawl từ Shopee) dùng cho chatbot
 * tư vấn tự động — xem CHATBOT-PLAN.md và
 * extensions/extension-shopee-crawl/README.md.
 */

import ZaloShopeeShopsDashboard from "@/components/zalo/ZaloShopeeShopsDashboard";

export const dynamic = "force-dynamic";

export default function ShopeeShopsPage() {
  return <ZaloShopeeShopsDashboard />;
}
