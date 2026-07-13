import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Tái sử dụng schema hiện có: bảng zalo_messages (xem supabase/migrations/...
// 2026-07-03_zalo_schema_normalize.sql). Mapping:
//   thread_id FE (Zalo String) → zalo_messages.group_id TEXT
//   account_id FE ('shop-owner') → zalo_messages.user_id TEXT (giữ backward compatible)
//   message_id → source_message_id (existing schema)
//   ts → timestamp (TIMESTAMPTZ) + ts (BIGINT — added by migration)
//   is_self FE → is_sent

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

// Thử service role trước, fallback anon (vì RLS migration đã allow "anon_all_*").
// Nếu service key trong env đã expired/rotated, request trả 401 "Invalid API key".
// Ta ping 1 query nhỏ, lưu key hợp lệ vào cache cho các request sau.
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
      const r = await fetch(`${SUPABASE_URL}/rest/v1/zalo_messages?select=id&limit=1`, {
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
  if (!SUPABASE_URL) {
    throw new Error("Supabase URL missing");
  }
  const key = _cachedKey?.key || SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
  if (!key) throw new Error("Supabase credentials missing");
  return createClient(SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

interface MessageInput {
  message_id?: string | null;
  client_id?: string | null;
  thread_id?: string | null;
  thread_type?: "user" | "group" | null;
  sender_id?: string | null;
  sender_name?: string | null;
  content?: string | null;
  ts?: number | string | null;
  type?: string | null;
  is_self?: boolean | null;
  attachments?: unknown;
  image_urls?: string[] | null;
  reply_to_id?: string | null;
  time_text?: string | null;
}

function toRow(m: MessageInput, accountId: string, threadId: string, threadType: string) {
  const tsNum = Number(m.ts) || Date.now();
  return {
    user_id: accountId,                       // backward-compat với schema cũ
    account_id: accountId,                    // NEW (added by normalize migration)
    group_id: threadId,                       // FE threadId → group_id
    thread_id: threadId,                      // NEW (added by normalize migration)
    thread_type: threadType,                  // NEW
    source_message_id: m.message_id || m.client_id || `local_${tsNum}_${Math.random().toString(36).slice(2, 8)}`,
    sender_id: m.sender_id ?? null,
    sender_name: m.sender_name ?? null,
    timestamp: new Date(tsNum).toISOString(), // TIMESTAMPTZ
    ts: tsNum,                                // BIGINT
    type: m.type || "webchat",
    content: m.content ?? "",
    image_urls: m.image_urls ?? [],
    reply_to_id: m.reply_to_id ?? null,
    is_sent: !!m.is_self,
    is_deleted: false,
    attachments: m.attachments ?? null,
    time_text: m.time_text ?? new Date(tsNum).toLocaleTimeString("vi-VN"),
  };
}

export async function GET(req: NextRequest) {
  try {
    const picked = await pickKey();
    if (!picked) {
      console.warn("[zalo messages GET] No valid Supabase key available");
      return NextResponse.json({ messages: [], total: 0, note: "no valid key" });
    }
    const supabase = getSupabaseAdmin();
    const accountId = req.nextUrl.searchParams.get("account_id") || "shop-owner";
    const threadId = req.nextUrl.searchParams.get("thread_id");
    const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") || 200), 1000);

    if (!threadId) {
      return NextResponse.json({ messages: [], total: 0, note: "missing thread_id" });
    }

    const { data, error } = await supabase
      .from("zalo_messages")
      .select("*")
      .eq("user_id", accountId)
      .eq("thread_id", threadId)
      .order("ts", { ascending: true })
      .limit(limit);

    if (error) {
      console.warn("[zalo messages GET]", error.message);
      return NextResponse.json({ messages: [], total: 0, note: error.message });
    }

    // Dedupe trước khi trả về — chống trường hợp DB có duplicate rows (vd
    // bridge persist + FE SSE save cùng message trước fix). Giữ row có
    // content dài nhất (row bridge thường lưu full content, row SSE echo
    // bị cắt 200 ký tự ở sessionManager.js).
    const rows = data || [];
    const seenById = new Map<string, typeof rows[number]>();
    const seenByContent = new Set<string>();
    for (const r of rows) {
      const id = String(r.source_message_id ?? "").trim();
      const isStableId = id.length > 0 && !id.startsWith("sse_") && !id.startsWith("local_");
      if (isStableId) {
        const existing = seenById.get(id);
        if (existing) {
          // Ưu tiên row có content dài hơn
          const winner =
            String(r.content ?? "").length > String(existing.content ?? "").length
              ? r
              : existing;
          seenById.set(id, winner);
          continue;
        }
        seenById.set(id, r);
        continue;
      }
      // Fallback key cho row cũ không có message_id ổn định
      const key = `${Number(r.ts ?? 0)}|${String(r.sender_id ?? "")}|${String(r.content ?? "").trim()}`;
      if (seenByContent.has(key)) continue;
      seenByContent.add(key);
      // Dùng id "fallback:<key>" để vẫn đi qua nhánh seenById nếu cần merge
      seenById.set(`fallback:${key}`, r);
    }
    const deduped = Array.from(seenById.values());

    return NextResponse.json({
      messages: deduped.map((r) => ({
        message_id: r.source_message_id,
        thread_id: r.thread_id || r.group_id,
        sender_id: r.sender_id,
        sender_name: r.sender_name,
        content: r.content,
        timestamp: r.timestamp,
        ts: r.ts,
        type: r.type,
        is_sent: r.is_sent,
        is_deleted: r.is_deleted || false,
        group_id: r.group_id || r.thread_id,
        image_urls: r.image_urls || [],
      })),
      total: deduped.length,
    });
  } catch (e: unknown) {
    const err = e as { message?: string };
    console.error("[zalo messages GET]", err?.message);
    return NextResponse.json({ messages: [], total: 0, note: err?.message });
  }
}

export async function POST(req: NextRequest) {
  try {
    const picked = await pickKey();
    if (!picked) {
      console.warn("[zalo messages POST] No valid Supabase key available");
      return NextResponse.json({ ok: false, error: "no valid key", upserted: 0 }, { status: 200 });
    }
    const supabase = getSupabaseAdmin();
    const body = await req.json();
    const accountId: string = body?.account_id || "shop-owner";
    const threadId: string = body?.thread_id || "";
    const threadType: string = body?.thread_type || "user";
    const messages: MessageInput[] = Array.isArray(body?.messages) ? body.messages : [];
    // insert_only=true: SSE dispatch gọi POST với flag này để KHÔNG overwrite row đã có
    // (tránh trường hợp server bridge save với is_self=true, sau đó SSE echo khác
    //  với is_self=false → upsert đè mất thông tin người gửi).
    const insertOnly: boolean = body?.insert_only === true;

    if (!threadId || messages.length === 0) {
      return NextResponse.json({ ok: true, upserted: 0 });
    }

    const rows = messages
      .filter((m) => m?.content !== undefined || m?.message_id)
      .map((m) => toRow(m, accountId, threadId, threadType));

    // ignoreDuplicates=true với insert_only: chỉ insert row mới, không update existing.
    const { data, error } = await supabase
      .from("zalo_messages")
      .upsert(rows, {
        onConflict: "user_id,source_message_id",
        ignoreDuplicates: insertOnly,
      })
      .select("source_message_id");

    if (error) {
      console.warn("[zalo messages POST]", error.message);
      return NextResponse.json({ ok: false, error: error.message, upserted: 0 }, { status: 200 });
    }

    // Side-effect: cập nhật zalo_conversations_ui với tin nhắn mới nhất
    // và tăng unread_count nếu !is_self (tin của người khác).
    // Chỉ chạy cho tin cuối cùng trong batch (rows[messages.length-1]).
    try {
      const lastRaw = messages[messages.length - 1];
      const lastRow = toRow(lastRaw, accountId, threadId, threadType);
      // conversation_id = thread_id raw (KHÔNG prefix g:/u:).
      // Đơn giản hoá: mọi thread (user + group) đều xử lý giống nhau.
      // Thread_type vẫn lưu DB để bridge biết cách gọi zca-js khi cần.
      const convId = threadId;

      // Đọc row hiện tại để giữ conversation_name + avatar_url (nếu có).
      // SSE không mang theo tên thread → KHÔNG được overwrite tên đã sync từ bridge.
      const { data: cur } = await supabase
        .from("zalo_conversations_ui")
        .select("unread_count,conversation_name,avatar_url,thread_type")
        .eq("account_id", accountId)
        .eq("conversation_id", convId)
        .maybeSingle();

      const nextUnread = lastRow.is_sent
        ? 0
        : (cur?.unread_count || 0) + 1;

      // thread_type "group" đã lưu trong DB luôn thắng threadType truyền vào body:
      // request FE (SSE handler) fallback "user" khi payload thiếu thread_type/isGroup
      // (xem useZalo.ts) — nếu để threadType đó thắng thì 1 group đã biết chắc (DB
      // đang "group") sẽ bị hạ cấp thành "user" mỗi khi có tin nhắn tới mà payload
      // thiếu marker group, xoá mất phân loại đúng vĩnh viễn (không có thread nào
      // đổi từ group sang user theo thời gian nên "group" trong DB luôn đáng tin hơn).
      const effectiveThreadType =
        cur?.thread_type === "group" ? "group" : threadType;

      // Giữ tên cũ nếu có; nếu chưa có thì fallback đơn giản.
      const fallbackName =
        effectiveThreadType === "group" ? `Group ${threadId}` : `Zalo ${threadId}`;

      await supabase
        .from("zalo_conversations_ui")
        .upsert(
          {
            account_id: accountId,
            thread_id: threadId,
            thread_type: effectiveThreadType,
            conversation_id: convId,
            // Ưu tiên: payload SSE (nếu có) > DB hiện tại > fallback
            conversation_name:
              (typeof (lastRaw as Record<string, unknown>)?.display_name === "string" &&
                (lastRaw as Record<string, unknown>).display_name) ||
              cur?.conversation_name ||
              fallbackName,
            avatar_url: cur?.avatar_url ?? null,
            last_message_ts: lastRow.ts,
            latest_message_at: new Date(lastRow.ts).toISOString(),
            latest_content: lastRow.content || null,
            latest_sender_id: lastRow.sender_id || null,
            latest_is_self: lastRow.is_sent,
            unread_count: nextUnread,
            has_messages: true,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "account_id,conversation_id" }
        );
    } catch (e) {
      // Không block POST nếu conversation upsert lỗi
      const err = e as { message?: string };
      console.warn("[zalo messages POST] conv_ui update failed:", err?.message);
    }

    return NextResponse.json({ ok: true, upserted: data?.length || rows.length });
  } catch (e: unknown) {
    const err = e as { message?: string };
    console.error("[zalo messages POST]", err?.message);
    return NextResponse.json({ ok: false, error: err?.message }, { status: 200 });
  }
}