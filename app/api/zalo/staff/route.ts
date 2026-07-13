/**
 * GET  /api/zalo/staff — list staff + assignments
 * POST /api/zalo/staff — create/update staff (admin only)
 *
 * Lưu ở Supabase bảng public.staff / staff_zalo_assignments (migration 2026-07-06).
 * Bridge không cần biết về staff — đây là data thuộc về web UI.
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

export async function GET(_req: NextRequest) {
  if (!SUPABASE_URL || !KEY) {
    return NextResponse.json({ staff: [], assignments: [], error: "supabase_unconfigured" });
  }
  try {
    const [staffRes, assignmentRes] = await Promise.all([
      sb("/staff?select=*&order=created_at"),
      sb("/staff_zalo_assignments?select=*")
    ]);
    const staff = staffRes.ok ? await staffRes.json() : [];
    const assignments = assignmentRes.ok ? await assignmentRes.json() : [];
    return NextResponse.json({ staff, assignments });
  } catch (e) {
    const err = e as { message?: string };
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  // Create or upsert staff by email. Body: { email, full_name, role }
  const staff = await getCurrentStaff(req);
  if (staff.role !== "admin") {
    return NextResponse.json({ error: "Chỉ admin mới được tạo/sửa nhân viên." }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const { email, full_name, role } = body || {};
  if (!email || !full_name) {
    return NextResponse.json({ error: "email + full_name required" }, { status: 400 });
  }
  if (!SUPABASE_URL || !KEY) {
    return NextResponse.json({ error: "supabase_unconfigured" }, { status: 500 });
  }
  try {
    const res = await sb("/staff", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=representation"
      },
      body: JSON.stringify({ email, full_name, role: role === "admin" ? "admin" : "staff" })
    });
    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json({ error: text || `supabase ${res.status}` }, { status: 500 });
    }
    let parsed: unknown = null;
    if (text && text.trim()) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return NextResponse.json({ staff: parsed });
  } catch (e) {
    const err = e as { message?: string };
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
