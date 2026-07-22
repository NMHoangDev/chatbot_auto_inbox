/**
 * GET /api/shopee/products?shop_id=...&account_id=...&q=...
 *   → danh sách sản phẩm trong kho tri thức, lọc theo shop_id và/hoặc
 *     account_id, tìm theo tên (q, ILIKE) nếu có. Dùng cho UI quản trị xem
 *     lại/sửa sản phẩm sau khi crawl — chatbotEngine (sẽ thêm sau, xem
 *     CHATBOT-PLAN.md) đọc thẳng Supabase từ services/zalo-bridge, không
 *     qua route này.
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

export async function GET(req: NextRequest) {
  if (!SUPABASE_URL || !KEY) {
    return NextResponse.json({ products: [], error: "supabase_unconfigured" });
  }
  const shopId = req.nextUrl.searchParams.get("shop_id");
  const accountId = req.nextUrl.searchParams.get("account_id");
  const q = req.nextUrl.searchParams.get("q");
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit")) || 200, 1000);

  const filters: string[] = [];
  if (shopId) filters.push(`shop_id=eq.${encodeURIComponent(shopId)}`);
  if (accountId) filters.push(`account_id=eq.${encodeURIComponent(accountId)}`);
  if (q) filters.push(`name=ilike.${encodeURIComponent(`*${q}*`)}`);

  try {
    const path = `/products?select=*&order=updated_at.desc&limit=${limit}${
      filters.length ? "&" + filters.join("&") : ""
    }`;
    const res = await sb(path);
    const products = res.ok ? await res.json() : [];
    return NextResponse.json({ products });
  } catch (e) {
    const err = e as { message?: string };
    return NextResponse.json({ products: [], error: err?.message }, { status: 500 });
  }
}
