/**
 * GET  /api/shopee/shops?account_id=shop-owner
 *   → danh sách shop Shopee đã thêm (kèm product_count), lọc theo account_id
 *     nếu có truyền (không truyền = lấy tất cả).
 * POST /api/shopee/shops
 *   body: { shop_url: string, account_id?: string }
 *   → tạo (hoặc trả lại nếu đã có) 1 dòng "pending" cho shop này. Chưa crawl
 *     gì cả — người dùng cần mở Chrome (đã đăng nhập Shopee) + extension
 *     `extension-shopee-crawl` để thực sự chạy crawl (xem
 *     extensions/extension-shopee-crawl/README.md). Route này chỉ ghi nhận
 *     "muốn crawl shop nào" để UI hiển thị + để extension đối chiếu.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentStaff, canViewAccount } from "@/lib/zalo/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  "";

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

/** "https://shopee.vn/beplain.vn" hoặc "beplain.vn" -> "beplain.vn" */
function extractShopUsername(input: string): string {
  const trimmed = input.trim();
  const m = trimmed.match(/shopee\.vn\/([^/?#]+)/);
  return (m ? m[1] : trimmed).replace(/^@/, "");
}

export async function GET(req: NextRequest) {
  if (!SUPABASE_URL || !KEY) {
    return NextResponse.json({ shops: [], error: "supabase_unconfigured" });
  }
  const accountId = req.nextUrl.searchParams.get("account_id");
  if (accountId) {
    const staff = await getCurrentStaff(req);
    if (!canViewAccount(staff, accountId)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }
  try {
    const filter = accountId ? `&account_id=eq.${encodeURIComponent(accountId)}` : "";
    const res = await sb(`/shopee_shops?select=*${filter}&order=created_at.desc`);
    const shops = res.ok ? await res.json() : [];
    return NextResponse.json({ shops });
  } catch (e) {
    const err = e as { message?: string };
    return NextResponse.json({ shops: [], error: err?.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!SUPABASE_URL || !KEY) {
    return NextResponse.json({ error: "supabase_unconfigured" }, { status: 500 });
  }
  const body = await req.json().catch(() => ({}));
  const shopUrlInput = String(body?.shop_url || "").trim();
  const accountId = body?.account_id ? String(body.account_id).trim() : null;
  if (!shopUrlInput) {
    return NextResponse.json({ error: "shop_url là bắt buộc" }, { status: 400 });
  }
  const shopUsername = extractShopUsername(shopUrlInput);
  if (!shopUsername) {
    return NextResponse.json({ error: "Không đọc được username shop từ link" }, { status: 400 });
  }
  const shopUrl = shopUsername.startsWith("http")
    ? shopUsername
    : `https://shopee.vn/${shopUsername}`;

  if (accountId) {
    const staff = await getCurrentStaff(req);
    if (!canViewAccount(staff, accountId)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  try {
    // Đã có shop này rồi (theo username) -> trả lại dòng cũ, không tạo trùng.
    const existingRes = await sb(
      `/shopee_shops?shop_username=eq.${encodeURIComponent(shopUsername)}&select=*`
    );
    const existing = existingRes.ok ? await existingRes.json() : [];
    if (Array.isArray(existing) && existing.length > 0) {
      return NextResponse.json({ shop: existing[0], created: false });
    }

    const row = {
      account_id: accountId,
      shop_username: shopUsername,
      shop_url: shopUrl,
      display_name: shopUsername,
      status: "pending"
    };
    const res = await sb("/shopee_shops", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(row)
    });
    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json({ error: text || `supabase ${res.status}` }, { status: 500 });
    }
    const [shop] = await res.json();
    return NextResponse.json({ shop, created: true });
  } catch (e) {
    const err = e as { message?: string };
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
