/**
 * GET    /api/shopee/shops/:id  → chi tiết 1 shop + toàn bộ sản phẩm của nó.
 * PATCH  /api/shopee/shops/:id  → sửa account_id (gán shop cho account Zalo
 *   nào) hoặc status thủ công.
 * DELETE /api/shopee/shops/:id  → xoá shop (cascade xoá theo toàn bộ sản
 *   phẩm của shop đó, xem FK ON DELETE CASCADE trong migration 0003).
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

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: RouteParams) {
  if (!SUPABASE_URL || !KEY) {
    return NextResponse.json({ error: "supabase_unconfigured" }, { status: 500 });
  }
  const { id } = await params;
  try {
    const shopRes = await sb(`/shopee_shops?id=eq.${encodeURIComponent(id)}&select=*`);
    const shopRows = shopRes.ok ? await shopRes.json() : [];
    const shop = Array.isArray(shopRows) ? shopRows[0] : null;
    if (!shop) {
      return NextResponse.json({ error: "Không tìm thấy shop" }, { status: 404 });
    }
    if (shop.account_id) {
      const staff = await getCurrentStaff(req);
      if (!canViewAccount(staff, shop.account_id)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }
    const productsRes = await sb(
      `/products?shop_id=eq.${encodeURIComponent(id)}&select=*&order=created_at.desc&limit=1000`
    );
    const products = productsRes.ok ? await productsRes.json() : [];
    return NextResponse.json({ shop, products });
  } catch (e) {
    const err = e as { message?: string };
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  if (!SUPABASE_URL || !KEY) {
    return NextResponse.json({ error: "supabase_unconfigured" }, { status: 500 });
  }
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};
  if (typeof body?.account_id !== "undefined") patch.account_id = body.account_id || null;
  if (typeof body?.status === "string") patch.status = body.status;
  if (typeof body?.display_name === "string") patch.display_name = body.display_name;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Không có gì để cập nhật" }, { status: 400 });
  }
  try {
    const res = await sb(`/shopee_shops?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(patch)
    });
    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json({ error: text || `supabase ${res.status}` }, { status: 500 });
    }
    const [shop] = await res.json();
    return NextResponse.json({ shop });
  } catch (e) {
    const err = e as { message?: string };
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  if (!SUPABASE_URL || !KEY) {
    return NextResponse.json({ error: "supabase_unconfigured" }, { status: 500 });
  }
  const { id } = await params;
  try {
    const res = await sb(`/shopee_shops?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json({ error: text || `supabase ${res.status}` }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const err = e as { message?: string };
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
