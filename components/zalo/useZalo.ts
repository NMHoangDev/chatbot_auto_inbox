/**
 * useZalo - Custom hook cho toàn bộ logic Zalo.
 * - Polling trạng thái đăng nhập mỗi 5s
 * - Quản lý conversations, messages, broadcast
 * - Subscribe SSE cho real-time events
 *
 * PHASE 2: Hook đọc `currentAccountId` từ AppContext (multi-account). Khi
 * account đổi → toàn bộ state reset + refetch từ Supabase. Backward compat:
 * nếu AppProvider chưa wrap (test đơn lẻ) → fallback "shop-owner".
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  zaloApi,
  ZaloApiError,
  ZaloBroadcastResponse,
  ZaloBroadcastStatus,
  ZaloBroadcastTarget,
  ZaloConversation,
  ZaloLoginStatus,
  ZaloMessage,
} from "@/lib/zalo-api";
import { useApp } from "@/components/providers/AppProvider";

const POLL_INTERVAL_MS = 5_000;
const DEFAULT_ACCOUNT_ID = "shop-owner";

// ── Dedupe messages ──────────────────────────────────────────────────────
// UI /thong-bao-zalo từng bị duplicate messages khi cùng 1 message thật
// được persist bởi bridge (source_message_id = Zalo msgId) đồng thời được
// FE SSE handler save lại với source_message_id ngẫu nhiên (trước fix). Hai
// row cùng nội dung cùng ts trong zalo_messages → GET /api/zalo/messages
// trả về 2 row → render 2 lần.
//
// Helper này dedupe theo message_id trước, fallback theo (ts+sender+content)
// để chống cả các row SSE cũ (không có message_id thật) đã có sẵn trong DB
// từ trước khi fix. Idempotent — gọi nhiều lần vẫn OK.
function dedupeMessages(list: ZaloMessage[]): ZaloMessage[] {
  if (!Array.isArray(list) || list.length <= 1) return list;
  const seenById = new Map<string, ZaloMessage>();
  const seenByContent = new Set<string>();
  const out: ZaloMessage[] = [];
  for (const m of list) {
    const id = m.message_id ? String(m.message_id).trim() : "";
    if (id && id.length > 0 && !id.startsWith("sse_") && !id.startsWith("local_")) {
      const existing = seenById.get(id);
      if (existing) {
        // Merge: giữ row có is_sent đúng hơn, content đầy đủ hơn
        // (ví dụ: row từ bridge có full content, row từ SSE echo bị cắt 200 ký tự).
        const curContent = (existing.content ?? "").length;
        const newContent = (m.content ?? "").length;
        const winner = newContent >= curContent ? m : existing;
        const idx = out.indexOf(existing);
        if (idx >= 0) out[idx] = winner;
        seenById.set(id, winner);
        continue;
      }
      seenById.set(id, m);
      out.push(m);
      continue;
    }
    // Fallback key cho row cũ không có message_id ổn định
    // ZaloMessage không có field `ts` ổn định trong type, dùng timestamp (ISO).
    // Normalize timestamp → millis để so sánh đáng tin cậy hơn.
    const tsRaw = m.timestamp ? new Date(m.timestamp).getTime() : 0;
    const ts = Number.isFinite(tsRaw) ? tsRaw : 0;
    const sender = String(m.sender_id ?? "");
    const content = String(m.content ?? "").trim();
    const key = `${ts}|${sender}|${content}`;
    if (seenByContent.has(key)) continue;
    seenByContent.add(key);
    out.push(m);
  }
  return out;
}

// ── Sort conversations ─────────────────────────────────────────────────────
// Đảm bảo hội thoại có tin nhắn GẦN NHẤT luôn hiển thị lên đầu.
//
// Ưu tiên nguồn timestamp (càng chính xác càng tốt):
//   1. latest_message_at (ISO từ DB / SSE) — chính xác nhất vì cache Supabase persist
//   2. last_message_ts (epoch ms do bridge update) — fallback từ Zalo payload
//   3. 0 (row chưa từng có tin) — luôn nằm dưới cùng.
//
// API backend SQL đã ORDER BY last_message_ts DESC, nhưng:
//   - Bridge / SSE có thể trả rows theo thứ tự khác.
//   - Sau khi setMessages khi mở thread, state local có thể "stale sort"
//     (vd thread nhận tin mới qua SSE nhưng không refresh state).
// Hàm này IDEMPOTENT — gọi sau mỗi refresh/SSE/gửi tin để UI luôn đúng thứ tự.
function sortConversationsByLatestMessage(
  list: ZaloConversation[]
): ZaloConversation[] {
  if (!Array.isArray(list) || list.length <= 1) return list;
  // Dùng epoch ms để so sánh chính xác dù latest_message_at là ISO string.
  const tsOf = (c: ZaloConversation): number => {
    const iso = c.latest_message_at;
    if (iso) {
      const t = new Date(iso).getTime();
      if (Number.isFinite(t) && t > 0) return t;
    }
    const raw = c.last_message_ts;
    if (raw !== undefined && raw !== null && raw !== "") {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
  };
  // DESC: thread có timestamp lớn (mới hơn) → đứng trước.
  return [...list].sort((a, b) => tsOf(b) - tsOf(a));
}

// ── Supabase persistence ────────────────────────────────────────────────────
// Cache conversations lên Supabase để restore khi refresh page + cross-device.
// Endpoint Next.js API: POST /api/zalo/conversations { conversations: [...] }
async function saveConversationsToSupabase(list: ZaloConversation[], accountId: string) {
  if (typeof window === "undefined") return;
  if (!Array.isArray(list) || list.length === 0) return;
  try {
    await fetch("/api/zalo/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversations: list, account_id: accountId }),
      keepalive: true,
    });
  } catch (err) {
    // Không cần log lỗi mạng — chỉ là cache fallback.
    if (typeof window !== "undefined") {
      // eslint-disable-next-line no-console
      console.debug("[zalo] saveConversationsToSupabase failed:", err);
    }
  }
}

// Đảm bảo conversation row tồn tại trong zalo_conversations_ui.
// Dùng khi SSE nhận message mà thread CHƯA CÓ row nào trong DB (vd group vừa
// nhắn, session bridge chưa sync, hoặc người lạ). Tránh hiển thị thread với
// ID thô ở sidebar/chat header.
//
// Cơ chế: kiểm tra DB trước (GET), chỉ POST nếu chưa có. POST upsert dùng
// conversation_id = thread_id raw → không phân biệt user/group.
async function requestExtensionDomSync(accountId: string): Promise<boolean> {
  if (typeof window === "undefined") return false;
  // Extension chỉ load page-bridge.js trên các origin trong manifest:
  // localhost, 127.0.0.1, *.zenithglobal.dev, *.markeeai.com. Tự kiểm tra
  // để tránh gọi vô ích vào trang không có extension.
  const allowed =
    /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?$/.test(window.location.host) ||
    /(zenithglobal\.dev|markeeai\.com)$/.test(window.location.host);
  if (!allowed) return false;
  // Đợi page-bridge sẵn sàng (tối đa 500ms).
  for (let i = 0; i < 10; i++) {
    if ((window as unknown as { __markeeZaloBridgeLoaded?: boolean }).__markeeZaloBridgeLoaded) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return new Promise((resolve) => {
    const requestId = `sync-dom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const handler = (event: MessageEvent) => {
      const data = event.data;
      if (!data || data.__zaloExt !== true) return;
      if (data.type === "RESPONSE" && data.requestId === requestId) {
        window.removeEventListener("message", handler);
        resolve(!!data.success);
      }
    };
    window.addEventListener("message", handler);
    window.postMessage(
      {
        __zaloExt: true,
        type: "SYNC_ZALO_DOM_MESSAGES",
        requestId,
        data: {
          account_id: accountId,
          limit: 50,
          conversation_limit: 30,
        },
      },
      window.location.origin,
    );
    setTimeout(() => {
      window.removeEventListener("message", handler);
      resolve(false);
    }, 15_000);
  });
}

// Regex nhận diện tên thread fallback do hệ thống tự generate khi chưa có
// data thật từ Zalo. Pattern: "Group <digits>" / "Zalo <digits>" — không
// có chữ cái/emoji. Nếu row đã có nhưng tên thuộc dạng này → cho phép
// re-resolve qua bridge /group-info (group) hoặc sender_name (user) để cập
// nhật tên thật, tránh kẹt vĩnh viễn ở tên placeholder.
const FALLBACK_NAME_RE = /^(Group|Zalo)\s+\d+$/;

async function ensureConversationInSupabase(
  threadId: string,
  threadType: "user" | "group",
  accountId: string,
  fallbackName?: string,
  latest?: {
    ts?: number | null;
    content?: string | null;
    senderId?: string | null;
    isSelf?: boolean;
  }
): Promise<void> {
  if (typeof window === "undefined" || !threadId) return;
  // eslint-disable-next-line no-console
  console.log(
    `[ZALO_FE][ENSURE_BEGIN] threadId=${threadId} type=${threadType} fallback="${fallbackName || ""}"`
  );
  try {
    // 1) Kiểm tra đã có chưa
      const check = await fetch(
        `/api/zalo/conversations?account_id=${encodeURIComponent(accountId)}&limit=1000`,
        { cache: "no-store" }
      );
    let existing: {
      conversation_id?: string;
      thread_id?: string;
      conversation_name?: string | null;
      avatar_url?: string | null;
      thread_type?: string | null;
    } | null = null;
    if (check.ok) {
      const data = await check.json();
      existing =
        (data?.conversations || []).find(
          (c: {
            conversation_id?: string;
            thread_id?: string;
          }) =>
            c.conversation_id === threadId || c.thread_id === threadId
        ) || null;
    }
    // Row tồn tại VÀ tên đã "thật" (không phải fallback VÀ không trùng
    // với sender_name hiện tại) → skip. Trường hợp sender_name === name
    // là dấu hiệu row được upsert trước đó bằng fallback sender_name (vì
    // bridge /group-info không trả data), không phải tên group thật.
    const isFallbackName =
      !existing?.conversation_name ||
      FALLBACK_NAME_RE.test(existing.conversation_name.trim()) ||
      (!!fallbackName &&
        existing.conversation_name.trim() === fallbackName.trim());
    // Lệch thread_type: caller chắc chắn đây là group (tín hiệu từ SSE/bridge
    // — KHÔNG phải default "user" đoán mò của openConversation) nhưng row DB
    // đang lưu "user" → tên hiện tại (nếu có) thực chất là sender_name bị lưu
    // nhầm thành conversation_name lúc trước đó cũng bị đoán sai type. Phải
    // coi như fallback để retry /group-info + ghi đè lại thread_type đúng,
    // nếu không sẽ kẹt vĩnh viễn (tên người hiển thị cho 1 group).
    const hasWrongType =
      threadType === "group" && !!existing?.thread_type && existing.thread_type !== "group";
    const needsResolve = isFallbackName || hasWrongType;
    // Thread_type "group" đã lưu trong DB là tín hiệu đáng tin cậy hơn threadType
    // do caller TRUYỀN VÀO — vì threadType nhiều lúc chỉ là guess ("user" mặc định
    // của openConversation khi thread chưa có trong local state, xem useZalo.ts
    // openConversation). Nếu để threadType (guess) thắng, 1 group đã resolve tên
    // thật trước đó sẽ bị ENSURE_CONV ghi đè lại thành thread_type="user" +
    // name="Zalo <id>" — đúng bug "mất tên group, hiện lại Group/Zalo <id>" khi
    // mở lại conversation sau khi state local bị reset (vd đổi/nối tài khoản Zalo).
    // Type thật của 1 thread Zalo (user/group) không đổi theo thời gian nên 1 khi
    // đã biết là "group" thì luôn ưu tiên, guess "user" không được phép hạ cấp nó.
    const effectiveThreadType: "user" | "group" =
      existing?.thread_type === "group" ? "group" : threadType;
    if (existing && !needsResolve) {
      // eslint-disable-next-line no-console
      console.log(
        `[ZALO_FE][ENSURE_SKIP] threadId=${threadId} already in DB name="${existing.conversation_name}"`
      );
      return;
    }
    if (existing && needsResolve) {
      // eslint-disable-next-line no-console
      console.log(
        `[ZALO_FE][ENSURE_RETRY] threadId=${threadId} current_name="${existing.conversation_name}" current_type="${existing.thread_type}" wrongType=${hasWrongType} — try /group-info`
      );
    }
    // 2) Row chưa có HOẶC tên là fallback → resolve tên thật:
    //    - Group: gọi bridge /group-info để lấy tên nhóm + avatar
    //    - User: dùng sender_name từ SSE (thường là tên người gửi)
    let resolvedName: string | undefined = fallbackName;
    let resolvedAvatar: string | null = existing?.avatar_url ?? null;
    if (effectiveThreadType === "group") {
      try {
        const info = await zaloApi.getGroupInfo(threadId, accountId);
        if (info?.ok) {
          resolvedName = info.group_name;
          resolvedAvatar = info.avatar_url;
          // eslint-disable-next-line no-console
          console.log(
            `[ZALO_FE][GROUP_NAME] threadId=${threadId} name="${resolvedName}"`
          );
        } else {
          // eslint-disable-next-line no-console
          console.log(
            `[ZALO_FE][GROUP_NAME_FALLBACK] threadId=${threadId} using sender_name — try DOM scrape`
          );
          // Bridge không có data (session/cookie issue). Trigger extension
          // scrape DOM từ Zalo Web → sẽ upsert row trực tiếp với group_name
          // thật vào zalo_conversations_ui. Skip upsert fallback.
          const ok = await requestExtensionDomSync(accountId);
          // eslint-disable-next-line no-console
          console.log(
            `[ZALO_FE][DOM_SCRAPE] threadId=${threadId} ok=${ok}`
          );
          if (ok) {
            return; // route /sync-dom đã upsert row trực tiếp
          }
        }
      } catch (e) {
        // bridge offline → fallback
        // eslint-disable-next-line no-console
        console.warn(
          `[ZALO_FE][GROUP_NAME_ERR] threadId=${threadId}`,
          e instanceof Error ? e.message : e
        );
      }
    } else if (!resolvedName || FALLBACK_NAME_RE.test(resolvedName.trim())) {
      // USER (DM): không có sender_name dùng được (vd người lạ nhắn tin chờ,
      // dName chưa kịp populate lúc SSE bắn) → gọi bridge /user-info để lấy
      // tên thật, tương tự /group-info cho group. Trước đây nhánh này không
      // có gì → conv kẹt vĩnh viễn ở tên fallback "Zalo <id>".
      try {
        const info = await zaloApi.getUserInfo(threadId, accountId);
        if (info?.ok) {
          resolvedName = info.user_name;
          resolvedAvatar = info.avatar_url;
          // eslint-disable-next-line no-console
          console.log(
            `[ZALO_FE][USER_NAME] threadId=${threadId} name="${resolvedName}"`
          );
        } else {
          // Bridge /user-info gọi ZCA `friend/getprofiles/v2` — endpoint này
          // CHỈ trả hồ sơ cho người đã là bạn bè trên Zalo. Người lạ nhắn tin
          // (chưa kết bạn) sẽ luôn fail ở đây bất kể retry bao nhiêu lần (ZCA
          // trả code:112). Fallback giống hệt group: nhờ extension scrape tên
          // thật trực tiếp từ DOM Zalo Web (không bị giới hạn "phải là bạn bè"
          // như API) — nếu thành công, route /sync-dom tự upsert row nên bỏ
          // qua phần ghi "Zalo <id>" bên dưới.
          // eslint-disable-next-line no-console
          console.log(
            `[ZALO_FE][USER_NAME_FALLBACK] threadId=${threadId} using DOM scrape (not a Zalo friend, friend-profile API can't resolve)`
          );
          const ok = await requestExtensionDomSync(accountId);
          // eslint-disable-next-line no-console
          console.log(
            `[ZALO_FE][DOM_SCRAPE] threadId=${threadId} ok=${ok}`
          );
          if (ok) {
            return; // route /sync-dom đã upsert row trực tiếp
          }
        }
      } catch (e) {
        // bridge offline → fallback
        // eslint-disable-next-line no-console
        console.warn(
          `[ZALO_FE][USER_NAME_ERR] threadId=${threadId}`,
          e instanceof Error ? e.message : e
        );
      }
    }
    const finalName =
      resolvedName || (effectiveThreadType === "group" ? `Group ${threadId}` : `Zalo ${threadId}`);
    const conv = {
      conversation_id: threadId,
      thread_id: threadId,
      thread_type: effectiveThreadType,
      conversation_name: finalName,
      account_id: accountId,
      avatar_url: resolvedAvatar,
      last_message_ts: latest?.ts || Date.now(),
      latest_message_at: new Date(latest?.ts || Date.now()).toISOString(),
      latest_content: latest?.content || null,
      latest_sender_id: latest?.senderId || null,
      latest_is_self: !!latest?.isSelf,
      unread_count: latest?.isSelf ? 0 : 1,
      has_messages: true,
    };
    const postRes = await fetch("/api/zalo/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversations: [conv], account_id: accountId }),
      keepalive: true,
    });
    const action = existing ? "updated" : "inserted";
    // eslint-disable-next-line no-console
    console.log(
      `[ZALO_FE][ENSURE_CONV] threadId=${threadId} type=${effectiveThreadType} action=${action} name="${finalName}" upsert=${postRes.status}`
    );
  } catch (err) {
    // Dùng console.error để chắc chắn hiện (debug có thể bị tắt trong prod).
    // eslint-disable-next-line no-console
    console.error(
      `[ZALO_FE][ENSURE_FAILED] threadId=${threadId} type=${threadType}`,
      err instanceof Error ? `${err.name}: ${err.message}` : err
    );
  }
}

async function saveMessagesToSupabase(
  threadId: string,
  list: unknown[],
  accountId: string,
  opts: { insertOnly?: boolean; threadType?: "user" | "group" } = {}
) {
  if (typeof window === "undefined") return;
  if (!threadId || !Array.isArray(list) || list.length === 0) return;
  try {
    await fetch("/api/zalo/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: accountId,
        thread_id: threadId,
        // QUAN TRỌNG: truyền thread_type để route biết upsert vào
        // zalo_conversations_ui với thread_type chính xác (group/user).
        // Nếu thiếu → route fallback "user" → row group trong DB bị lưu
        // với thread_type=user → bug sidebar không hiển thị group.
        thread_type: opts.threadType || "user",
        messages: list,
        insert_only: !!opts.insertOnly,
      }),
      keepalive: true,
    });
  } catch (err) {
    if (typeof window !== "undefined") {
      // eslint-disable-next-line no-console
      console.debug("[zalo] saveMessagesToSupabase failed:", err);
    }
  }
}

export function useZalo() {
  const { currentAccountId } = useApp();

  // Resolve accountId: ưu tiên context → fallback "shop-owner" cho backward compat.
  const accountId = currentAccountId || DEFAULT_ACCOUNT_ID;

  const [loginStatus, setLoginStatus] = useState<ZaloLoginStatus | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [conversations, setConversations] = useState<ZaloConversation[]>([]);
  const [loadingConvs, setLoadingConvs] = useState(false);

  const [openConvId, setOpenConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ZaloMessage[]>([]);
  const [loadingChat, setLoadingChat] = useState(false);
  const [sending, setSending] = useState(false);

  const [replyText, setReplyText] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);

  // Ref mirror của currentAccountId — phòng trường hợp SSE / saveMessagesToSupabase
  // nhận event trước khi re-render propagate accountId mới vào closure.
  const accountIdRef = useRef(accountId);
  useEffect(() => {
    accountIdRef.current = accountId;
  }, [accountId]);

  // Ref mirror của openConvId để tránh stale closure trong SSE dispatch.
  // SSE attach 1 lần duy nhất; nếu chỉ đọc openConvId từ closure thì nó bị "đóng băng"
  // tại giá trị lúc attach (thường là null) → mọi new_message đều không khớp thread đang mở.
  const openConvIdRef = useRef<string | null>(null);
  useEffect(() => {
    openConvIdRef.current = openConvId;
  }, [openConvId]);

  // Ref mirror của conversations — SSE cần check conversation_id đã có chưa
  // để quyết định có gọi syncConversations() lấy tên thật hay không.
  const conversationsRef = useRef<ZaloConversation[]>([]);
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  const [broadcasting, setBroadcasting] = useState(false);
  const [broadcastCampaignId, setBroadcastCampaignId] = useState<string | null>(
    null
  );
  // Khi gửi: lưu response đầu tiên (ZaloBroadcastResponse có total_targets).
  // Trong lúc polling: cập nhật bằng ZaloBroadcastStatus (sent/total).
  // Union để UI lấy max(total_targets, total) khi hiển thị.
  const [broadcastStatus, setBroadcastStatus] = useState<
    (ZaloBroadcastResponse | ZaloBroadcastStatus) | null
  >(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const showToast = useCallback((msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }, []);

  // ── Polling login status ────────────────────────────────────────────────
  const pollAuth = useCallback(async () => {
    try {
      const status = await zaloApi.getLoginStatus(accountIdRef.current);
      setLoginStatus(status);
      setAuthError(null);
    } catch (e) {
      if (e instanceof ZaloApiError) {
        setAuthError(e.message);
      }
    }
  }, []);

  useEffect(() => {
    pollAuth();
    const id = setInterval(pollAuth, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [pollAuth]);

  // ── Account switching (Phase 2) ──────────────────────────────────────────
  // Khi currentAccountId từ context đổi (user chọn TK khác):
  //   1) Clear state cũ (conversations, messages, openConvId) để UI không
  //      hiển thị data của account cũ trong lúc fetch account mới.
  //   2) Refetch ngay: pollAuth + fetchConversations.
  //   3) SSE reconnect sẽ tự chạy vì EventSource cũ dùng accountId cũ → cần
  //      đóng + mở lại với accountId mới. useEffect SSE có dependency accountId
  //      → sẽ tự teardown/setup.
  const prevAccountIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevAccountIdRef.current === accountId) return;
    prevAccountIdRef.current = accountId;
    // Reset state khi account thật sự đổi (không reset khi mount lần đầu).
    if (prevAccountIdRef.current === null && accountId) {
      // Mount lần đầu → không reset, để hook tự load bình thường.
      return;
    }
    // Reset state
    setConversations([]);
    setMessages([]);
    setOpenConvId(null);
    setLoginStatus(null);
    setAuthError(null);
    setBroadcastCampaignId(null);
    setBroadcastStatus(null);
    // Trigger refetch
    void pollAuth();
  }, [accountId, pollAuth]);

  const fetchConversations = useCallback(async () => {
    setLoadingConvs(true);
    try {
      const res = await zaloApi.getConversations(200, accountIdRef.current);
      const list = res.conversations || [];
      // Bridge có thể trả rows chưa sort → sort lại theo latest_message_at / last_message_ts DESC
      // để thread có tin nhắn GẦN NHẤT luôn lên đầu. Hàm sortConversationsByLatestMessage
      // dùng cùng quy tắc với API Next.js (latest_message_at ưu tiên last_message_ts).
      const sorted = sortConversationsByLatestMessage(list);
      setConversations(sorted);
      // ── LOG: danh sách conversation từ bridge ─────────────────────────────────
      // eslint-disable-next-line no-console
      console.log(
        `[ZALO_FE][FETCH_CONVS] total=${list.length} ` +
        `user=${list.filter((c: ZaloConversation) => c.thread_type === 'user').length} ` +
        `group=${list.filter((c: ZaloConversation) => c.thread_type === 'group').length} ` +
        `first3_ids=[${sorted.slice(0, 3).map((c: ZaloConversation) => `${c.conversation_id}(${c.thread_type})`).join(', ')}]`
      );
      // Đẩy lên Supabase để cache, không gọi refreshConversations để tránh loop.
      void saveConversationsToSupabase(list, accountIdRef.current);
    } catch (e) {
      showToast(
        e instanceof Error ? e.message : "Lỗi tải hội thoại",
        false
      );
    } finally {
      setLoadingConvs(false);
    }
  }, [showToast]);

  // ── Refresh conversations (gọi từ SSE handler + initial load) ───────────
  const refreshConversations = useCallback(async () => {
    try {
      const res = await fetch(`/api/zalo/conversations?account_id=${encodeURIComponent(accountIdRef.current)}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = await res.json();
      const list: ZaloConversation[] = Array.isArray(data?.conversations)
        ? data.conversations
        : [];
      // Supabase SQL ORDER BY last_message_ts DESC, nhưng ta vẫn sort lại
      // client bằng helper chung (ưu tiên latest_message_at) — phòng trường hợp
      // row có latest_message_at mới hơn last_message_ts (vd vừa nhận SSE).
      // Đảm bảo hội thoại có tin nhắn gần nhất LUÔN ở trên đầu.
      setConversations(sortConversationsByLatestMessage(list));
    } catch {
      // ignore
    }
  }, []);

  // Visibility refresh useEffect đặt ngay SAU refreshCurrentThread (line ~570)
  // để tránh TDZ khi reference trong dep array.

  useEffect(() => {
    if (loginStatus?.is_logged_in) {
      // 1) Hiển thị cache từ Supabase ngay lập tức (UX tốt hơn — không flash empty).
      void refreshConversations();
      // 2) Sau đó fetch mới từ Zalo để sync names/avatars, rồi refetch conversations.
      void fetchConversations().then(() => refreshConversations());
    } else {
      setConversations([]);
      setOpenConvId(null);
    }
  }, [loginStatus?.is_logged_in, fetchConversations, refreshConversations]);

  // ── Sync từ Zalo ────────────────────────────────────────────────────────
  const syncConversations = useCallback(async () => {
    setLoadingConvs(true);
    try {
      await zaloApi.syncConversations(accountIdRef.current);
      await fetchConversations();
      showToast("Đồng bộ conversations thành công!", true);
    } catch (e) {
      showToast(
        e instanceof Error ? e.message : "Lỗi đồng bộ Zalo",
        false
      );
    } finally {
      setLoadingConvs(false);
    }
  }, [fetchConversations, showToast]);

  // ── Mở conversation ─────────────────────────────────────────────────────
  // Thiết kế mới: UI CHỈ ĐỌC từ Supabase. SSE là signal để refetch.
  // Khi user click thread → load messages từ Supabase, mark read trên Supabase,
  // refetch conversations để reset unread_count.
  const openConversation = useCallback(async (convId: string) => {
    setOpenConvId(convId);
    setMessages([]);
    const threadId = convId.includes(":") ? convId.split(":").slice(1).join(":") : convId;
    // ── LOG: mở conversation ────────────────────────────────────────────────
    // eslint-disable-next-line no-console
    console.log(`[ZALO_FE][OPEN_CONV] convId=${convId} threadId=${threadId}`);

    // Đảm bảo row conversation tồn tại trong DB ngay khi mở (tránh ID thô hiển thị).
    // Nếu thread chưa có trong state (vd vừa nhận SSE chưa kịp refresh) → vẫn
    // phải có row DB để sidebar hiển thị conversation đúng sau refresh.
    const existing = conversations.find(
      (c) => c.conversation_id === threadId || c.thread_id === threadId
    );
    if (!existing) {
      // QUAN TRỌNG: Thread lạ (chưa có trong state) — KHÔNG được đoán 'user'.
      // Trước đây hardcode 'user' → nếu thực tế là group → row DB bị lưu sai,
      // bridge parseThreadId fallback 'user' → gửi nhầm vào DM.
      //
      // Cách an toàn: query Supabase trước để xem row này đã từng được upsert
      // với thread_type chính xác chưa (SSE listener hoặc lần sync trước).
      // Nếu DB không có → mặc định 'user' NHƯNG nếu là group, SSE sẽ sửa sau
      // (POST upsert vẫn ăn vì conversation_id trùng + ignoreDuplicates=false).
      void ensureConversationInSupabase(
        threadId,
        "user",
        accountIdRef.current,
        `Zalo ${threadId}`,
        {
          ts: Date.now(),
          content: null,
          isSelf: false,
        }
      );
    }

    setLoadingChat(true);
    try {
      // 1) Fetch messages từ Supabase (NO optimistic merge — chỉ setMessages 1 lần duy nhất).
      const res = await fetch(
        `/api/zalo/messages?account_id=${encodeURIComponent(accountIdRef.current)}&thread_id=${encodeURIComponent(threadId)}&limit=200`,
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list: ZaloMessage[] = Array.isArray(data?.messages) ? data.messages : [];
      // Dedupe trước khi setMessages — tránh render duplicate nếu DB có row
      // cũ (từ trước fix) hoặc race giữa bridge persist và FE save.
      setMessages(dedupeMessages(list));

      // 2) Mark read: reset unread_count về 0 trong zalo_conversations_ui.
      await fetch(`/api/zalo/threads/${encodeURIComponent(threadId)}/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: accountIdRef.current }),
        keepalive: true,
      }).catch(() => undefined);

      // 3) Cập nhật local state conversation: reset unread_count về 0.
      setConversations((prev) =>
        prev.map((c) =>
          c.conversation_id === convId ? { ...c, unread_count: 0 } : c
        )
      );

      // 4) Background: gọi Zalo bridge để đánh dấu đã đọc ở server Zalo.
      await zaloApi.markRead(convId, accountIdRef.current).catch(() => undefined);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Lỗi tải tin nhắn";
      showToast(msg, false);
    } finally {
      setLoadingChat(false);
    }
  }, [showToast]);

  // ── Refresh messages cho thread đang mở (gọi từ SSE handler) ───────────
  const refreshCurrentThread = useCallback(async () => {
    const convId = openConvIdRef.current;
    if (!convId) return;
    const threadId = convId.includes(":")
      ? convId.split(":").slice(1).join(":")
      : convId;
    try {
      const res = await fetch(
        `/api/zalo/messages?account_id=${encodeURIComponent(accountIdRef.current)}&thread_id=${encodeURIComponent(threadId)}&limit=200`,
        { cache: "no-store" }
      );
      if (!res.ok) return;
      const data = await res.json();
      const list: ZaloMessage[] = Array.isArray(data?.messages) ? data.messages : [];
      // Replace hoàn toàn state — không merge để tránh nhảy tin.
      // Vẫn dedupe để chống DB có row trùng (vd bridge persist + FE SSE save
      // trước fix đã tạo duplicate rows, vẫn còn trong DB).
      setMessages(dedupeMessages(list));
    } catch {
      // ignore
    }
  }, []);

  // ── Visibility refresh ──────────────────────────────────────────────────
  // Khi tab ẩn → SSE/EventSource bị browser throttle (Chrome giảm xuống ~1Hz,
  // sau 5 phút có thể pause). Bridge vẫn chạy ngầm + INSERT vào Supabase bình
  // thường, nhưng UI không được refetch → khi mở lại tab thấy stale.
  //
  // Fix: mỗi lần tab trở lại visible → refresh conversations + thread đang mở
  // từ Supabase. Data trong Supabase là source of truth, browser lifecycle
  // không ảnh hưởng đến việc lưu trữ.
  //
  // Cũng refresh ngay khi window focus (click tab khác rồi quay lại).
  //
  // Lưu ý: useEffect này đặt SAU refreshCurrentThread để tránh TDZ trong dep
  // array (refreshCurrentThread là const useCallback, JS hoisting chỉ work với
  // function declaration chứ không work với const).
  useEffect(() => {
    if (!loginStatus?.is_logged_in) return;

    const onVisibleOrFocus = () => {
      // Chỉ refresh khi tab thực sự visible hoặc window có focus.
      const isVisible = typeof document === "undefined" ||
        document.visibilityState === "visible";
      const isFocused = typeof document === "undefined" ||
        document.hasFocus();
      if (!isVisible && !isFocused) return;

      // eslint-disable-next-line no-console
      console.log("[ZALO_FE][VISIBLE] tab visible/focused → refetch from Supabase");
      void refreshConversations();
      // Refetch thread đang mở để hiển thị message mới nhận được lúc tab ẩn.
      // refreshCurrentThread đã check openConvIdRef internally.
      void refreshCurrentThread();
    };

    document.addEventListener("visibilitychange", onVisibleOrFocus);
    window.addEventListener("focus", onVisibleOrFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibleOrFocus);
      window.removeEventListener("focus", onVisibleOrFocus);
    };
  }, [loginStatus?.is_logged_in, refreshConversations, refreshCurrentThread]);

  // ── Sync tin nhắn mới (manual trigger từ nút Sync) ──────────────────────
  const syncCurrentChat = useCallback(async () => {
    if (!openConvId) return;
    try {
      // Force reload từ Zalo bridge (đồng bộ server-side), sau đó refresh từ Supabase.
      await zaloApi.syncMessages(openConvId, 50).catch(() => undefined);
      await refreshCurrentThread();
      await refreshConversations();
      showToast("Đã đồng bộ tin nhắn mới!", true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Lỗi đồng bộ tin nhắn";
      showToast(msg, false);
    }
  }, [openConvId, refreshCurrentThread, refreshConversations, showToast]);

  // ── Gửi tin nhắn ────────────────────────────────────────────────────────
  // Sau khi gửi thành công qua Zalo bridge, refetch từ Supabase để có cả
  // tin user vừa gửi (đã được SSE save tự động hoặc chưa).
  const sendCurrentMessage = useCallback(async () => {
    if (!openConvId) return;
    const text = replyText.trim();
    if (!text && pendingFiles.length === 0) return;

    // Resolve thread_type từ conversation state TRƯỚC khi gửi — UI biết chính
    // xác conv đang mở là group/user, gửi kèm để bridge không phải đoán.
    // Trước đây không gửi → bridge cache miss → fallback 'user' → gửi nhầm DM.
    const openConv = conversations.find(
      (c) => c.conversation_id === openConvId || c.thread_id === openConvId
    );
    const sendThreadType: "user" | "group" =
      (openConv?.thread_type as "user" | "group" | undefined) ||
      // Fallback: detect từ convId format (nếu còn dùng prefix)
      (openConvId.startsWith("g:") ? "group" : "user");

    setSending(true);
    try {
      // ── LOG: gửi tin từ frontend ────────────────────────────────────────
      // eslint-disable-next-line no-console
      console.log(
        `[ZALO_FE][SEND] convId=${openConvId} threadId=${openConvId} ` +
        `thread_type=${sendThreadType} text="${text.slice(0, 80)}"`
      );
      if (pendingFiles.length > 0) {
        await zaloApi.sendMedia(openConvId, pendingFiles, text, sendThreadType, accountIdRef.current);
      } else {
        await zaloApi.sendMessage(openConvId, text, sendThreadType, accountIdRef.current);
      }
      setReplyText("");
      setPendingFiles([]);

      // Bridge đã forward SSE → frontend save Supabase.
      // Đợi 300ms cho phép SSE POST hoàn tất, sau đó refetch.
      await new Promise((r) => setTimeout(r, 300));
      await refreshCurrentThread();
      // Optimistic local sort: thread mình vừa nhắn là "có tin gần nhất" → đẩy
      // lên đầu danh sách ngay, không cần đợi round-trip từ DB.
      const nowIso = new Date().toISOString();
      setConversations((prev) =>
        sortConversationsByLatestMessage(
          prev.map((c) =>
            c.conversation_id === openConvId || c.thread_id === openConvId
              ? {
                  ...c,
                  latest_message_at: nowIso,
                  last_message_ts: Date.now(),
                  has_messages: true,
                }
              : c
          )
        )
      );
      // eslint-disable-next-line no-console
      console.log(`[ZALO_FE][SEND_OK] convId=${openConvId}`);
      showToast("Đã gửi!", true);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[ZALO_FE][SEND_ERR] convId=${openConvId}`, e);
      showToast(
        e instanceof Error ? e.message : "Lỗi gửi tin nhắn",
        false
      );
    } finally {
      setSending(false);
    }
  }, [openConvId, replyText, pendingFiles, refreshCurrentThread, showToast]);

  // ── Broadcast ───────────────────────────────────────────────────────────
  const sendBroadcast = useCallback(
    async (messagesOrContent: string | string[], targets: ZaloBroadcastTarget[]) => {
      // Chuẩn hoá input: chấp nhận cả string[] (mới) và string (backward-compat
      // nếu callback cũ truyền 1 content đơn). Loại bỏ message rỗng.
      const messages = (Array.isArray(messagesOrContent)
        ? messagesOrContent
        : [messagesOrContent]
      )
        .map((m) => String(m || "").trim())
        .filter((m) => m.length > 0);

      if (messages.length === 0) {
        showToast("Vui lòng nhập nội dung", false);
        return null;
      }
      if (targets.length === 0) {
        showToast("Vui lòng chọn ít nhất 1 người nhận", false);
        return null;
      }
      setBroadcasting(true);
      try {
        // Gửi kèm `messages` để backend loop qua từng message. Vẫn giữ
        // `content` = message đầu tiên cho backend legacy chỉ đọc content.
        const res = await zaloApi.sendBroadcast({
          messages,
          content: messages[0],
          targets,
        }, accountIdRef.current);
        setBroadcastCampaignId(res.campaign_id);
        setBroadcastStatus(res);
        const totalMessages = res.total_messages ?? messages.length;
        showToast(
          `Đã tạo campaign: ${messages.length} tin × ${res.total_targets} người = ${totalMessages * res.total_targets} lượt gửi`,
          true
        );
        return res;
      } catch (e) {
        showToast(
          e instanceof Error ? e.message : "Lỗi gửi broadcast",
          false
        );
        return null;
      } finally {
        setBroadcasting(false);
      }
    },
    [showToast]
  );

  // ── Polling broadcast status (cập nhật progress liên tục) ─────────────
  // Không chỉ đợi completed/failed — cứ 3s lấy state mới, UI sẽ hiển thị
  // sent/total đang chạy dần.
  useEffect(() => {
    if (!broadcastCampaignId) return;
    const id = setInterval(async () => {
      try {
        const status = await zaloApi.getBroadcastStatus(broadcastCampaignId, accountIdRef.current);
        setBroadcastStatus(status);
        if (status.status === "completed" || status.status === "failed") {
          clearInterval(id);
          showToast(
            `Broadcast ${status.status}: ${status.sent ?? 0}/${status.total ?? 0} thành công`,
            status.status === "completed"
          );
          setBroadcastCampaignId(null);
        }
      } catch {
        // ignore — bridge có thể đang restart, thử lại tick sau.
      }
    }, 3_000);
    return () => clearInterval(id);
  }, [broadcastCampaignId, showToast]);

  // ── Logout ──────────────────────────────────────────────────────────────
  const logout = useCallback(async () => {
    if (!window.confirm("Đăng xuất Zalo? Bạn sẽ cần quét QR lại.")) return;
    try {
      await zaloApi.logout(accountIdRef.current);
      setLoginStatus(null);
      setConversations([]);
      setMessages([]);
      setOpenConvId(null);
      showToast("Đã đăng xuất Zalo", true);
    } catch (e) {
      showToast(
        e instanceof Error ? e.message : "Lỗi đăng xuất",
        false
      );
    }
  }, [showToast]);

  // ── Force reconnect WS (Zalo server thường xuyên đóng WS với code 3000 Overlimit) ──
  const [reconnecting, setReconnecting] = useState(false);
  const reconnectBridge = useCallback(async () => {
    setReconnecting(true);
    try {
      const result = await zaloApi.reconnect(accountIdRef.current);
      if (result?.ok) {
        showToast(
          `Đã reconnect Zalo (${result.before || "?"} → ${result.after || "?"}, WS: ${result.is_ws_connected ? "online" : "offline"})`,
          true
        );
        await pollAuth();
        await fetchConversations();
      } else {
        showToast(result?.error || "Reconnect thất bại", false);
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Lỗi khi reconnect", false);
    } finally {
      setReconnecting(false);
    }
  }, [showToast, pollAuth, fetchConversations]);

  // ── SSE real-time với auto-reconnect ─────────────────────────────────────
  // Tự reopen EventSource khi rớt connection (bridge restart, network blip...).
  // Strategy: retry sau 3s, sau đó 6s, 12s, 24s, max 30s. Reset khi kết nối lại.
  const SSE_RETRY_DELAYS_MS = [3_000, 6_000, 12_000, 24_000, 30_000];
  const [sseState, setSseState] = useState<"connecting" | "open" | "closed" | "reconnecting">("closed");
  const sseRef = useRef<{ source: EventSource | null; close: () => void } | null>(null);

  useEffect(() => {
    if (!loginStatus?.is_logged_in) {
      // Cleanup nếu đang có subscription cũ.
      if (sseRef.current) {
        sseRef.current.close();
        sseRef.current = null;
      }
      setSseState("closed");
      return;
    }

    let cancelled = false;
    let retryAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let currentSource: EventSource | null = null;

    function cleanup() {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (currentSource) {
        currentSource.close();
        currentSource = null;
      }
    }

    function scheduleReconnect() {
      if (cancelled) return;
      const delay =
        SSE_RETRY_DELAYS_MS[Math.min(retryAttempt, SSE_RETRY_DELAYS_MS.length - 1)];
      retryAttempt += 1;
      setSseState("reconnecting");
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    function attach(source: EventSource) {
      source.addEventListener("open", () => {
        if (cancelled) return;
        retryAttempt = 0;
        setSseState("open");
      });
      const dispatch = (type: string, rawData: string | null) => {
        if (cancelled || !rawData) return;
        try {
          const data = rawData ? JSON.parse(rawData) : null;
if (type === "new_message") {
              const target =
                (data && (data.group_id ?? data.threadId ?? data.idTo)) ?? null;
              const targetThread = target ? String(target) : null;

              // ── LOG: SSE nhận message từ backend ──────────────────────────────────
              // eslint-disable-next-line no-console
              console.log(
                `[ZALO_FE][SSE_RECV] type=${type} ` +
                `thread_id=${data?.thread_id} threadId=${data?.threadId} group_id=${data?.group_id} ` +
                `thread_type=${data?.thread_type} ` +
                `sender_id=${data?.sender_id} sender_name=${data?.sender_name} ` +
                `is_self=${data?.is_self} message_id=${data?.message_id ?? data?.id ?? "(none)"} ` +
                `content="${(data?.content || '').slice(0, 60)}"`
              );

              if (targetThread) {
                // 1) Save message vào Supabase qua Next.js route (giữ nguyên row).
                //    POST /api/zalo/messages với insertOnly=true để không overwrite row đã có.
                //
                //    QUAN TRỌNG — chống duplicate messages trên /thong-bao-zalo:
                //      Bridge persist trước với source_message_id = Zalo msgId
                //      (xem supabaseSync.js#persistIncomingMessage). Frontend
                //      CHỈ nên save khi SSE payload có message_id khớp với row
                //      bridge đã upsert — nếu không có message_id → KHÔNG save
                //      (tránh sinh "sse_<ts>_<random>" → row thứ 2 → UI duplicate).
                //
                //    Backward-compat: nếu payload cũ không có message_id mà có
                //    data.id → dùng id. Nếu vẫn không có → bỏ qua save.
                const messageIdFromSse = (() => {
                  const candidates = [
                    data?.message_id,
                    data?.id,
                    data?.msg_id,
                    data?.msgId,
                  ];
                  for (const c of candidates) {
                    if (c == null) continue;
                    const s = String(c).trim();
                    // Bỏ qua các giá trị rõ ràng là fallback random do FE tự sinh
                    if (s.length === 0) continue;
                    if (s.startsWith("sse_") || s.startsWith("local_")) continue;
                    return s;
                  }
                  return null;
                })();

                if (!messageIdFromSse) {
                  // eslint-disable-next-line no-console
                  console.log(
                    `[ZALO_FE][SSE_NO_ID] thread=${targetThread} skipping save (bridge should have already persisted by msgId)`
                  );
                  // Vẫn refetch thread + conversations để UI cập nhật nhưng
                  // KHÔNG tự save → tránh duplicate rows trong DB.
                  const ensureOnlyPromise = ensureConversationInSupabase(
                    targetThread,
                    data?.thread_type === "group" || data?.isGroup ? "group" : "user",
                    accountIdRef.current,
                    data?.sender_name || undefined,
                    {
                      ts: data?.ts ? Number(data.ts) : Date.now(),
                      content: data?.content || null,
                      senderId: data?.sender_id || null,
                      isSelf: !!data?.is_self,
                    }
                  );
                  ensureOnlyPromise.finally(() => {
                    if (
                      targetThread &&
                      openConvIdRef.current &&
                      String(openConvIdRef.current) === targetThread
                    ) {
                      void refreshCurrentThread();
                    }
                    // Optimistic sort local + cập nhật latest_*/ unread_count
                    // ngay khi SSE đến — kể cả nhánh không có message_id (bridge
                    // đã persist). Đảm bảo thread "có tin mới" nhảy lên đầu.
                    const tsFromSse2 = data?.ts ? Number(data.ts) : Date.now();
                    const iso2 =
                      Number.isFinite(tsFromSse2) && tsFromSse2 > 0
                        ? new Date(tsFromSse2).toISOString()
                        : new Date().toISOString();
                    const isOwn2 =
                      data?.is_self === true ||
                      data?.isSelf === true ||
                      data?.is_self === 1;
                    setConversations((prev) =>
                      sortConversationsByLatestMessage(
                        prev.map((c) =>
                          c.conversation_id === targetThread
                            ? {
                                ...c,
                                latest_message_at: iso2,
                                last_message_ts: tsFromSse2,
                                latest_content:
                                  typeof data?.content === "string"
                                    ? data.content
                                    : c.latest_content,
                                latest_sender_name:
                                  data?.sender_name ?? c.latest_sender_name,
                                latest_is_self: isOwn2,
                                unread_count: isOwn2
                                  ? 0
                                  : Math.max(
                                      0,
                                      Number(c.unread_count || 0) +
                                        (openConvIdRef.current === targetThread ? 0 : 1)
                                    ),
                                has_messages: true,
                              }
                            : c
                        )
                      )
                    );
                    void refreshConversations();
                  });
                  return;
                }

                const messageRow = {
                  message_id: messageIdFromSse,
                  thread_id: targetThread,
                  thread_type: data?.thread_type === "group" || data?.isGroup ? "group" : "user",
                  sender_id: data?.sender_id || null,
                  sender_name: data?.sender_name || null,
                  content: data?.content ?? "",
                  ts: data?.ts ? Number(data.ts) : Date.now(),
                  type: data?.type || "webchat",
                  is_self: !!data?.is_self,
                  attachments: data?.attachments ?? null,
                  image_urls: Array.isArray(data?.image_urls) ? data.image_urls : [],
                  reply_to_id: data?.reply_to_id ?? null,
                  time_text: data?.time_text || null,
                };

              // Save qua Next route (không qua frontend logic merge).
              // Truyền threadType từ SSE payload để route biết upsert row vào
              // zalo_conversations_ui với thread_type chính xác.
              const savePromise = saveMessagesToSupabase(
                targetThread,
                [messageRow],
                accountIdRef.current,
                {
                  insertOnly: true,
                  threadType: data?.thread_type === "group" || data?.isGroup ? "group" : "user",
                }
              );

              // Đảm bảo conversation row tồn tại trong zalo_conversations_ui
              // trước khi save message — tránh trường hợp thread mới (group/stranger)
              // chưa được bridge sync → DB chưa có row → UI hiển thị ID thô.
              // Query DB → upsert nếu chưa có.
              const sseThreadType = data?.thread_type === "group" || data?.isGroup ? "group" : "user";
              // eslint-disable-next-line no-console
              console.log(
                `[ZALO_FE][ENSURE_TRY] threadId=${targetThread} type=${sseThreadType}`
              );
              const ensurePromise = ensureConversationInSupabase(
                targetThread,
                sseThreadType,
                accountIdRef.current,
                data?.sender_name || undefined,
                {
                  ts: data?.ts ? Number(data.ts) : Date.now(),
                  content: data?.content || null,
                  senderId: data?.sender_id || null,
                  isSelf: !!data?.is_self,
                }
              );

              // Sau khi save xong (round-trip nhỏ):
              // - Nếu target = thread đang mở → refetch messages state.
              // - CẬP NHẬT LOCAL STATE trước (latest_message_at, latest_content,
              //   unread_count) rồi sort lại để thread "có tin mới" nhảy lên đầu
              //   NGAY LẬP TỨC — không phải đợi DB round-trip mới thấy.
              // - Nếu là group/user MỚI (chưa có trong state) → fetch từ bridge
              //   để lấy conversation_name thật.
              savePromise.finally(() => {
                if (
                  targetThread &&
                  openConvIdRef.current &&
                  // So sánh dựa trên thread_id raw — bỏ mọi logic prefix.
                  String(openConvIdRef.current) === targetThread
                ) {
                  void refreshCurrentThread();
                }
                // 1) Optimistic update cho state local — UI thread list "jump"
                //    lên đầu ngay khi user nhận tin nhắn mới, không phải đợi DB.
                const tsFromSse = data?.ts ? Number(data.ts) : Date.now();
                const isoNow =
                  Number.isFinite(tsFromSse) && tsFromSse > 0
                    ? new Date(tsFromSse).toISOString()
                    : new Date().toISOString();
                const isOwn =
                  data?.is_self === true ||
                  data?.isSelf === true ||
                  data?.is_self === 1;
                const latestContent =
                  typeof data?.content === "string" ? data.content : null;

                setConversations((prev) => {
                  const exists = prev.some(
                    (c) => c.conversation_id === targetThread
                  );
                  let next: ZaloConversation[];
                  if (exists) {
                    next = prev.map((c) => {
                      if (c.conversation_id !== targetThread) return c;
                      // Tin nhắn từ đối phương → tăng unread; tin mình gửi → reset.
                      const unread = isOwn
                        ? 0
                        : Math.max(0, Number(c.unread_count || 0) + (targetThread === openConvIdRef.current ? 0 : 1));
                      return {
                        ...c,
                        latest_message_at: isoNow,
                        last_message_ts: tsFromSse,
                        latest_content: latestContent ?? c.latest_content,
                        latest_sender_name: data?.sender_name ?? c.latest_sender_name,
                        latest_is_self: isOwn,
                        unread_count: unread,
                        has_messages: true,
                      };
                    });
                  } else {
                    // Conversation hoàn toàn mới — chèn row tạm để user thấy ngay.
                    next = [
                      ...prev,
                      (() => {
                        const isGroupConv =
                          data?.thread_type === "group" || data?.isGroup;
                        return {
                          conversation_id: targetThread,
                          thread_id: targetThread,
                          thread_type: isGroupConv ? "group" : "user",
                          // QUAN TRỌNG: KHÔNG dùng sender_name làm tên hiển thị cho
                          // group — sender chỉ là 1 thành viên bất kỳ trong nhóm, không
                          // đại diện cho tên nhóm. Trước đây ưu tiên sender_name bất kể
                          // type → sidebar/chat header hiển thị nhầm "tên người gửi"
                          // thay vì tên nhóm cho tới khi refreshConversations() ở dưới
                          // resolve tên thật (gây hiệu ứng "vài giây sau mới đúng").
                          // Với user (DM) thì sender_name chính là tên đối phương nên
                          // vẫn dùng làm placeholder hợp lý.
                          conversation_name: isGroupConv
                            ? `Group ${targetThread}`
                            : data?.sender_name || `Zalo ${targetThread}`,
                          account_id: accountIdRef.current,
                          latest_message_at: isoNow,
                          last_message_ts: tsFromSse,
                          latest_content: latestContent,
                          latest_sender_name: data?.sender_name ?? null,
                          latest_is_self: isOwn,
                          message_count: 1,
                          has_messages: true,
                          unread_count: isOwn ? 0 : 1,
                          avatar_url: null,
                        } as ZaloConversation;
                      })(),
                    ];
                  }
                  // Sort lại theo latest_message_at DESC để thread "có tin mới"
                  // nhảy lên đầu NGAY — user thấy được mà không cần đợi DB.
                  return sortConversationsByLatestMessage(next);
                });
                // 2) Background refetch để đồng bộ với DB (avatar, name thật, v.v.).
                const exists = conversationsRef.current.some(
                  (c) => c.conversation_id === targetThread
                );
                if (!exists) {
                  // Conversation mới — gọi bridge để lấy tên thật, saveSupabase
                  // rồi refresh. (syncConversations chỉ trigger bridge sync mà
                  // KHÔNG saveSupabase → DB vẫn trống → refetch không thấy.)
                  void fetchConversations().then(() => refreshConversations());
                } else {
                  void refreshConversations();
                }
              });
            } else {
              // Không có target → chỉ refetch conversations
              void refreshConversations();
            }
          } else if (type === "session_expired") {
        showToast("Phiên Zalo đã hết hạn. Vui lòng đăng nhập lại.", false);
        void pollAuth();
          }
        } catch (err) {
          // Bỏ qua payload không hợp lệ, không crash subscription.
          if (typeof window !== "undefined") {
            // eslint-disable-next-line no-console
            console.warn("[zalo-sse] dispatch parse error:", err);
          }
        }
      };
      // Lắng nghe cả 4 loại event mà server có thể phát.
      source.addEventListener("new_message", (e) =>
        dispatch("new_message", (e as MessageEvent).data)
      );
      source.addEventListener("session_expired", (e) =>
        dispatch("session_expired", (e as MessageEvent).data)
      );
      source.addEventListener("auth-status", (e) =>
        dispatch("auth-status", (e as MessageEvent).data)
      );
      // PHASE 4: account_status_changed — bridge thông báo TK nào vừa đổi
      // status. UI sẽ refresh danh sách + cập nhật dot. Nếu là TK hiện tại
      // → cập nhật badge + có thể reset state nếu disconnect.
      source.addEventListener("account_status_changed", (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data);
          if (typeof window !== "undefined") {
            window.dispatchEvent(
              new CustomEvent("zalo-account-status-changed", { detail: data })
            );
          }
        } catch {
          /* ignore */
        }
      });
      source.addEventListener("error", () => {
        // EventSource tự dispatch 'error' khi rớt / server đóng stream. Browser
        // cũng tự đóng readyState — scheduleReconnect sẽ tạo lại source mới.
        if (cancelled) return;
        try { source.close(); } catch (_) { /* noop */ }
        currentSource = null;
        scheduleReconnect();
      });
    }

    function connect() {
      if (cancelled) return;
      setSseState("connecting");
      try {
        const source = zaloApi.openEventSource(accountIdRef.current);
        currentSource = source;
        attach(source);
      } catch {
        scheduleReconnect();
      }
    }

    connect();

    sseRef.current = {
      source: null,
      close: () => {
        cancelled = true;
        cleanup();
        setSseState("closed");
      },
    };

    return () => {
      cancelled = true;
      cleanup();
      setSseState("closed");
    };
    // Cố ý bỏ qua openConvId/fetchConversations/syncCurrentChat... — connect chỉ
    // phụ thuộc vào trạng thái login để tránh reconnect loop khi user mở thread.
    // PHASE 2: depend vào accountId → reconnect khi đổi account
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loginStatus?.is_logged_in, accountId]);

  // ── Import session (gọi từ extension) ──────────────────────────────────
  const importFromExtension = useCallback(async () => {
    type ZaloExtApi = {
      isAvailable: () => boolean;
      ping: () => Promise<{ installed: boolean; version: string }>;
      checkLogin: () => Promise<{
        is_logged_in: boolean;
        cookies_count: number;
        missing: string[];
        keys: string[];
      }>;
      importSession: (opts?: Record<string, unknown>) => Promise<{ success: boolean; data?: unknown; error?: string }>;
    };

    // Bridge content-script publishes the API under window.__zaloExtension.
    // Legacy wrappers dùng window.zaloExtension (page-bridge.js cũ); pick whichever.
    function readExtApi(): ZaloExtApi | null {
      const w = window as unknown as {
        __zaloExtension?: ZaloExtApi;
        zaloExtension?: { importSession: (opts?: unknown) => Promise<{ success: boolean; data?: unknown; error?: string }> };
      };
      if (w.__zaloExtension) return w.__zaloExtension;
      if (w.zaloExtension) {
        return {
          isAvailable: () => true,
          ping: () => Promise.resolve({ installed: true, version: "legacy" }),
          checkLogin: () => Promise.resolve({ is_logged_in: false, cookies_count: 0, missing: [], keys: [] }),
          importSession: w.zaloExtension!.importSession.bind(w.zaloExtension),
        };
      }
      return null;
    }

    // page-bridge-main.js được content script inject bất đồng bộ (script tag
    // load từ chrome-extension://) — thường xong trong vài ms, nhưng nếu user
    // bấm nút ngay khi trang vừa load (hoặc máy chậm), window.__zaloExtension
    // có thể chưa kịp gán. Đợi tối đa 1.5s (giống cơ chế requestExtensionDomSync)
    // thay vì kết luận "chưa cài" ngay ở lần check đầu tiên.
    let ext = readExtApi();
    for (let i = 0; !ext && i < 15; i++) {
      await new Promise((r) => setTimeout(r, 100));
      ext = readExtApi();
    }

    if (!ext) {
      showToast(
        "Chưa cài extension Zalo. Vui lòng cài extension từ thư mục extensions/extension-login-zalo (Chrome → Load unpacked).",
        false
      );
      return;
    }

    setAuthLoading(true);
    try {
      await ext.ping().catch(() => undefined);
      const bridgeUrl = (() => {
        const raw =
          (typeof process !== "undefined" &&
            (process.env.NEXT_PUBLIC_ZALO_BRIDGE_URL ||
              process.env.NEXT_PUBLIC_API_BASE_URL)) ||
          "http://localhost:3001";
        // Defensive: nếu env prod còn trỏ về mabuu.markeeai.com thì rewrite sang timetech.
        if (/(^|\/\/|@)mabuu\.markeeai\.com/i.test(raw)) {
          console.warn(
            "[Zalo] NEXT_PUBLIC_ZALO_BRIDGE_URL trỏ về mabuu — tự động fallback sang timetech"
          );
          return "https://timetech.markeeai.com/zalo-bridge";
        }
        return raw;
      })();

      const accountId =
        (typeof process !== "undefined" &&
          process.env.NEXT_PUBLIC_ZALO_ACCOUNT_ID) ||
        accountIdRef.current;

      // Extension tự mở Zalo tab (nếu cần) → extract cookie → POST về bridge.
      const result = await ext.importSession({
        account_id: accountId,
        owner_id: accountId,
        backend_url: bridgeUrl,
        login_timeout_ms: 90_000,
      });

      if (result.success) {
        showToast("Đăng nhập Zalo thành công! Đang đồng bộ...", true);
        await pollAuth();
      } else {
        showToast(result.error || "Đăng nhập thất bại", false);
      }
    } catch (e) {
      showToast(
        e instanceof Error ? e.message : "Lỗi kết nối extension",
        false
      );
    } finally {
      setAuthLoading(false);
    }
  }, [pollAuth, showToast]);

  return {
    loginStatus,
    authLoading,
    authError,
    isLoggedIn: !!loginStatus?.is_logged_in,
    importFromExtension,
    logout,
    refreshAuth: pollAuth,

    conversations,
    loadingConvs,
    syncConversations,
    refreshConversations: fetchConversations,

    openConvId,
    openConversation,
    messages,
    loadingChat,
    sending,
    replyText,
    setReplyText,
    pendingFiles,
    setPendingFiles,
    sendCurrentMessage,
    syncCurrentChat,

    broadcasting,
    broadcastStatus,
    sendBroadcast,
    sseState,

    reconnecting,
    reconnectBridge,

    toast,
    showToast,
  };
}