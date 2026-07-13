/**
 * GET /api/zalo/forward-rules/[id]/logs?limit=30
 *   → log gần nhất của 1 rule (để UI hiển thị trạng thái forward gần đây).
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

function ruleIdOf(id: string): number | null {
  return /^\d+$/.test(id) ? Number(id) : null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ruleId = ruleIdOf(id);
  if (ruleId == null) return NextResponse.json({ error: "Invalid rule id" }, { status: 400 });
  if (!SUPABASE_URL || !KEY) {
    return NextResponse.json({ logs: [], error: "supabase_unconfigured" });
  }

  const ruleRes = await sb(`/zalo_forward_rules?id=eq.${ruleId}&select=account_id`);
  const [rule] = ruleRes.ok ? await ruleRes.json() : [];
  if (!rule) return NextResponse.json({ logs: [] });

  const staff = await getCurrentStaff(req);
  if (!canViewAccount(staff, rule.account_id)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") || 30), 200);
  try {
    const res = await sb(
      `/zalo_forward_logs?rule_id=eq.${ruleId}&select=*&order=created_at.desc&limit=${limit}`
    );
    const logs = res.ok ? await res.json() : [];
    return NextResponse.json({ logs });
  } catch (e) {
    const err = e as { message?: string };
    return NextResponse.json({ logs: [], error: err?.message }, { status: 500 });
  }
}
