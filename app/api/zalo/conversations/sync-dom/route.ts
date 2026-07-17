import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Endpoint nhận DOM scrape data từ extension-login-zalo (background.js → syncDom).
// Extension scrape trực tiếp từ Zalo Web sidebar → lấy group_name THẬT
// (không phụ thuộc zca-js getAllGroups() hay getCMRecent() — vốn đang fail
// do session/cookie issue trong bridge Node hiện tại).
//
// Module zalo cũ (Python) cũng làm đúng theo cách này: extension POST scrape
// data → backend upsert vào DB với tên thật → sidebar hiển thị đúng.
//
// Payload format (gửi từ extension-login-zalo/background.js syncDom):
//   {
//     account_id: "shop-owner",
//     conversations: [
//       {
//         group_id: "7019072243938899919" | "4686231406661695407",
//         group_name: "Tên nhóm thật" | "Tên user thật",
//         avatar_url?: string | null,
//         unread_count?: number,
//         is_friend?: boolean,    // true = 1:1 user, false/missing = group
//         thread_type?: "user" | "group",
//         messages?: [...],
//         ...
//       }
//     ]
//   }
//
// Convert → upsert vào zalo_conversations_ui với conversation_id = group_id raw.

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

interface DomScrapedConv {
  group_id?: string;
  conversation_id?: string;
  thread_id?: string;
  group_name?: string;
  conversation_name?: string;
  thread_type?: "user" | "group" | string;
  is_friend?: boolean;
  avatar_url?: string | null;
  unread_count?: number;
  messages?: Array<{
    sender_id?: string | null;
    sender_name?: string | null;
    content?: string | null;
    timestamp?: string | number | null;
    timestamp_text?: string | null;
    is_sent?: boolean;
    is_self?: boolean;
  }>;
}

function parseThreadType(c: DomScrapedConv): "user" | "group" {
  if (c.thread_type === "user" || c.thread_type === "group") return c.thread_type;
  if (c.is_friend === true) return "user";
  // Mặc định: is_friend undefined hoặc false → group (theo schema cũ zalo_groups)
  return "group";
}

function toConversationRow(c: DomScrapedConv, accountId: string) {
  const threadId = String(
    c.group_id || c.conversation_id || c.thread_id || ""
  ).trim();
  if (!threadId) return null;

  const threadType = parseThreadType(c);
  const groupName = c.group_name || c.conversation_name || "";
  const conversationName =
    groupName.trim() ||
    (threadType === "group" ? `Group ${threadId}` : `Zalo ${threadId}`);

  // Lấy latest message nếu có
  const msgs = Array.isArray(c.messages) ? c.messages : [];
  let latestContent: string | null = null;
  let latestSenderId: string | null = null;
  let latestIsSelf = false;
  let lastTs: number | null = null;
  if (msgs.length > 0) {
    const last = msgs[msgs.length - 1];
    latestContent = last?.content ?? null;
    latestSenderId = last?.sender_id ?? null;
    latestIsSelf = !!(last?.is_sent || last?.is_self);
    const rawTs = last?.timestamp ?? last?.timestamp_text ?? null;
    if (typeof rawTs === "number") lastTs = rawTs;
    else if (typeof rawTs === "string") {
      const n = Number(rawTs);
      if (Number.isFinite(n)) lastTs = n;
    }
  }

  return {
    account_id: accountId,
    thread_id: threadId,
    thread_type: threadType,
    conversation_id: threadId,
    conversation_name: conversationName,
    avatar_url: c.avatar_url ?? null,
    unread_count: Number(c.unread_count || 0),
    last_message_ts: lastTs,
    latest_message_at: lastTs ? new Date(lastTs).toISOString() : new Date().toISOString(),
    latest_content: latestContent,
    latest_sender_id: latestSenderId,
    latest_is_self: latestIsSelf,
    message_count: msgs.length,
    has_messages: msgs.length > 0,
    updated_at: new Date().toISOString(),
  };
}

export async function POST(req: NextRequest) {
  try {
    const picked = await pickKey();
    if (!picked) {
      return NextResponse.json({ ok: false, error: "no valid key", upserted: 0 }, { status: 200 });
    }
    const supabase = getSupabaseAdmin();
    const body = await req.json();
    const accountId: string = body?.account_id || "shop-owner";
    const conversations: DomScrapedConv[] = Array.isArray(body?.conversations) ? body.conversations : [];

    if (conversations.length === 0) {
      return NextResponse.json({ ok: true, upserted: 0 });
    }

    const rows = conversations
      .map((c) => toConversationRow(c, accountId))
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (rows.length === 0) {
      return NextResponse.json({ ok: true, upserted: 0, note: "no valid rows" });
    }

    const { data, error } = await supabase
      .from("zalo_conversations_ui")
      .upsert(rows, { onConflict: "account_id,conversation_id", ignoreDuplicates: false })
      .select("conversation_id,conversation_name");

    if (error) {
      console.warn("[zalo sync-dom POST]", error.message);
      return NextResponse.json({ ok: false, error: error.message, upserted: 0 }, { status: 200 });
    }

    console.log(
      `[zalo sync-dom] account=${accountId} in=${conversations.length} upserted=${data?.length || rows.length}`
    );
    return NextResponse.json({ ok: true, upserted: data?.length || rows.length });
  } catch (e: unknown) {
    const err = e as { message?: string };
    console.error("[zalo sync-dom POST]", err?.message);
    return NextResponse.json({ ok: false, error: err?.message }, { status: 200 });
  }
}