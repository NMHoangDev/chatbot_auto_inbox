"use client";

/**
 * Client dashboard cho /zalo/shopee-shops — quản lý "kho tri thức sản phẩm"
 * dùng để chatbot chọn đúng link Shopee gửi cho khách (xem CHATBOT-PLAN.md).
 *
 * Route này CHỈ tạo/liệt kê shop + xem sản phẩm đã crawl — việc crawl thật
 * (mở tab Shopee, bắt request, gửi kết quả lên /api/shopee/import) nằm ở
 * Chrome extension `extensions/extension-shopee-crawl` (xem README trong đó)
 * vì Shopee chặn crawl tự động thuần server (bị redirect captcha).
 */

import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Trash2
} from "lucide-react";
import { useEffect, useState } from "react";

type ShopeeShop = {
  id: string;
  account_id: string | null;
  shop_username: string;
  shop_url: string;
  display_name: string | null;
  status: "pending" | "crawling" | "done" | "error";
  last_crawled_at: string | null;
  last_error: string | null;
  product_count: number;
  created_at: string;
};

type Product = {
  id: string;
  name: string;
  price: number | null;
  sold_count: number | null;
  rating: number | null;
  image_url: string | null;
  shopee_url: string;
  description: string | null;
};

function statusPillCls(status: string) {
  switch (status) {
    case "done":
      return "bg-emerald-50 text-emerald-700";
    case "crawling":
      return "bg-amber-50 text-amber-700";
    case "error":
      return "bg-red-50 text-red-700";
    default:
      return "bg-slate-100 text-slate-600";
  }
}

const STATUS_LABEL: Record<string, string> = {
  pending: "Chưa crawl",
  crawling: "Đang crawl",
  done: "Đã crawl",
  error: "Lỗi"
};

function formatPrice(price: number | null) {
  if (price == null) return "—";
  return price.toLocaleString("vi-VN") + "đ";
}

