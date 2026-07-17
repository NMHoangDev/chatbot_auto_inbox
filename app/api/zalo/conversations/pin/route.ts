import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Ghim/bỏ ghim 1 hội thoại — update trực tiếp is_pinned trên zalo_conversations_ui,
// KHÔNG đụng tới các field khác (khác với POST /api/zalo/conversations vốn upsert
// cả row cho mục đích cache định kỳ).

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY;

let _cachedKey: { key: string; isService: boolean } | null = null;

async function pickKey(): Promise<{ key: string; isService: boolean } | null> {
  if (_cachedKey) return _cachedKey;
  const candidates: { key: string; isService: boolean }[] = [];
  if (SUPABASE_SERVICE_ROLE_KEY) candidates.push({ key: SUPABASE_SERVICE_ROLE_KEY, isService: true });
  if (SUPABASE_ANON_KEY && SUPABASE_ANON_KEY !== SUPABASE_SERVICE_ROLE_KEY) {
    candidates.push({ key: SUPABASE_ANON_KEY, isService: false });
  }
  for (const c of candidates) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/zalo_conversations_ui?select=conversation_id&limit=1`, {
        headers: { apikey: c.key, Authorization: `Bearer ${c.key}` },
        next: { revalidate: 0 },
      });
      if (r.ok) {
        _cachedKey = c;
        return c;
      }
    } catch {
      // thử key tiếp theo
    }
  }
  return null;
}

function getSupabaseAdmin() {
  if (!SUPABASE_URL) throw new Error("Supabase URL missing");
  const key = _cachedKey?.key || SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
  if (!key) throw new Error("Supabase credentials missing");
  return createClient(SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function POST(req: NextRequest) {
  try {
    const picked = await pickKey();
    if (!picked) {
      return NextResponse.json({ ok: false, error: "no valid key" }, { status: 200 });
    }
    const supabase = getSupabaseAdmin();
    const body = await req.json();
    const accountId: string = body?.account_id || "shop-owner";
    // conversation_id có thể vẫn mang prefix "u:"/"g:" cũ — DB lưu dạng raw thread_id.
    const conversationId = String(body?.conversation_id || "").replace(/^[ug]:/, "");
    const isPinned = !!body?.is_pinned;

    if (!conversationId) {
      return NextResponse.json({ ok: false, error: "conversation_id is required" }, { status: 400 });
    }

    const { error } = await supabase
      .from("zalo_conversations_ui")
      .update({ is_pinned: isPinned, updated_at: new Date().toISOString() })
      .eq("account_id", accountId)
      .eq("conversation_id", conversationId);

    if (error) {
      console.warn("[zalo conversations pin]", error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 200 });
    }

    return NextResponse.json({ ok: true, is_pinned: isPinned });
  } catch (e: unknown) {
    const err = e as { message?: string };
    console.error("[zalo conversations pin]", err?.message);
    return NextResponse.json({ ok: false, error: err?.message }, { status: 200 });
  }
}
