/**
 * PATCH  /api/shopee/products/:id  → sửa tay 1 sản phẩm (name, description,
 *   keywords, category, price, is_active) — dùng khi admin muốn chỉnh mô tả
 *   cho AI dễ match hơn, hoặc tắt (is_active=false) 1 sản phẩm hết hàng mà
 *   không muốn chatbot gợi ý nữa.
 * DELETE /api/shopee/products/:id → xoá hẳn 1 sản phẩm khỏi kho tri thức.
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

type RouteParams = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  if (!SUPABASE_URL || !KEY) {
    return NextResponse.json({ error: "supabase_unconfigured" }, { status: 500 });
  }
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};
  for (const field of ["name", "description", "category", "shopee_url", "image_url"] as const) {
    if (typeof body?.[field] === "string") patch[field] = body[field];
  }
  if (Array.isArray(body?.keywords)) {
    patch.keywords = body.keywords.map((k: unknown) => String(k).trim()).filter(Boolean);
  }
  if (typeof body?.price === "number") patch.price = body.price;
  if (typeof body?.is_active === "boolean") patch.is_active = body.is_active;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Không có gì để cập nhật" }, { status: 400 });
  }

  try {
    const res = await sb(`/products?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(patch)
    });
    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json({ error: text || `supabase ${res.status}` }, { status: 500 });
    }
    const [product] = await res.json();
    return NextResponse.json({ product });
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
    const res = await sb(`/products?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
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