export default function ZaloShopeeShopsDashboard() {
  const [shops, setShops] = useState<ShopeeShop[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [newShopUrl, setNewShopUrl] = useState("");
  const [newAccountId, setNewAccountId] = useState("");
  const [adding, setAdding] = useState(false);

  const [expandedShopId, setExpandedShopId] = useState<string | null>(null);
  const [productsByShop, setProductsByShop] = useState<Record<string, Product[]>>({});
  const [loadingProducts, setLoadingProducts] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const res = await fetch("/api/shopee/shops", { cache: "no-store" });
      const d = await res.json();
      setShops(d.shops || []);
      setError(d.error && !d.shops?.length ? d.error : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi tải dữ liệu.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function addShop() {
    if (!newShopUrl.trim()) return;
    setAdding(true);
    setNotice(null);
    try {
      const res = await fetch("/api/shopee/shops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shop_url: newShopUrl.trim(),
          account_id: newAccountId.trim() || undefined
        })
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Thêm shop thất bại");
      setNewShopUrl("");
      setNotice(
        d.created
          ? "Đã thêm shop — mở extension để bắt đầu crawl (xem hướng dẫn dưới)."
          : "Shop này đã có trong danh sách."
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Thêm shop thất bại.");
    } finally {
      setAdding(false);
    }
  }

  async function deleteShop(id: string) {
    if (!confirm("Xoá shop này và toàn bộ sản phẩm đã crawl?")) return;
    try {
      const res = await fetch(`/api/shopee/shops/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error || "Xoá thất bại");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Xoá thất bại.");
    }
  }

  async function toggleExpand(shop: ShopeeShop) {
    if (expandedShopId === shop.id) {
      setExpandedShopId(null);
      return;
    }
    setExpandedShopId(shop.id);
    if (!productsByShop[shop.id]) {
      setLoadingProducts(true);
      try {
        const res = await fetch(`/api/shopee/shops/${shop.id}`, { cache: "no-store" });
        const d = await res.json();
        setProductsByShop((prev) => ({ ...prev, [shop.id]: d.products || [] }));
      } catch {
        setProductsByShop((prev) => ({ ...prev, [shop.id]: [] }));
      } finally {
        setLoadingProducts(false);
      }
    }
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Kho tri thức sản phẩm Shopee</h1>
          <p className="mt-1 text-sm text-slate-500">
            Thêm link shop Shopee để crawl toàn bộ sản phẩm — chatbot sẽ dựa vào danh mục này
            để chọn đúng link sản phẩm trả lời khách.
          </p>
        </div>
        <button
          onClick={refresh}
          className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Tải lại
        </button>
      </div>

      {error && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
        </div>
      )}
      {notice && (
        <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          {notice}
        </div>
      )}

      <div className="mb-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-2 text-sm font-semibold text-slate-800">Thêm shop mới</div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={newShopUrl}
            onChange={(e) => setNewShopUrl(e.target.value)}
            placeholder="https://shopee.vn/tenshop hoặc tenshop"
            className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-primary"
          />
          <input
            value={newAccountId}
            onChange={(e) => setNewAccountId(e.target.value)}
            placeholder="account Zalo áp dụng (tuỳ chọn)"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-primary sm:w-56"
          />
          <button
            onClick={addShop}
            disabled={adding || !newShopUrl.trim()}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Thêm shop
          </button>
        </div>
      </div>

      <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800">
        <div className="mb-1 font-semibold">Cách crawl thật (bắt buộc dùng extension):</div>
        <ol className="ml-4 list-decimal space-y-1">
          <li>Mở Chrome, cài extension trong <code>extensions/extension-shopee-crawl</code> (mục Developer mode → Load unpacked).</li>
          <li>Đăng nhập Shopee bình thường ở tab Chrome đó.</li>
          <li>Mở popup extension → Cấu hình server (Backend URL + API Key, khớp với biến <code>SHOPEE_SYNC_API_KEY</code> trên server) → Lưu.</li>
          <li>Dán link shop vừa thêm ở trên vào popup → bấm &quot;Bắt đầu crawl&quot;. Kết quả tự đồng bộ về đây.</li>
        </ol>
      </div>

      <div className="space-y-3">
        {loading && shops.length === 0 && (
          <div className="flex items-center justify-center py-10 text-slate-400">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        )}

        {shops.map((shop) => (
          <div key={shop.id} className="rounded-lg border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <button
                onClick={() => toggleExpand(shop)}
                className="flex flex-1 items-center gap-3 text-left"
              >
                {expandedShopId === shop.id ? (
                  <ChevronUp className="h-4 w-4 shrink-0 text-slate-400" />
                ) : (
                  <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
                )}
                <div>
                  <div className="flex items-center gap-2 font-semibold text-slate-800">
                    {shop.display_name || shop.shop_username}
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${statusPillCls(shop.status)}`}>
                      {STATUS_LABEL[shop.status] || shop.status}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500">
                    {shop.product_count} sản phẩm
                    {shop.account_id ? ` · account: ${shop.account_id}` : ""}
                    {shop.last_error ? ` · lỗi: ${shop.last_error}` : ""}
                  </div>
                </div>
              </button>
              <a
                href={shop.shop_url}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 text-slate-400 hover:text-primary"
                title="Mở trang shop"
              >
                <ExternalLink className="h-4 w-4" />
              </a>
              <button
                onClick={() => deleteShop(shop.id)}
                className="shrink-0 text-slate-400 hover:text-red-600"
                title="Xoá shop"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>

            {expandedShopId === shop.id && (
              <div className="border-t border-slate-100 px-4 py-3">
                {loadingProducts && !productsByShop[shop.id] ? (
                  <div className="flex items-center justify-center py-6 text-slate-400">
                    <Loader2 className="h-4 w-4 animate-spin" />
                  </div>
                ) : (productsByShop[shop.id] || []).length === 0 ? (
                  <div className="py-4 text-center text-xs text-slate-400">
                    Chưa có sản phẩm nào — dùng extension để crawl shop này.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {(productsByShop[shop.id] || []).map((p) => (
                      <a
                        key={p.id}
                        href={p.shopee_url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex gap-2 rounded-lg border border-slate-100 p-2 hover:border-primary/40 hover:bg-primary/5"
                      >
                        {p.image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={p.image_url} alt="" className="h-12 w-12 shrink-0 rounded object-cover" />
                        ) : (
                          <div className="h-12 w-12 shrink-0 rounded bg-slate-100" />
                        )}
                        <div className="min-w-0">
                          <div className="truncate text-xs font-medium text-slate-800">{p.name}</div>
                          <div className="text-[11px] text-slate-500">
                            {formatPrice(p.price)}
                            {p.sold_count != null ? ` · đã bán ${p.sold_count}` : ""}
                            {p.rating != null ? ` · ★${p.rating}` : ""}
                          </div>
                        </div>
                      </a>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {!loading && shops.length === 0 && (
          <div className="py-10 text-center text-sm text-slate-400">
            Chưa có shop nào — thêm 1 link Shopee ở trên để bắt đầu.
          </div>
        )}
      </div>
    </div>
  );
}
