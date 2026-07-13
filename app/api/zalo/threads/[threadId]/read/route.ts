import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/zalo/threads/[threadId]/read
// Body: { account_id?: string }
// Khi user mở thread → mark read = reset unread_count = 0.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY;

let _cachedKey: { key: string; isService: boolean } | null = null;
async function pickKey(): Promise<{ key: string; isService: boolean } | null> {
  if (_cachedKey) return _cachedKey;
  const cands: { key: string; isService: boolean }[] = [];
  if (SUPABASE_SERVICE_ROLE_KEY) cands.push({ key: SUPABASE_SERVICE_ROLE_KEY, isService: true });
  if (SUPABASE_ANON_KEY && SUPABASE_ANON_KEY !== SUPABASE_SERVICE_ROLE_KEY) {
    cands.push({ key: SUPABASE_ANON_KEY, isService: false });
  }
  for (const c of cands) {
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/zalo_messages?select=source_message_id&limit=1`,
        { headers: { apikey: c.key, Authorization: `Bearer ${c.key}` } }
      );
      if (r.ok) {
        _cachedKey = c;
        return c;
      }
    } catch {}
  }
  return null;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ threadId: string }> }
) {
  try {
    const picked = await pickKey();
    if (!picked) {
      return NextResponse.json(
        { ok: false, error: "no valid key" },
        { status: 200 }
      );
    }
    const supabase = createClient(SUPABASE_URL!, picked.key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { threadId } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const accountId: string = body?.account_id || "shop-owner";

    if (!threadId) {
      return NextResponse.json({ ok: false, error: "missing threadId" }, { status: 200 });
    }

    // Reset unread_count về 0 trong zalo_conversations_ui
    const { error } = await supabase
      .from("zalo_conversations_ui")
      .update({ unread_count: 0, updated_at: new Date().toISOString() })
      .eq("account_id", accountId)
      .eq("thread_id", threadId);

    if (error) {
      console.warn("[zalo thread read POST]", error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 200 });
    }

    return NextResponse.json({ ok: true, thread_id: threadId });
  } catch (e) {
    const err = e as { message?: string };
    return NextResponse.json(
      { ok: false, error: err?.message || "unknown" },
      { status: 200 }
    );
  }
}
