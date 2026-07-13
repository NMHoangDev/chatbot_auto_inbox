/**
 * POST /api/zalo/staff/[staffId]/reset-password
 *   Admin-only. Xoá password_hash của staff → lần đăng nhập kế tiếp của họ
 *   sẽ set mật khẩu mới (xem app/api/auth/zalo/me/route.ts).
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentStaff } from "@/lib/zalo/auth";

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

function isUuid(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ staffId: string }> }
) {
  const { staffId } = await params;
  if (!isUuid(staffId)) {
    return NextResponse.json({ error: "Invalid staffId" }, { status: 400 });
  }
  const staff = await getCurrentStaff(req);
  if (staff.role !== "admin") {
    return NextResponse.json({ error: "Chỉ admin mới được đặt lại mật khẩu." }, { status: 403 });
  }
  if (!SUPABASE_URL || !KEY) {
    return NextResponse.json({ error: "supabase_unconfigured" }, { status: 500 });
  }
  try {
    const res = await sb(`/staff?id=eq.${staffId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password_hash: null })
    });
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
