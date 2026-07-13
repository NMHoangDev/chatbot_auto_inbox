/**
 * supabaseSync.js
 *
 * Persist Zalo messages + conversations từ bridge vào Supabase.
 * Chạy song song với Chatwoot sync, đảm bảo DB luôn có data bất kể
 * frontend có đang mở hay không (bạn đi vắng / đổi tab / refresh / mất SSE).
 *
 * Bảng được dùng (xem supabase/migrations/2026-07-03_zalo_schema_normalize.sql):
 *   - zalo_messages:        unique (user_id, source_message_id) — idempotent
 *   - zalo_conversations_ui: unique (account_id, conversation_id) — 'u:<id>' | 'g:<id>'
 *
 * Idempotency: cả 2 bảng đều dùng upsert với ignoreDuplicates → khi FE SSE
 * handler (useZalo.ts) cũng save thì chỉ 1 row, không bị duplicate.
 */

import { createClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger.js';
import { ThreadType } from 'zca-js';
import { resolveGroupInfo, resolveUserInfo } from './threadInfoResolver.js';

// Nhận diện tên thread fallback ("Group <id>" / "Zalo <id>") — PHẢI khớp
// FALLBACK_NAME_RE ở useZalo.ts (frontend đọc/so tên theo đúng format này để
// biết khi nào cần tự resolve lại). Dùng ở đây để bridge tự phát hiện conversation
// đang bị kẹt tên tạm và tự gọi ZCA resolve — không cần đợi FE mở tab.
const FALLBACK_NAME_RE = /^(Group|Zalo)\s+\d+$/;

let _client = null;
let _warnedMissing = false;

export function getClient() {
  if (_client) return _client;
  // Ưu tiên SUPABASE_URL (server-side full access). Nếu không có (vd FE-only
  // env), fallback NEXT_PUBLIC_SUPABASE_URL — vẫn truy cập được nhờ RLS policy
  // "using (true)" mà migration đã set.
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    if (!_warnedMissing) {
      logger.warn(
        '[supabase-sync] SUPABASE_URL hoặc key chưa set → skip persist (cần thêm vào .env của bridge)'
      );
      _warnedMissing = true;
    }
    return null;
  }
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

/**
 * Build conversation_id theo format CŨ (đã lỗi thời, không dùng nữa).
 *   - user  → 'u:<threadId>'
 *   - group → 'g:<threadId>'
 *
 * @deprecated Format này đã được thay bằng raw thread_id (2026-07-04). Lý do:
 *   - Frontend saveConversationsToSupabase lưu raw thread_id (xem useZalo.ts).
 *   - GET /conversations ở zalo-client.js trả raw thread_id.
 *   - Next route /api/zalo/conversations (toRow) strip prefix → cũng raw.
 *   - Dùng prefix ở đây → onConflict khác cặp với row frontend → duplicate.
 *
 * Giữ function để backfill/cleanup scripts có thể dùng detect row cũ, nhưng
 * KHÔNG gọi từ persistIncomingMessage.
 */
function buildConversationId(threadId, threadType) {
  const prefix = threadType === 'group' ? 'g' : 'u';
  return `${prefix}:${threadId}`;
}

/**
 * Tính thread_type chuẩn từ zca-js msg object.
 *   - msg.type === ThreadType.Group (1) hoặc 2 (legacy) hoặc 'group' → 'group'
 *   - ngược lại → 'user'
 */
export function resolveThreadType(msg) {
  const t = msg?.type;
  if (t === ThreadType.Group || t === 2 || t === 'group') return 'group';
  return 'user';
}

/**
 * Trích message_id ổn định từ zca-js msg object. ZCA trả nhiều trường id
 * khác nhau tuỳ version → ưu tiên msgId (number) trước, fallback các field khác.
 */
function resolveMessageId(msg) {
  const d = msg?.data || {};
  return (
    d.msgId != null
      ? String(d.msgId)
      : d.cliMsgId != null
        ? String(d.cliMsgId)
        : d.globalMsgId != null
          ? String(d.globalMsgId)
          : d.id != null
            ? String(d.id)
            : null
  );
}

/**
 * Trích image_urls từ 1 object content ảnh của zca-js. Message ảnh (chat.photo)
 * trả `data.content` là OBJECT (không phải string) với field tên khác nhau tuỳ
 * chất lượng — ưu tiên chất lượng cao nhất, chỉ lấy 1 URL/ảnh (không lấy cả
 * hdUrl+normalUrl+href vì đều là CÙNG 1 ảnh, lấy hết sẽ bị trùng ảnh khi hiển
 * thị/forward). Field names theo đúng những gì zca-js dùng khi UPLOAD ảnh
 * (xem zca-js/dist/apis/sendMessage.js, uploadAttachment.js) — Zalo protocol
 * dùng chung field name cho cả gửi/nhận.
 */
function extractOneImageUrl(contentObj) {
  if (!contentObj || typeof contentObj !== 'object') return null;
  // Self-echo của tin gửi từ chính bridge (SEND_MEDIA_API / forwardMedia) đôi
  // khi bọc field ảnh trong `params` thay vì để phẳng ở top-level — xem shape
  // gửi đi ở zca-js/dist/apis/sendMessage.js handleAttachment() (data.params.*).
  const p = contentObj.params && typeof contentObj.params === 'object' ? contentObj.params : null;
  const url =
    contentObj.hdUrl ||
    contentObj.oriUrl ||
    contentObj.normalUrl ||
    contentObj.rawUrl ||
    contentObj.href ||
    contentObj.thumbUrl ||
    contentObj.thumb ||
    p?.hdUrl ||
    p?.oriUrl ||
    p?.normalUrl ||
    p?.rawUrl ||
    p?.thumbUrl ||
    null;
  return typeof url === 'string' && url.length > 0 ? url : null;
}

/**
 * Trích image_urls từ các field khả dĩ của ZCA payload.
 * ZCA có thể trả ở các field khác nhau tuỳ version: imageUrls (array),
 * thumb (string url), attachments, v.v. → gom về 1 mảng string[].
 */
export function resolveImageUrls(msg) {
  const d = msg?.data || {};
  const c = d.content;

  // Nhiều ảnh trong 1 tin: content là array các object ảnh.
  if (Array.isArray(c) && c.length > 0 && typeof c[0] === 'object') {
    const urls = c.map(extractOneImageUrl).filter((u) => u);
    if (urls.length > 0) return urls;
    // Array nhưng không phần tử nào khớp field ảnh đã biết — log lại raw shape
    // (trước đây âm thầm rơi qua fallback vì nhánh dưới chỉ chạy khi !Array).
    logger.warn(
      `[resolveImageUrls] content array không khớp field ảnh đã biết: ${JSON.stringify(c).slice(0, 300)}`
    );
  }
  // 1 ảnh: content là 1 object.
  if (c && typeof c === 'object' && !Array.isArray(c)) {
    const one = extractOneImageUrl(c);
    if (one) return [one];
    // Bỏ qua sticker ({id, cateId, ...}) — đã có nhánh xử lý riêng ở
    // forwardEngine.js, không phải "ảnh không nhận diện được".
    const isStickerShape =
      Number.isFinite(Number(c.id)) && Number.isFinite(Number(c.cateId));
    if (!isStickerShape) {
      // Content là object nhưng không khớp field ảnh nào đã biết — có thể là
      // format mới/khác (video, file, share link...). Log lại raw shape (cắt
      // ngắn) để lần sau bổ sung field đúng, thay vì âm thầm coi là "unsupported".
      logger.warn(
        `[resolveImageUrls] content object không khớp field ảnh đã biết: ${JSON.stringify(c).slice(0, 300)}`
      );
    }
  }

  // Fallback — field top-level cũ, giữ lại phòng trường hợp payload khác (vd CMRecent).
  if (Array.isArray(d.imageUrls)) {
    return d.imageUrls.filter((u) => typeof u === 'string' && u.length > 0);
  }
  if (typeof d.thumb === 'string' && d.thumb.length > 0) return [d.thumb];
  if (Array.isArray(d.attachments)) {
    return d.attachments
      .map((a) => (typeof a === 'string' ? a : a?.url || a?.href))
      .filter((u) => typeof u === 'string' && u.length > 0);
  }
  return [];
}

/**
 * Persist 1 message vào zalo_messages + upsert zalo_conversations_ui.
 * Idempotent — gọi nhiều lần với cùng message vẫn OK.
 *
 * Được gọi từ 2 nơi:
 *   1. Realtime: sessionManager on('message') → bridge emit SSE → persist ngay.
 *   2. Catch-up: getCMRecent() ở sessionManager start → bù tin lỡ.
 *
 * @param {object} args
 * @param {string} args.accountId     — 'shop-owner'
 * @param {string} args.threadId      — Zalo thread id (raw)
 * @param {string} args.threadType    — 'user' | 'group'
 * @param {object} args.msg           — raw zca-js message object (hoặc CMRecent
 *                                      message đã wrap thành cùng shape)
 * @param {boolean} args.isSelf       — true nếu do chính mình gửi
 * @returns {Promise<{ok: boolean, messageId?: string, reason?: string}>}
 */
// ── Name resolution ──────────────────────────────────────────────────────
// Tên conversation: chỉ fill khi row INSERT mới (chưa có tên) HOẶC khi
// đang nhận tin từ người khác (incoming → senderName = người gửi thật).
// Trước đây upsert LUÔN ghi đè conversation_name bằng senderName, kể cả
// khi mình gửi → tên conv bị đổi thành tên mình ("Nguyễn Minh Hoàng").
//
// QUAN TRỌNG — bug đã fix (2026-07-09): senderName là tên NGƯỜI GỬI 1 tin
// nhắn cụ thể. Với GROUP, người gửi chỉ là 1 thành viên bất kỳ trong nhóm —
// KHÔNG BAO GIỜ được dùng làm tên nhóm (khác USER/DM, nơi senderName của đối
// phương CHÍNH LÀ tên hội thoại hợp lệ). Bug cũ dùng chung logic senderName
// cho cả group/user → mỗi khi có người khác nhắn vào group, tên nhóm bị ghi
// đè thành tên người đó (vd "Ngọc Thảo", "Gia Sư Yến"...) ngay trong DB, xảy
// ra ở TẦNG BRIDGE trên MỌI tin nhắn — nặng hơn nhiều so với bug hiển thị tạm
// thời ở frontend (useZalo.ts) đã fix trước đó, vì nó ghi đè liên tục, không
// tự sửa được dù frontend có logic resolve lại tên thật.
//
// Quy tắc:
//   - GROUP: KHÔNG bao giờ set tên từ senderName (senderName chỉ là 1 thành
//     viên bất kỳ, không phải tên nhóm). Nếu row chưa có HOẶC tên hiện tại
//     vẫn là fallback `Group <id>` → bridge tự gọi ZCA getGroupInfo() ngay
//     (qua threadInfoResolver, có cache) để lấy tên thật — KHÔNG còn phụ
//     thuộc FE mở tab mới resolve được (xem lịch sử bug 2026-07-13: nhiều
//     nhóm kẹt vĩnh viễn ở "Group <id>" vì chỉ FE mới gọi /group-info, và
//     chỉ khi có tab đang mở + SSE sống đúng lúc tin nhắn đến).
//   - USER (DM): senderName của đối phương là tên hợp lệ, dùng ngay không
//     cần gọi API. Nếu senderName rỗng (hiếm, catch-up cũ) và tên hiện tại
//     vẫn là fallback → thử getUserInfo() qua threadInfoResolver — CHỈ
//     thành công nếu 2 bên đã là bạn bè trên Zalo (giới hạn của ZCA), người
//     lạ nhắn tin vẫn phải chờ FE fallback DOM-scrape (chỉ trình duyệt làm
//     được, bridge không có DOM).
//   - Tin mình gửi (isSelf=true) vào row đã có → không đụng tên, giữ nguyên.
async function resolveConversationName(accountId, conversationId, threadId, threadType, senderName, isSelf, api) {
  try {
    const sb = getClient();
    if (!sb) return null;
    const { data, error } = await sb
      .from('zalo_conversations_ui')
      .select('conversation_name')
      .eq('account_id', accountId)
      .eq('conversation_id', conversationId)
      .maybeSingle();
    if (error) return null;

    const currentName = data?.conversation_name?.trim() || null;
    const needsResolve = !data || (currentName && FALLBACK_NAME_RE.test(currentName));

    if (threadType === 'group') {
      if (!needsResolve) return null; // đã có tên thật — giữ nguyên
      const info = await resolveGroupInfo(api, accountId, threadId);
      if (info?.ok && info.group_name) return info.group_name;
      // Resolve thất bại (session chưa sẵn/rate-limit/lỗi ZCA) — vẫn phải trả
      // 1 giá trị cho row MỚI (không thể để conversation_name null lúc insert),
      // row ĐÃ CÓ thì giữ nguyên tên tạm cũ, tránh ghi liên tục cùng 1 fallback.
      if (!data) return `Group ${threadId}`;
      return null;
    }

    // USER (DM)
    if (!isSelf && senderName && senderName.trim().length > 0) {
      // senderName hợp lệ — dùng ngay, không cần gọi API (rẻ + luôn đúng cho DM).
      if (data && currentName === senderName.trim()) return null; // không đổi gì, khỏi ghi
      return senderName;
    }
    if (!needsResolve) return null; // tên hiện tại đã thật (không phải fallback) — giữ nguyên
    if (!isSelf) {
      const info = await resolveUserInfo(api, accountId, threadId);
      if (info?.ok && info.user_name) return info.user_name;
    }
    if (!data) return `Zalo ${threadId}`;
    return null;
  } catch {
    return null;
  }
}

export async function persistIncomingMessage({
  accountId,
  threadId,
  threadType,
  msg,
  isSelf,
  isCatchUp = false,
  api = null,
}) {
  const sb = getClient();
  if (!sb) return { ok: false, reason: 'no-supabase-client' };
  if (!threadId) return { ok: false, reason: 'no-thread-id' };
  if (!msg) return { ok: false, reason: 'no-msg' };

  const messageId = resolveMessageId(msg);
  if (!messageId) {
    // Không có id → không insert được (sẽ vi phạm unique constraint / không dedupe được).
    logger.debug(
      `[supabase-sync] [${accountId}] skip message without id thread=${threadId}`
    );
    return { ok: false, reason: 'no-message-id' };
  }

  const d = msg.data || {};
  const ts = d.ts ? Number(d.ts) : Date.now();
  const content =
    typeof d.content === 'string' ? d.content.slice(0, 4000) : '';
  const senderId = d.uidFrom || null;
  const senderName = d.dName || null;
  const type = msg.type === ThreadType.Group ? 'group' : (msg.type || 'webchat');
  const imageUrls = resolveImageUrls(msg);

  try {
    // 1) Upsert message — unique (user_id, source_message_id) trong DB.
    const { error: msgErr } = await sb.from('zalo_messages').upsert(
      {
        user_id: accountId,
        group_id: threadId,            // backward-compatible với code cũ
        thread_id: threadId,           // cột mới
        source_message_id: messageId,
        sender_id: senderId,
        sender_name: senderName,
        content,
        ts,
        timestamp: new Date(ts).toISOString(),
        type,
        is_sent: !!isSelf,
        thread_type: threadType,
        account_id: accountId,
        image_urls: imageUrls,
      },
      {
        onConflict: 'user_id,source_message_id',
        // Catch-up (getCMRecent) không bao giờ có image_urls đầy đủ (xem
        // catchUpRecentMessages) → ignoreDuplicates=true để không đè mất dữ
        // liệu tốt hơn đã có từ listener live. Ngược lại, listener live PHẢI
        // được phép ghi đè — Zalo đôi khi bắn 2 event cho cùng 1 ảnh (event
        // đầu href rỗng lúc ảnh còn xử lý, event sau mới có URL thật); nếu
        // luôn ignoreDuplicates=true thì tuỳ thứ tự đến, ảnh có thể bị kẹt ở
        // bản ghi rỗng vĩnh viễn dù event đầy đủ đến ngay sau đó (bug quan sát
        // được 2026-07-11: ảnh gửi vào nhóm chính không hiện dù forward vẫn ổn).
        ignoreDuplicates: isCatchUp,
      }
    );

    if (msgErr) {
      logger.warn(
        `[supabase-sync] [${accountId}] insert message err: ${msgErr.message}`,
        {
          code: msgErr.code,
          hint: msgErr.hint,
          details: msgErr.details,
          // Khi status=401 mà msg rỗng → thường là service role key sai/hết hạn.
          // Lần đầu phát hiện, log thêm key head để debug mà không lộ secret.
          ...(msgErr.message === '' || msgErr.code === 'PGRST301' || /invalid api key/i.test(msgErr.message)
            ? {
                diagnostic: 'service_role_key_likely_invalid_or_rotated',
                url_host: (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/^https?:\/\//, '').split('/')[0],
                key_head: (process.env.SUPABASE_SERVICE_ROLE_KEY || '').slice(0, 30) + '...',
              }
            : {}),
        }
      );
      return { ok: false, reason: `insert: ${msgErr.message}` };
    }

    // 2) Upsert conversation row.
//    conversation_id dùng raw thread_id (không prefix) để khớp với:
//      - GET /conversations ở zalo-client.js (raw thread_id)
//      - saveConversationsToSupabase ở useZalo.ts (raw thread_id)
//      - toRow() ở Next route /api/zalo/conversations (strip prefix nếu có)
//    Trước đây dùng buildConversationId() thêm prefix 'u:' / 'g:' → trùng với
//    row đã lưu từ frontend → onConflict khác cặp → duplicate rows. UI hiển
//    thị 2 conversation cho cùng 1 thread, 1 cái tên đúng, 1 cái "[Nhóm] Zalo
//    Nhóm <id>".
const conversationId = threadId;
    const resolvedName = await resolveConversationName(
      accountId,
      conversationId,
      threadId,
      threadType,
      senderName,
      isSelf,
      api
    );

    const { error: convErr } = await sb
      .from('zalo_conversations_ui')
      .upsert(
        {
          account_id: accountId,
          conversation_id: conversationId,
          thread_id: threadId,
          thread_type: threadType,
          // CHỈ set conversation_name khi resolve trả về giá trị. null =
          // giữ nguyên giá trị cũ trong DB (tin mình gửi, hoặc incoming
          // nhưng không có senderName).
          ...(resolvedName != null ? { conversation_name: resolvedName } : {}),
          latest_message_at: new Date(ts).toISOString(),
          latest_content: content.slice(0, 200),
          latest_sender_id: senderId,
          latest_is_self: !!isSelf,
          last_message_ts: ts,
          has_messages: true,
          updated_at: new Date(ts).toISOString(),
        },
        { onConflict: 'account_id,conversation_id' }
      );

    if (convErr) {
      logger.warn(
        `[supabase-sync] [${accountId}] upsert conv err: ${convErr.message}`
      );
      return { ok: true, messageId, reason: `conv: ${convErr.message}` };
    }

    logger.info(
      `[supabase-sync] [${accountId}] persisted msg=${messageId} ` +
        `thread=${threadId} type=${threadType} self=${!!isSelf}`
    );
    return { ok: true, messageId };
  } catch (e) {
    logger.error(
      `[supabase-sync] [${accountId}] persist failed thread=${threadId}`,
      { err: e instanceof Error ? e.message : String(e) }
    );
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Quét toàn bộ zalo_conversations_ui của 1 account, tìm các row đang kẹt tên
 * fallback (`Group <id>` / `Zalo <id>`) và tự resolve tên thật qua ZCA ngay
 * tại bridge — bù cho các row bị tạo TRƯỚC KHI có fix tự-resolve trong
 * persistIncomingMessage (hoặc row mà lần resolve tại thời điểm nhận tin đã
 * fail do rate-limit/session chưa sẵn sàng). Gọi 1 lần mỗi khi bridge
 * login/reconnect (xem sessionManager.js, cạnh catchUpRecentMessages) —
 * không cần frontend mở tab.
 *
 * @param {object} args
 * @param {string} args.accountId
 * @param {object} args.api — zca-js API instance
 * @returns {Promise<{ok: boolean, scanned: number, fixed: number}>}
 */
export async function reconcileFallbackConversationNames({ accountId, api }) {
  const sb = getClient();
  if (!sb || !api) return { ok: false, scanned: 0, fixed: 0 };

  try {
    const { data, error } = await sb
      .from('zalo_conversations_ui')
      .select('conversation_id, thread_id, thread_type, conversation_name')
      .eq('account_id', accountId);
    if (error) {
      logger.warn(`[supabase-sync] [${accountId}] reconcile: query failed`, { err: error.message });
      return { ok: false, scanned: 0, fixed: 0 };
    }

    const stuck = (data || []).filter(
      (row) => row.conversation_name && FALLBACK_NAME_RE.test(row.conversation_name.trim())
    );
    let fixed = 0;
    for (const row of stuck) {
      const threadId = row.thread_id || row.conversation_id;
      const info =
        row.thread_type === 'group'
          ? await resolveGroupInfo(api, accountId, threadId)
          : await resolveUserInfo(api, accountId, threadId);
      const realName = info?.ok ? info.group_name || info.user_name : null;
      if (!realName) continue;
      const { error: updErr } = await sb
        .from('zalo_conversations_ui')
        .update({ conversation_name: realName })
        .eq('account_id', accountId)
        .eq('conversation_id', row.conversation_id);
      if (!updErr) fixed++;
    }
    logger.info(
      `[supabase-sync] [${accountId}] reconcile fallback names: scanned=${data?.length || 0} stuck=${stuck.length} fixed=${fixed}`
    );
    return { ok: true, scanned: data?.length || 0, fixed };
  } catch (e) {
    logger.warn(`[supabase-sync] [${accountId}] reconcile failed`, {
      err: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, scanned: 0, fixed: 0 };
  }
}

/**
 * Catch-up: fetch N conversation gần nhất từ Zalo (kèm lastMsgs của mỗi
 * conversation) và persist từng message vào Supabase. Bù các tin lỡ trong lúc
 * bridge restart, WS reconnect, hoặc account vừa login.
 *
 * Lưu ý: zca-js không có method "get all messages from all threads". API gần
 * nhất là `getCMRecent(count, lastTime)` trả về `conversations[]` với mỗi
 * conversation chứa `lastMsgs[]` (5-10 tin mới nhất của thread đó).
 *
 * Idempotent → chạy nhiều lần vẫn OK, tin đã có sẽ bị skip bởi unique constraint.
 *
 * @param {object} args
 * @param {string} args.accountId
 * @param {object} args.api       — zca-js API instance
 * @param {number} [args.count=50] — số conversation muốn lấy
 * @returns {Promise<{ok: boolean, convs: number, persisted: number, skipped: number}>}
 */
export async function catchUpRecentMessages({ accountId, api, count = 50 }) {
  const sb = getClient();
  if (!sb) return { ok: false, convs: 0, persisted: 0, skipped: 0 };
  if (!api) return { ok: false, convs: 0, persisted: 0, skipped: 0 };

  let convs = 0;
  let persisted = 0;
  let skipped = 0;

  try {
    const resp = await api.getCMRecent(count);
    const list = Array.isArray(resp?.conversations) ? resp.conversations : [];
    convs = list.length;
    logger.info(
      `[supabase-sync] [${accountId}] catch-up start: ${convs} recent conversations`
    );

    for (const conv of list) {
      const threadType = resolveThreadType(conv);
      const threadId = conv.threadId || null;
      if (!threadId) {
        skipped += Array.isArray(conv.lastMsgs) ? conv.lastMsgs.length : 0;
        continue;
      }
      const msgs = Array.isArray(conv.lastMsgs) ? conv.lastMsgs : [];
      for (const m of msgs) {
        // zca-js CMRecent message: isSelf nằm ở msgType '5' (incoming) hoặc '6' (outgoing)
        // Hoặc dựa vào uidFrom so với ctx.userId. Đơn giản nhất: dùng rule sau.
        // Nếu không chắc, mặc định false (incoming). Tốt hơn → so với userInfo, nhưng
        // phương án này chỉ là catch-up, sai self/incoming không ảnh hưởng nhiều.
        const isSelf = m.msgType === '6' || m.fromD === m.userId;
        const result = await persistIncomingMessage({
          accountId,
          threadId,
          threadType,
          msg: {
            type: threadType === 'group' ? ThreadType.Group : ThreadType.User,
            threadId,
            isSelf,
            data: {
              msgId: m.msgId,
              cliMsgId: m.cliMsgId,
              globalMsgId: m.globalMsgId,
              id: m.globalMsgId,
              uidFrom: m.uidFrom,
              dName: m.dName,
              content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''),
              ts: m.ts,
              // CMRecent không trả imageUrls — bỏ qua ở catch-up.
            },
          },
          isSelf,
          isCatchUp: true,
          api,
        });
        if (result.ok) persisted++;
        else skipped++;
      }
    }

    logger.info(
      `[supabase-sync] [${accountId}] catch-up done: convs=${convs} ` +
        `persisted=${persisted} skipped=${skipped}`
    );
    return { ok: true, convs, persisted, skipped };
  } catch (e) {
    logger.warn(
      `[supabase-sync] [${accountId}] catch-up failed: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
    return { ok: false, convs, persisted, skipped };
  }
}
