/**
 * POST /api/shopee/import
 *
 * Endpoint duy nhất mà Chrome extension `extension-shopee-crawl` gọi tới —
 * KHÔNG dùng cookie/session trình duyệt của người quản trị, xác thực bằng
 * header `X-API-Key` (so với env SHOPEE_SYNC_API_KEY, giống cơ chế
 * BRIDGE_API_KEY của zalo-bridge). Nếu env chưa set thì bỏ qua kiểm tra —
 * tiện cho dev local, PHẢI set trước khi lên production.
 *
 * Body:
 *   {
 *     shop_username: string,           // "beplain.vn" — dùng để match/tạo shopee_shops
 *     account_id?: string,             // gán shop cho account Zalo nào (chỉ cần lúc tạo mới)
 *     mode?: "upsert" | "patch",       // "upsert" (default) = crawl danh sách sản phẩm;
 *                                      // "patch" = chỉ cập nhật field (vd description) cho
 *                                      // sản phẩm đã có sẵn (bước "enrich" riêng, xem popup.js)
 *     items: Array<{
 *       shopee_item_id: string,
 *       shopee_shop_id?: string,
 *       name?: string,                // bắt buộc ở mode upsert
 *       price?: number | null,
 *       image_url?: string | null,
 *       sold_count?: number | null,
 *       rating?: number | null,
 *       shopee_url?: string,           // bắt buộc ở mode upsert
 *       description?: string | null,  // dùng ở mode patch
 *       raw?: unknown                 // item gốc Shopee trả về, lưu vào raw_data để debug/trích thêm field sau
 *     }>
 *   }
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  "";
const SYNC_API_KEY = process.env.SHOPEE_SYNC_API_KEY || "";

function sb(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      ...(init?.headers ?? {})
    }
  });
}

type ImportItem = {
  shopee_item_id?: string | number;
  shopee_shop_id?: string | number;
  name?: string;
  price?: number | null;
  image_url?: string | null;
  sold_count?: number | null;
  rating?: number | null;
  shopee_url?: string;
  description?: string | null;
  raw?: unknown;
};

async function findOrCreateShop(shopUsername: string, accountId: string | null) {
  const existingRes = await sb(
    `/shopee_shops?shop_username=eq.${encodeURIComponent(shopUsername)}&select=*`
  );
  const existing = existingRes.ok ? await existingRes.json() : [];
  if (Array.isArray(existing) && existing.length > 0) return existing[0];

  const row = {
    account_id: accountId,
    shop_username: shopUsername,
    shop_url: `https://shopee.vn/${shopUsername}`,
    display_name: shopUsername,
    status: "crawling"
  };
  const res = await sb("/shopee_shops", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(row)
  });
  if (!res.ok) throw new Error(await res.text());
  const [shop] = await res.json();
  return shop;
}

async function markShop(shopId: string, patch: Record<string, unknown>) {
  await sb(`/shopee_shops?id=eq.${encodeURIComponent(shopId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch)
  }).catch(() => {});
}

async function upsertProducts(shopId: string, accountId: string | null, items: ImportItem[]) {
  const rows = items
    .filter((it) => it.shopee_item_id && it.name && it.shopee_url)
    .map((it) => ({
      shop_id: shopId,
      account_id: accountId,
      shopee_item_id: String(it.shopee_item_id),
      shopee_shop_id: it.shopee_shop_id != null ? String(it.shopee_shop_id) : null,
      name: it.name,
      price: it.price ?? null,
      image_url: it.image_url ?? null,
      sold_count: it.sold_count ?? null,
      rating: it.rating ?? null,
      shopee_url: it.shopee_url,
      raw_data: it.raw ?? null
    }));
  if (rows.length === 0) return 0;

  const res = await sb("/products?on_conflict=shop_id,shopee_item_id", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation"
    },
    body: JSON.stringify(rows)
  });
  if (!res.ok) throw new Error(await res.text());
  const inserted = await res.json();
  return Array.isArray(inserted) ? inserted.length : rows.length;
}

/** mode=patch — chỉ cập nhật vài field (điển hình: description) cho sản phẩm đã có. */
async function patchProducts(shopId: string, items: ImportItem[]) {
  let updated = 0;
  for (const it of items) {
    if (!it.shopee_item_id) continue;
    const patch: Record<string, unknown> = {};
    if (typeof it.description !== "undefined") patch.description = it.description;
    if (typeof it.name === "string") patch.name = it.name;
    if (Object.keys(patch).length === 0) continue;
    const res = await sb(
      `/products?shop_id=eq.${encodeURIComponent(shopId)}&shopee_item_id=eq.${encodeURIComponent(
        String(it.shopee_item_id)
      )}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      }
    );
    if (res.ok) updated++;
  }
  return updated;
}

export async function POST(req: NextRequest) {
  if (!SUPABASE_URL || !KEY) {
    return NextResponse.json({ error: "supabase_unconfigured" }, { status: 500 });
  }
  if (SYNC_API_KEY) {
    const provided = req.headers.get("x-api-key") || "";
    if (provided !== SYNC_API_KEY) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const body = await req.json().catch(() => ({}));
  const shopUsername = String(body?.shop_username || "").trim();
  const accountId = body?.account_id ? String(body.account_id).trim() : null;
  const mode = body?.mode === "patch" ? "patch" : "upsert";
  const items: ImportItem[] = Array.isArray(body?.items) ? body.items : [];

  if (!shopUsername) {
    return NextResponse.json({ error: "shop_username là bắt buộc" }, { status: 400 });
  }
  if (items.length === 0) {
    return NextResponse.json({ error: "items rỗng — không có gì để lưu" }, { status: 400 });
  }

  try {
    const shop = await findOrCreateShop(shopUsername, accountId);

    if (mode === "patch") {
      const updated = await patchProducts(shop.id, items);
      return NextResponse.json({ ok: true, shop_id: shop.id, updated });
    }

    const imported = await upsertProducts(shop.id, shop.account_id ?? accountId, items);

    const countRes = await sb(
      `/products?shop_id=eq.${encodeURIComponent(shop.id)}&select=id&is_active=eq.true`,
      { headers: { Prefer: "count=exact" } }
    );
    const contentRange = countRes.headers.get("content-range"); // "0-49/123"
    const totalCount = contentRange ? Number(contentRange.split("/")[1]) || imported : imported;

    await markShop(shop.id, {
      status: "done",
      last_crawled_at: new Date().toISOString(),
      last_error: null,
      product_count: totalCount
    });

    return NextResponse.json({ ok: true, shop_id: shop.id, imported, total: totalCount });
  } catch (e) {
    const err = e as { message?: string };
    // Best-effort: đánh dấu shop lỗi nếu đã xác định được shop_username.
    try {
      const shop = await findOrCreateShop(shopUsername, accountId);
      await markShop(shop.id, { status: "error", last_error: err?.message || "unknown_error" });
    } catch {
      /* bỏ qua — đã lỗi từ trước, không cố gắng thêm */
    }
    return NextResponse.json({ error: err?.message || "import_failed" }, { status: 500 });
  }
}
