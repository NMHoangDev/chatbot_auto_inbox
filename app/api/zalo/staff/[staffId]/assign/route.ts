/**
 * POST /api/zalo/staff/[staffId]/assign
 *   body: { account_id, can_view?, can_send?, can_broadcast? }
 *   → upsert staff_zalo_assignments row
 * DELETE /api/zalo/staff/[staffId]/assign?account_id=...
 *   → xoá assignment
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
  const body = await req.json().catch(() => ({}));
  const accountId = String(body?.account_id || "").trim();
  if (!accountId) {
    return NextResponse.json({ error: "account_id required" }, { status: 400 });
  }
  if (!SUPABASE_URL || !KEY) {
    return NextResponse.json({ error: "supabase_unconfigured" }, { status: 500 });
  }
  try {
    // Verify zalo_accounts row tồn tại để tránh FK fail.
    const check = await sb(`/zalo_accounts?account_id=eq.${encodeURIComponent(accountId)}&select=account_id`);
    if (!check.ok || (await check.json()).length === 0) {
      return NextResponse.json(
        { error: "zalo_account không tồn tại — tạo tài khoản trước khi gán nhân viên" },
        { status: 400 }
      );
    }
    const row = {
      staff_id: staffId,
      account_id: accountId,
      can_view: body?.can_view !== false,
      can_send: body?.can_send !== false,
      can_broadcast: body?.can_broadcast === true
    };
    const res = await sb("/staff_zalo_assignments", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(row)
    });
    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json({ error: text || `supabase ${res.status}` }, { status: 500 });
    }
    return NextResponse.json({ ok: true, assignment: row });
  } catch (e) {
    const err = e as { message?: string };
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ staffId: string }> }
) {
  const { staffId } = await params;
  if (!isUuid(staffId)) {
    return NextResponse.json({ error: "Invalid staffId" }, { status: 400 });
  }
  const accountId = req.nextUrl.searchParams.get("account_id");
  if (!accountId) {
    return NextResponse.json({ error: "account_id query required" }, { status: 400 });
  }
  if (!SUPABASE_URL || !KEY) {
    return NextResponse.json({ error: "supabase_unconfigured" }, { status: 500 });
  }
  try {
    const res = await sb(
      `/staff_zalo_assignments?staff_id=eq.${staffId}&account_id=eq.${encodeURIComponent(accountId)}`,
      { method: "DELETE" }
    );
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
