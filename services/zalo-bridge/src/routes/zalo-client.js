/**
 * /api routes — endpoints phục vụ cho InvoiceFlow frontend (/thong-bao-zalo).
 *
 * Tất cả endpoints đều default `accountId = "shop-owner"` để khớp với cách
 * InvoiceFlow extension-login-zalo POST lên /api/all-platform/zalo/auth/import-session.
 *
 *   GET    /api/all-platform/zalo/auth/status
 *     → trạng thái login của session `shop-owner`
 *
 *   GET    /api/all-platform/zalo/conversations?limit=200
 *     → liệt kê bạn bè + nhóm (merged) mà zalo account đang tham gia
 *
 *   POST   /api/all-platform/zalo/conversations/sync
 *     → đồng bộ danh sách friends + groups từ Zalo về session cache
 *
 *   GET    /api/all-platform/zalo/conversations/:id/messages?limit=100&offset=0
 *     → lấy lịch sử tin nhắn của 1 thread
 *
 *   POST   /api/all-platform/zalo/conversations/:id/sync-messages?count=50
 *     → refresh tin nhắn mới nhất
 *
 *   POST   /api/all-platform/zalo/conversations/:id/send
 *     body { text: string, mentions?: [{pos, len, uid}] }
 *     → gửi text message. Text chứa "@all" (không phân biệt hoa/thường) khi
 *       gửi vào group sẽ tự tag toàn bộ thành viên nhóm (buildAllMentions).
 *       `mentions` (do FE tính khi user chọn người từ dropdown "@") tag từng
 *       thành viên cụ thể — chỉ có hiệu lực với group (resolveMentions).
 *
 *   POST   /api/all-platform/zalo/conversations/:id/send-media
 *     multipart với files[]
 *     → gửi kèm text/ảnh/file
 *
 *   POST   /api/all-platform/zalo/conversations/:id/read
 *     → mark read
 *
 *   POST   /api/all-platform/zalo/broadcasts/preview
 *     body { content, targets[] }
 *     → trả về preview
 *
 *   POST   /api/all-platform/zalo/broadcasts
 *     body { content, targets[] }
 *     → gửi broadcast tới nhiều thread
 *
 *   GET    /api/all-platform/zalo/broadcasts/:campaignId
 *     → poll trạng thái campaign
 *
 *   GET    /api/all-platform/zalo/events
 *     → SSE: new_message | session_expired | auth-status
 */

import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { ThreadType } from 'zca-js';
import { sessionManager } from '../services/sessionManager.js';
import { resolveGroupInfo, resolveUserInfo } from '../services/threadInfoResolver.js';
import { buildAllMentions } from '../services/mentions.js';
import { logger } from '../utils/logger.js';

const router = Router();

const DEFAULT_ACCOUNT = process.env.ZALO_DEFAULT_ACCOUNT || 'shop-owner';

// Thư mục tạm cho file upload từ /send-media — dùng chung với webhook.js
// (attachment Chatwoot) để nhất quán, dọn dẹp khi bridge start (xem index.js
// "Cleaned up N leftover temporary attachment files").
const UPLOAD_TEMP_DIR = '/app/data/temp_attachments';
try {
  fs.mkdirSync(UPLOAD_TEMP_DIR, { recursive: true });
} catch (_) {
  /* ignore — best effort, upload sẽ tự fail nếu dir không ghi được */
}
const upload = multer({
  dest: UPLOAD_TEMP_DIR,
  limits: { fileSize: 50 * 1024 * 1024, files: 10 },
});

// In-memory cache: thread_id (raw, không prefix) → thread_type ("user" | "group").
// Khi frontend gọi API với conversation_id raw (không prefix), bridge lookup cache
// này để biết dùng ThreadType.Group vs ThreadType.User khi gọi zca-js.
// Cache được populate từ:
//   - GET /conversations sync (nguồn 1/2/3 ở trên)
//   - SSE listener khi nhận message mới (sessionManager push vào globalThis)
//   - Khi broadcast/sendMessage thành công (cập nhật lại để chắc chắn)
// Cache này KHÔNG cần persist — nếu restart bridge thì sync lại là rebuild.
// Dùng globalThis để share giữa routes (zalo-client.js) và sessionManager
// mà không cần import (tránh circular import).
function getGlobalCache() {
  if (!globalThis.__zaloThreadTypeCache) globalThis.__zaloThreadTypeCache = new Map();
  return globalThis.__zaloThreadTypeCache;
}

export function cacheThreadType(accountId, threadId, threadType) {
  if (!threadId || !accountId) return;
  const t = threadType === 'group' || threadType === 2 || threadType === ThreadType?.Group ? 'group' : 'user';
  getGlobalCache().set(`${accountId}:${threadId}`, t);
}

function lookupThreadType(accountId, threadId) {
  if (!threadId) return null;
  return getGlobalCache().get(`${accountId}:${threadId}`) || null;
}

function getAccountId(req) {
  return String(
    req.query.account_id ||
      req.query.accountId ||
      req.body?.account_id ||
      req.body?.accountId ||
      req.headers['x-user-id'] ||
      DEFAULT_ACCOUNT
  ).trim() || DEFAULT_ACCOUNT;
}

function requireLoggedIn(req, res) {
  const accountId = getAccountId(req);
  const status = sessionManager.getStatus(accountId);
  if (!status || status.status !== 'logged_in') {
    res.status(401).json({ error: 'Not logged in', accountId });
    return null;
  }
  const api = sessionManager.getApi(accountId);
  if (!api) {
    res.status(500).json({ error: 'API instance missing', accountId });
    return null;
  }
  return { accountId, api, status };
}

// ── Auth status ───────────────────────────────────────────────────────────────
router.get('/all-platform/zalo/auth/status', (req, res) => {
  const accountId = getAccountId(req);
  const s = sessionManager.getStatus(accountId);
  if (!s) {
    return res.json({
      user_id: accountId,
      session_id: null,
      status: 'not_logged_in',
      is_logged_in: false,
      session_expired: false,
      qr_base64: null,
    });
  }
  const isLogged = s.status === 'logged_in';
  res.json({
    user_id: accountId,
    session_id: accountId,
    status: isLogged ? 'confirmed' : (s.status || 'not_logged_in'),
    is_logged_in: isLogged,
    session_expired: !isLogged && s.status === 'session_expired',
    qr_base64: null,
    zalo_id: s.zaloId,
    display_name: s.displayName || '',
    inbox_id: s.inboxId,
  });
});

// ── Auth: force reconnect ──────────────────────────────────────────────────────
//
// Khi Zalo đóng WS (Overlimit connection 3000 / duplicate), session vẫn còn
// nhưng WS lìa. Endpoint này stop listener cũ + restore lại bằng cookie từ disk.
// Cũng đặt cooldown ngắn để tránh reconnect loop.
let _lastForceReconnectAt = 0;
router.post('/all-platform/zalo/auth/reconnect', async (req, res) => {
  const now = Date.now();
  if (now - _lastForceReconnectAt < 5000) {
    return res.status(429).json({ ok: false, error: 'cooldown', retry_after_ms: 5000 - (now - _lastForceReconnectAt) });
  }
  _lastForceReconnectAt = now;

  const accountId = getAccountId(req);
  try {
    // Lấy session state trước
    const before = sessionManager.getStatus(accountId);
    // Stop listener cũ + restore lại (KHÔNG xóa credentials)
    await sessionManager.restartListener(accountId);
    const after = sessionManager.getStatus(accountId);
    logger.info(`[${accountId}] Force reconnect: ${before?.status || 'unknown'} -> ${after?.status || 'unknown'}`);
    res.json({
      ok: true,
      account_id: accountId,
      before: before?.status || null,
      after: after?.status || null,
      is_logged_in: after?.status === 'logged_in',
      is_ws_connected: !!after?.isWsConnected,
    });
  } catch (err) {
    logger.error(`Force reconnect error for ${accountId}`, { err: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Conversations: list ────────────────────────────────────────────────────────
//
// Zalo JS (zca-js) cung cấp:
//   getAllFriends(): [{userId, displayName, avatar, ...}]
//   getAllGroups():   [{groupId, name, ...}]
//
// Mình trộn cả 2 thành 1 danh sách duy nhất để UI chỉ cần 1 list.
router.get('/all-platform/zalo/conversations', async (req, res) => {
  try {
    const ctx = requireLoggedIn(req, res);
    if (!ctx) return;

    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const conversations = [];
    const seen = new Set();

    // ── Nguồn 1: getCMRecent — conversation list THẬT của Zalo (kể cả stranger)
    // Đây là API cùng nguồn với Web Zalo dùng để show "gần đây".
    try {
      const recent = await ctx.api.getCMRecent(Math.min(limit * 2, 500), 0);
      const items = recent?.conversations || recent || [];
      let count = 0;
      for (const c of items) {
        if (count >= limit) break;
        const threadId = c.threadId || c.id;
        if (!threadId) continue;
        const key = String(threadId);
        if (seen.has(key)) continue;
        seen.add(key);
        const isGroup = c.type === 2 || c.threadType === 2 || c.type === 'group';
        // KHÔNG dùng prefix g:/u: nữa — conversation_id = thread_id raw
        // để frontend không cần phân biệt user/group.
        conversations.push({
          conversation_id: key,
          thread_id: key,
          thread_type: isGroup ? 'group' : 'user',
          conversation_name: c.name || c.displayName || (isGroup ? `Group ${threadId}` : `Zalo ${threadId}`),
          account_id: ctx.accountId,
          message_count: 0,
          has_messages: false,
          unread_count: typeof c.unreadCount === 'number' ? c.unreadCount : 0,
          avatar_url: c.avatar || null,
          last_message_ts: c.lastMsgTime || c.updateTime || c.lastMessageTime || null,
        });
        cacheThreadType(ctx.accountId, key, isGroup ? 'group' : 'user');
        count++;
      }
      logger.info(`[${ctx.accountId}] conversations: getCMRecent returned ${count} items`);
    } catch (e) {
      logger.warn(`[${ctx.accountId}] conversations: getCMRecent failed`, { err: e.message, code: e?.code });
    }

    // ── Nguồn 2: Bổ sung friends — user đã kết bạn nhưng chưa có convo gần đây
    try {
      const friends = await ctx.api.getAllFriends();
      for (const f of (friends || [])) {
        const userId = f.userId || f.id;
        if (!userId) continue;
        const key = String(userId);
        if (seen.has(key)) continue;
        seen.add(key);
        conversations.push({
          conversation_id: key,
          thread_id: key,
          thread_type: 'user',
          conversation_name: f.displayName || f.zaloName || f.name || key,
          account_id: ctx.accountId,
          message_count: 0,
          has_messages: false,
          unread_count: 0,
          avatar_url: f.avatar || null,
          last_message_ts: null,
        });
        cacheThreadType(ctx.accountId, key, 'user');
      }
    } catch (e) {
      logger.warn(`[${ctx.accountId}] getAllFriends failed`, { err: e.message });
    }

    // ── Nguồn 3: Bổ sung groups — dùng getGroupInfo cho từng thread trong
    // cache (nếu cache ghi nhận là group). KHÔNG dùng getAllGroups() vì zca-js
    // version hiện tại trả về `{version, gridVerMap}` (object) chứ không phải
    // array → catch block chạy, group không bao giờ vào cache, dẫn đến bug
    // "nhắn vào nhóm bị gửi thành DM" (parseThreadId fallback 'user').
    //
    // Thay vào đó: quét tất cả key trong `__zaloThreadTypeCache` đã đánh dấu
    // 'group' (được populate từ SSE listener và getGroupInfo on-the-fly), gọi
    // getGroupInfo cho mỗi group chưa có name trong response.
    try {
      const cache = getGlobalCache();
      const groupIds = [];
      for (const [key, type] of cache.entries()) {
        if (type !== 'group') continue;
        const [acc, tid] = key.split(':');
        if (acc !== ctx.accountId) continue;
        if (seen.has(tid)) continue;
        groupIds.push(tid);
      }
      // Concurrent với limit 5 để tránh rate-limit ZCA.
      const limit = 5;
      for (let i = 0; i < groupIds.length; i += limit) {
        const batch = groupIds.slice(i, i + limit);
        const results = await Promise.allSettled(batch.map(gid =>
          ctx.api.getGroupInfo(gid).then(r => ({ gid, info: r?.gridInfoMap?.[gid] || null }))
        ));
        for (const r of results) {
          if (r.status !== 'fulfilled') continue;
          const { gid, info } = r.value;
          if (!info) continue;
          if (seen.has(gid)) continue;
          seen.add(gid);
          conversations.push({
            conversation_id: gid,
            thread_id: gid,
            thread_type: 'group',
            conversation_name: info.name || `Group ${gid}`,
            account_id: ctx.accountId,
            message_count: 0,
            has_messages: false,
            unread_count: 0,
            avatar_url: info.fullAvt || info.avt || null,
            last_message_ts: null,
          });
        }
      }
    } catch (e) {
      logger.warn(`[${ctx.accountId}] getGroupInfo-batch failed`, { err: e.message });
    }

    // Sắp xếp theo last_message_ts desc (cuộc trò chuyện mới nhất lên đầu)
    conversations.sort((a, b) => {
      const ta = Number(a.last_message_ts) || 0;
      const tb = Number(b.last_message_ts) || 0;
      return tb - ta;
    });

    res.json({
      account_id: ctx.accountId,
      conversations,
      total: conversations.length,
      // Trả về format raw thread_id cho UI đọc thẳng (không prefix g:/u:).
      // Frontend dùng list này để hiển thị sidebar + dùng conversation_id = thread_id
      // cho mọi API call → hoàn toàn không phân biệt user/group.
    });
    // ── LOG: trả kết quả sync về cho frontend ──────────────────────────────
    const sample = conversations.slice(0, 5).map(c => `${c.thread_id}(${c.thread_type})`).join(', ');
    logger.info(
      `[${ctx.accountId}] [SYNC_DONE] total=${conversations.length} ` +
      `user=${conversations.filter(c => c.thread_type === 'user').length} ` +
      `group=${conversations.filter(c => c.thread_type === 'group').length} ` +
      `sample=[${sample}]`
    );
  } catch (err) {
    logger.error('GET conversations error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Group info: lấy thông tin 1 group cụ thể (tên, avatar) ───────────────────
//
// Dùng để frontend upsert row vào zalo_conversations_ui với tên group THẬT
// khi nhận SSE mà thread chưa có trong DB (vd nhắn vào group mới hoặc bridge
// session vừa reconnect).
//
// QUAN TRỌNG: KHÔNG dùng `getAllGroups()` — nó liệt kê TẤT CẢ group qua
// ZCA endpoint, thường fail với code:604 / trả object {version, gridVerMap}
// khi session lỗi hoặc user có nhiều group. Thay vào đó dùng
// `getGroupInfo(groupId)` — gọi thẳng API endpoint của ZCA
// `/api/group/getmg-v2` để lấy metadata CHỈ 1 group. Endpoint này dùng
// `zpwServiceMap.group[0]` (đã load thành công qua WS handshake) — đáng
// tin cậy hơn nhiều so với `getAllGroups`.
//
// Cache 60s per groupId — ZCA rate-limit khá nghiêm với endpoint này.
// Cache dùng chung module threadInfoResolver.js với supabaseSync.js (bridge
// tự resolve tên group ngay khi persist message, không cần FE gọi route này).
router.get('/all-platform/zalo/group-info', async (req, res) => {
  try {
    const ctx = requireLoggedIn(req, res);
    if (!ctx) return;
    const groupId = String(req.query.group_id || "").trim();
    if (!groupId) {
      return res.status(400).json({ error: 'missing group_id' });
    }

    const payload = await resolveGroupInfo(ctx.api, ctx.accountId, groupId);
    const status = payload.ok ? 200 : payload.error === 'group not found or empty name' ? 404 : 502;
    return res.status(status).json(payload);
  } catch (err) {
    logger.error('GET group-info error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── User info (DM) ──────────────────────────────────────────────────────────
//
// Tương đương /group-info nhưng cho thread `user` (DM 1-1) — dùng khi thread
// mới xuất hiện mà tin nhắn SSE/catch-up không kèm sender_name hợp lệ (vd
// người lạ nhắn tin chờ, hoặc dName chưa kịp populate). Trước đây các thread
// này bị kẹt vĩnh viễn ở tên fallback "Zalo <id>" vì chỉ group mới có endpoint
// resolve tên thật — DM không có gì tương ứng.
//
// `getUserInfo(userId)` gọi ZCA `/api/social/friend/getprofiles/v2`, trả về
// `{ changed_profiles: Record<key, User> }` — key có suffix "_0" nên lấy giá
// trị đầu tiên thay vì tra theo userId thô.
//
// Cache 60s (thành công) / 10 phút (thất bại) — dùng chung module
// threadInfoResolver.js với supabaseSync.js. Negative cache dài hơn hẳn vì
// `getUserInfo` gọi endpoint `/api/social/friend/getprofiles/v2` — endpoint
// này chỉ trả hồ sơ cho user đã là BẠN BÈ trên Zalo. Với người lạ nhắn tin
// (chưa kết bạn), ZCA trả lỗi code:112 ("Lỗi không xác định") — lỗi này
// KHÔNG transient, sẽ fail y hệt mỗi lần gọi cho tới khi 2 bên kết bạn.
router.get('/all-platform/zalo/user-info', async (req, res) => {
  try {
    const ctx = requireLoggedIn(req, res);
    if (!ctx) return;
    const userId = String(req.query.user_id || "").trim();
    if (!userId) {
      return res.status(400).json({ error: 'missing user_id' });
    }

    const payload = await resolveUserInfo(ctx.api, ctx.accountId, userId);
    const status = payload.ok ? 200 : payload.error === 'user not found or empty name' ? 404 : 502;
    return res.status(status).json(payload);
  } catch (err) {
    logger.error('GET user-info error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Conversations: sync (force refresh) ────────────────────────────────────────
//
// Đơn giản là gọi lại /conversations rồi trả summary. Đếm số bạn + nhóm.
router.post('/all-platform/zalo/conversations/sync', async (req, res) => {
  try {
    const ctx = requireLoggedIn(req, res);
    if (!ctx) return;

    let friendsCount = 0;
    let groupsCount = 0;
    try {
      const friends = await ctx.api.getAllFriends();
      friendsCount = (friends || []).length;
    } catch (e) {
      logger.warn(`[${ctx.accountId}] sync friends failed`, { err: e.message });
    }
    // Đếm groups từ cache (vì getAllGroups() không reliable — xem comment ở
    // GET /conversations Nguồn 3). Chỉ đếm những group đã có trong cache
    // threadType (được populate từ SSE listener hoặc getGroupInfo on-the-fly).
    try {
      const cache = getGlobalCache();
      const set = new Set();
      for (const [key, type] of cache.entries()) {
        if (type !== 'group') continue;
        const [acc] = key.split(':');
        if (acc === ctx.accountId) set.add(key.split(':').slice(1).join(':'));
      }
      groupsCount = set.size;
    } catch (e) {
      logger.warn(`[${ctx.accountId}] sync groups count failed`, { err: e.message });
    }

    res.json({
      account_id: ctx.accountId,
      groups_count: groupsCount,
      friends_count: friendsCount,
      total: friendsCount + groupsCount,
    });
  } catch (err) {
    logger.error('POST conversations/sync error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Helper: chuyển "u:123" / "g:456" thành { threadId, threadType }
// - "u:<id>" | "g:<id>" → resolve thẳng (legacy format)
// - raw "<id>" → lookup cache. Nếu cache miss, gọi getGroupInfo(id) để xác định
//   on-the-fly (cheap vì có cache 60s ở /group-info). Nếu groupInfo resolve được
//   thì mark cache = 'group'; ngược lại fallback 'user'.
//   Trả về threadType = 'unknown' nếu cả 2 đều fail → caller sẽ trả 400 thay vì
//   âm thầm gửi sai thread (trước đây fallback 'user' → gửi nhầm vào DM).
function parseThreadId(convId, accountId) {
  if (typeof convId !== 'string') return null;
  const m = convId.match(/^([ug]):(.+)$/);
  if (m) return { threadId: m[2], threadType: m[1] === 'g' ? 'group' : 'user' };
  if (convId.length === 0) return null;
  const cached = lookupThreadType(accountId || DEFAULT_ACCOUNT, convId);
  if (cached) return { threadId: convId, threadType: cached };
  return { threadId: convId, threadType: 'unknown' };
}

// Resolve threadType bằng cách gọi getGroupInfo (endpoint ZCA /api/group/getmg-v2).
// Trả về 'group' nếu group tồn tại, 'user' nếu chắc chắn là user, null nếu
// không xác định được (để caller throw 400).
async function resolveThreadTypeAsync(accountId, api, threadId) {
  if (!threadId) return null;
  const cached = lookupThreadType(accountId, threadId);
  if (cached) return cached;
  try {
    const r = await api.getGroupInfo(threadId);
    const grid = r?.gridInfoMap?.[threadId];
    if (grid && grid.name) {
      cacheThreadType(accountId, threadId, 'group');
      return 'group';
    }
  } catch (_) {
    // 404 / 502 / etc → không phải group (có thể là user hoặc không xác định).
  }
  return 'user';
}

// Resolve thread_type cuối cùng dùng chung cho /send và /send-media — ưu
// tiên client gửi lên (UI biết chính xác nhất), rồi cache, rồi resolve on-the-fly.
// Trả về { finalType } hoặc { error } (object lỗi để route trả res trực tiếp).
async function resolveFinalType(req, ctx, parsed) {
  const clientType = req.body?.thread_type;
  if (clientType === 'group' || clientType === 'user') {
    return { finalType: clientType };
  }
  if (parsed.threadType === 'group' || parsed.threadType === 'user') {
    return { finalType: parsed.threadType };
  }
  const resolved = await resolveThreadTypeAsync(ctx.accountId, ctx.api, parsed.threadId);
  if (!resolved) {
    return {
      error: {
        error: 'thread_type_unknown',
        message: 'Không xác định được thread là group hay user. Hãy truyền thread_type trong body.',
        threadId: parsed.threadId,
      },
    };
  }
  return { finalType: resolved };
}

// ── Tag người cụ thể: mentions do FE tự tính (ZaloChatPanel dropdown "@") ───
// FE tính sẵn {pos, len, uid} theo UTF-16 code unit index (JS string index —
// khớp 100% với `msg.length` mà zca-js dùng để validate, xem
// zca-js/apis/sendMessage.js#handleMentions, kể cả khi text có dấu tiếng
// Việt vì cả browser lẫn Node đều dùng UTF-16 cho String). Chỉ tin tưởng 1
// phần: validate lại bounds + ký tự tại `pos` phải là "@" để chặn trường hợp
// FE tính lệch offset (vd race giữa chọn tag và gõ thêm chữ).
function sanitizeProvidedMentions(text, mentions) {
  if (!Array.isArray(mentions)) return undefined;
  const len = (text || '').length;
  const cleaned = mentions
    .filter((m) => m && typeof m.pos === 'number' && typeof m.len === 'number' && m.uid)
    .map((m) => ({ pos: Math.trunc(m.pos), len: Math.trunc(m.len), uid: String(m.uid) }))
    .filter((m) => m.pos >= 0 && m.len > 0 && m.pos + m.len <= len && text[m.pos] === '@');
  return cleaned.length > 0 ? cleaned : undefined;
}

// "@all" (auto-detect trong text) luôn ưu tiên hơn mentions FE gửi lên — tag
// toàn bộ nhóm thì tag từng người cụ thể không còn ý nghĩa.
function resolveMentions(text, providedMentions) {
  return buildAllMentions(text) || sanitizeProvidedMentions(text, providedMentions);
}

// ── Messages: list ─────────────────────────────────────────────────────────────
router.get('/all-platform/zalo/conversations/:id/messages', async (req, res) => {
  try {
    const ctx = requireLoggedIn(req, res);
    if (!ctx) return;

    const parsed = parseThreadId(req.params.id, ctx.accountId);
    if (!parsed) return res.status(400).json({ error: 'Invalid conversation id' });

    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    // ── LOG: request list messages ─────────────────────────────────────
    logger.info(
      `[${ctx.accountId}] [LIST_MSGS] convId_in_url=${req.params.id} ` +
      `parsed.threadId=${parsed.threadId} parsed.threadType=${parsed.threadType} limit=${limit}`
    );

    let rawMsgs = [];
    try {
      if (parsed.threadType === 'group') {
        const r = await ctx.api.getGroupChatHistory(parsed.threadId, limit);
        rawMsgs = r?.groupMsgs || [];
      } else {
        const r = await ctx.api.getUserChatHistory(parsed.threadId, limit);
        rawMsgs = r?.msgs || [];
      }
    } catch (e) {
      const msg = e?.message || String(e);
      logger.error(`[${ctx.accountId}] getChatHistory(${parsed.threadType}/${parsed.threadId}) failed`, { err: msg });
      // Phân biệt thread không tồn tại (404 / not found) với Zalo backend down.
      // zca-js ném "Request failed with status code 404" khi threadId đã bị unfriend
      // hoặc chưa bao giờ thuộc về account — trả 404 để client biết đây là cache cũ.
      const isNotFound = /404|not\s*found|invalid\s*(user|thread)|unfriend/i.test(msg);
      if (isNotFound) {
        return res.status(404).json({
          error: 'thread_not_found',
          message: 'Thread không tồn tại hoặc đã bị unfriend. Vui lòng đồng bộ lại danh sách.',
          threadId: parsed.threadId,
          threadType: parsed.threadType,
        });
      }
      return res.status(502).json({ error: 'zalo_backend_error', message: msg });
    }

    let ownId = '';
    try { ownId = await ctx.api.getOwnId?.() ?? ''; } catch {}

    // Chuẩn hoá: zca-js trả về cấu trúc khác nhau tuỳ phiên bản — bám theo data field.
    const messages = rawMsgs.map((m) => {
      const data = m?.data || m;
      const senderId = String(data?.uidFrom || data?.senderId || data?.fromId || '');
      const isSent = ownId && senderId === String(ownId);
      return {
        message_id: String(data?.msgId || data?.cliMsgId || data?.globalMsgId || `${data?.ts || Date.now()}-${Math.random()}`),
        sender_id: senderId || null,
        sender_name: data?.dName || data?.displayName || null,
        timestamp: data?.ts ? new Date(Number(data.ts)).toISOString() : null,
        time_text: data?.ts ? new Date(Number(data.ts)).toLocaleString('vi-VN') : null,
        type: data?.msgType || data?.type || 'text',
        content: data?.content || data?.message || null,
        image_urls: Array.isArray(data?.attachments) ? data.attachments.filter(a => a?.type === 'image').map(a => a.href || a.url).filter(Boolean) : [],
        is_sent: isSent,
        is_deleted: Boolean(data?.isDeleted),
        group_id: parsed.threadType === 'group' ? parsed.threadId : null,
      };
    });

    const total = messages.length;
    const sliced = offset > 0 ? messages.slice(-(limit + offset)).slice(0, limit) : messages.slice(-limit);
    res.json({
      messages: sliced,
      total,
      limit,
      offset,
      has_more: rawMsgs.length >= limit,
    });
  } catch (err) {
    logger.error('GET messages error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Messages: sync (alias of list, không có cache local để invalidate) ───────
router.post('/all-platform/zalo/conversations/:id/sync-messages', async (req, res) => {
  try {
    const ctx = requireLoggedIn(req, res);
    if (!ctx) return;

    const parsed = parseThreadId(req.params.id, ctx.accountId);
    if (!parsed) return res.status(400).json({ error: 'Invalid conversation id' });
    const count = Math.min(Number(req.query.count) || 50, 200);

    let total = 0;
    try {
      if (parsed.threadType === 'group') {
        const r = await ctx.api.getGroupChatHistory(parsed.threadId, count);
        total = (r?.groupMsgs || []).length;
      } else {
        const r = await ctx.api.getUserChatHistory(parsed.threadId, count);
        total = (r?.msgs || []).length;
      }
    } catch (e) {
      const msg = e?.message || String(e);
      logger.error(`[${ctx.accountId}] sync-messages failed`, { err: msg });
      const isNotFound = /404|not\s*found|invalid\s*(user|thread)|unfriend/i.test(msg);
      if (isNotFound) {
        return res.status(404).json({
          error: 'thread_not_found',
          message: 'Thread không tồn tại hoặc đã bị unfriend.',
          threadId: parsed.threadId,
        });
      }
      return res.status(502).json({ error: 'zalo_backend_error', message: msg });
    }

    res.json({ conversation_id: req.params.id, synced: total, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Send text ─────────────────────────────────────────────────────────────────
router.post('/all-platform/zalo/conversations/:id/send', async (req, res) => {
  try {
    const ctx = requireLoggedIn(req, res);
    if (!ctx) return;

    const parsed = parseThreadId(req.params.id, ctx.accountId);
    if (!parsed) return res.status(400).json({ error: 'Invalid conversation id' });

    const { finalType, error: typeError } = await resolveFinalType(req, ctx, parsed);
    if (typeError) return res.status(400).json(typeError);

    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text is required' });
    const mentions = resolveMentions(text, req.body?.mentions);

    // ── LOG: REST send được gọi từ frontend ─────────────────────────────────
    logger.info(
      `[${ctx.accountId}] [SEND_API] convId_in_url=${req.params.id} ` +
      `parsed.threadId=${parsed.threadId} clientType=${req.body?.thread_type || 'none'} ` +
      `finalType=${finalType} text="${text.slice(0, 80)}"${mentions ? ` [mentions=${mentions.length}]` : ''}`
    );

    try {
      await sessionManager.sendMessage(ctx.accountId, parsed.threadId, finalType, {
        msg: text,
        ...(mentions ? { mentions } : {}),
      });
    } catch (e) {
      logger.error(`[${ctx.accountId}] sendMessage failed`, { err: e.message });
      return res.status(502).json({ error: e.message });
    }

    res.json({ ok: true, conversation_id: req.params.id, message: 'Sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Send media ────────────────────────────────────────────────────────────────
// multipart field name phải là "files" (khớp lib/zalo-api.ts sendMedia() —
// fd.append("files", f, f.name)). multer lưu tạm vào UPLOAD_TEMP_DIR (dest
// mode) → path không có extension, phải rename thêm ext gốc thì zca-js mới
// detect đúng loại file (getFileExtension/getFileName dựa vào path.extname —
// xem zca-js/dist/apis/uploadAttachment.js).
router.post('/all-platform/zalo/conversations/:id/send-media', (req, res, next) => {
  // Gọi multer thủ công (thay vì đặt trực tiếp làm middleware) để bắt lỗi
  // (file quá lớn, quá số lượng...) và trả JSON gọn thay vì rơi vào Express
  // default error handler (trả HTML, frontend hiển thị rác trong toast lỗi).
  upload.array('files', 10)(req, res, (err) => {
    if (err) {
      logger.warn(`[send-media] multer error: ${err.message}`);
      return res.status(400).json({ error: `upload_failed: ${err.message}` });
    }
    next();
  });
}, async (req, res) => {
  const renamedPaths = [];
  try {
    const ctx = requireLoggedIn(req, res);
    if (!ctx) return;

    const parsed = parseThreadId(req.params.id, ctx.accountId);
    if (!parsed) return res.status(400).json({ error: 'Invalid conversation id' });

    const { finalType, error: typeError } = await resolveFinalType(req, ctx, parsed);
    if (typeError) return res.status(400).json(typeError);

    const files = Array.isArray(req.files) ? req.files : [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'files is required (multipart field "files")' });
    }

    for (const f of files) {
      const ext = path.extname(f.originalname || '') || '';
      const finalPath = ext ? `${f.path}${ext}` : f.path;
      if (finalPath !== f.path) fs.renameSync(f.path, finalPath);
      renamedPaths.push(finalPath);
    }

    const text = String(req.body?.text || '').trim();
    // multipart form field → luôn là string JSON (khác /send dùng JSON body thẳng).
    let providedMentions;
    try {
      providedMentions = req.body?.mentions ? JSON.parse(req.body.mentions) : undefined;
    } catch {
      providedMentions = undefined;
    }
    const mentions = resolveMentions(text, providedMentions);

    // ── LOG: REST send-media được gọi từ frontend ───────────────────────────
    logger.info(
      `[${ctx.accountId}] [SEND_MEDIA_API] convId_in_url=${req.params.id} ` +
      `parsed.threadId=${parsed.threadId} finalType=${finalType} ` +
      `files=${renamedPaths.length} text="${text.slice(0, 80)}"${mentions ? ` [mentions=${mentions.length}]` : ''}`
    );

    try {
      await sessionManager.sendMessage(ctx.accountId, parsed.threadId, finalType, {
        msg: text,
        attachments: renamedPaths.length === 1 ? renamedPaths[0] : renamedPaths,
        ...(mentions ? { mentions } : {}),
      });
    } catch (e) {
      logger.error(`[${ctx.accountId}] sendMessage (media) failed`, { err: e.message });
      return res.status(502).json({ error: e.message });
    }

    res.json({
      ok: true,
      conversation_id: req.params.id,
      files_sent: renamedPaths.length,
      message: 'Sent',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    // Dọn file tạm bất kể thành công/thất bại — không để rác trong UPLOAD_TEMP_DIR.
    // Check existsSync trước vì file có thể đã bị rename (path gốc không còn)
    // hoặc lỗi xảy ra trước khi rename xong (path gốc vẫn còn, chưa vào renamedPaths).
    const candidates = [...renamedPaths, ...(Array.isArray(req.files) ? req.files.map((f) => f.path) : [])];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch (_) {
        /* ignore cleanup error */
      }
    }
  }
});

// ── Mark read ────────────────────────────────────────────────────────────────
router.post('/all-platform/zalo/conversations/:id/read', async (req, res) => {
  // zca-js không expose explicit mark-read; trả OK để UI không lỗi.
  res.json({ ok: true, conversation_id: req.params.id });
});

// ── Broadcast: preview ───────────────────────────────────────────────────────
router.post('/all-platform/zalo/broadcasts/preview', (req, res) => {
  const targets = Array.isArray(req.body?.targets) ? req.body.targets : [];
  res.json({
    ok: true,
    preview: { target_count: targets.length },
  });
});

// ── Broadcast: send ──────────────────────────────────────────────────────────
//
// Hỗ trợ 2 dạng payload (backward-compatible):
//   • Cũ: { content: "tin nhắn duy nhất", targets: [...] }
//   • Mới: { messages: ["msg 1", "msg 2", ...], targets: [...] }
//
// Hành vi: với MỖI message, gửi tuần tự tới TẤT CẢ targets, delay 5s giữa
// mỗi nhóm/target (kể cả khi chuyển sang message tiếp theo) để tránh bị
// Zalo rate-limit khi gửi liên tục nhiều round. Message chứa "@all" (không
// phân biệt hoa/thường) sẽ tự động tag toàn bộ thành viên nhóm đích
// (buildAllMentions — chỉ có hiệu lực với target là group).
//
// Status trả về có thêm `current_message` (0-indexed) và `total_messages`
// để UI hiển thị progress theo từng tin nhắn.
router.post('/all-platform/zalo/broadcasts', async (req, res) => {
  try {
    const ctx = requireLoggedIn(req, res);
    if (!ctx) return;

    const targets = Array.isArray(req.body?.targets) ? req.body.targets : [];

    // Chuẩn hoá danh sách messages. Ưu tiên `messages[]`, fallback `content`.
    let messages = [];
    if (Array.isArray(req.body?.messages)) {
      messages = req.body.messages
        .map((m) => String(m || '').trim())
        .filter((m) => m.length > 0);
    } else if (typeof req.body?.content === 'string') {
      const c = req.body.content.trim();
      if (c) messages = [c];
    }

    if (messages.length === 0) {
      return res.status(400).json({ error: 'messages (or content) is required' });
    }
    if (targets.length === 0) {
      return res.status(400).json({ error: 'targets is required' });
    }

    const campaignId = `bc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Khởi tạo campaign trước để frontend poll thấy ngay (status=pending).
    // `current_message`/`total_messages` giúp UI biết đang ở message thứ mấy.
    const campaign = {
      campaign_id: campaignId,
      status: 'pending',
      total: targets.length * messages.length,
      sent: 0,
      failed: 0,
      errors: [],
      current_message: 0,
      total_messages: messages.length,
      // Per-message progress để UI có thể show "đang gửi message 2/5".
      per_message: messages.map((_, idx) => ({
        index: idx,
        preview: messages[idx].slice(0, 60),
        sent: 0,
        failed: 0,
      })),
    };
    campaigns.set(campaignId, campaign);

    // Chạy async, frontend poll status.
    setImmediate(async () => {
      let totalSent = 0;
      let totalFailed = 0;
      const errors = [];
      campaign.status = 'running';

      for (let mIdx = 0; mIdx < messages.length; mIdx++) {
        const msg = messages[mIdx];
        const mentions = buildAllMentions(msg);
        campaign.current_message = mIdx;

        for (let i = 0; i < targets.length; i++) {
          const t = targets[i];
          const parsed = parseThreadId(t.id || t.thread_id || t.conversation_id, ctx.accountId);
          if (!parsed) {
            totalFailed++;
            campaign.failed = totalFailed;
            campaign.per_message[mIdx].failed++;
            errors.push(`[msg ${mIdx + 1}] ${t.id}: invalid id`);
            campaign.errors = errors;
            continue;
          }
          // Ưu tiên thread_type client gửi lên (UI biết chính xác đâu là group/user).
          // Sau đó đến parsed.threadType (parse từ prefix hoặc lookup cache).
          // Fallback cuối: lookup cache threadTypeMap.
          // Nếu vẫn 'unknown' → resolve on-the-fly bằng getGroupInfo (async).
          let finalType =
            t.thread_type === 'group' || t.threadType === 'group' || parsed.threadType === 'group'
              ? 'group'
              : null;
          if (!finalType) {
            const cached = lookupThreadType(ctx.accountId, parsed.threadId);
            if (cached === 'group') finalType = 'group';
          }
          if (!finalType) {
            finalType = await resolveThreadTypeAsync(ctx.accountId, ctx.api, parsed.threadId);
          }
          if (!finalType) {
            totalFailed++;
            campaign.failed = totalFailed;
            campaign.per_message[mIdx].failed++;
            errors.push(`[msg ${mIdx + 1}] ${t.id || t.thread_id}: thread_type_unknown`);
            campaign.errors = errors;
            continue;
          }
          try {
            await sessionManager.sendMessage(ctx.accountId, parsed.threadId, finalType, {
              msg,
              ...(mentions ? { mentions } : {}),
            });
            totalSent++;
            campaign.sent = totalSent;
            campaign.per_message[mIdx].sent++;
          } catch (e) {
            totalFailed++;
            campaign.failed = totalFailed;
            campaign.per_message[mIdx].failed++;
            errors.push(`[msg ${mIdx + 1}] ${t.id}: ${e.message}`);
            campaign.errors = errors;
          }
          // Delay 5s giữa mỗi nhóm/target kế tiếp (cũng dùng luôn cho lượt
          // chuyển sang message tiếp theo, không cộng dồn thêm delay riêng).
          if (i < targets.length - 1 || mIdx < messages.length - 1) {
            await new Promise(r => setTimeout(r, 5000));
          }
        }
      }
      campaign.status = totalFailed === 0 ? 'completed' : 'completed';
      campaign.current_message = messages.length;
    });

    res.json({
      campaign_id: campaignId,
      status: 'pending',
      total_targets: targets.length,
      total_messages: messages.length,
      total_jobs: targets.length * messages.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Broadcast status ─────────────────────────────────────────────────────────
const campaigns = new Map();
router.get('/all-platform/zalo/broadcasts/:campaignId', (req, res) => {
  const c = campaigns.get(req.params.campaignId);
  if (!c) return res.status(404).json({ error: 'campaign not found' });
  res.json(c);
});

// ── SSE events ───────────────────────────────────────────────────────────────
// Minimal in-process pub/sub. Frontend subscribe để biết khi có message mới.
const sseClients = new Set();
function broadcastEvent(type, data) {
  if (sseClients.size === 0) {
    // Không có client nào subscribe — bỏ qua, nhưng log debug
    logger.debug?.(`SSE broadcast ${type} skipped (0 clients)`);
    return;
  }
  // Filter theo accountId để multi-account không cross-tin (vd account A không
  // thấy tin của account B). Nếu payload không có accountId, broadcast cho tất cả
  // → tương thích với code cũ.
  const targetAccountId = data?.account_id ?? null;
  let delivered = 0;
  for (const res of sseClients) {
    try {
      if (targetAccountId && res.__zaloSseAccountId && res.__zaloSseAccountId !== targetAccountId) {
        continue;
      }
      res.write(`event: ${type}\n`);
      // Inject accountId lại để FE confirm đúng filter.
      const payload = { ...data };
      if (targetAccountId && !payload.account_id) payload.account_id = targetAccountId;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      delivered++;
    } catch (_) {
      sseClients.delete(res);
    }
  }
  if (targetAccountId) {
    logger.info(`SSE broadcast ${type} → ${delivered} clients (account=${targetAccountId})`);
  } else {
    logger.info(`SSE broadcast ${type} → ${delivered} clients (broadcast all)`);
  }
}

router.get('/all-platform/zalo/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  // Hỗ trợ ?account_id=<id> để FE nói rõ đang xem account nào. Nếu thiếu
  // → treat là global (backward compat) nhưng sẽ bị filter-out bởi accounts
  // khác đang chỉ định rõ account_id.
  const queryAccountId =
    req.query.account_id ||
    (typeof req.headers['x-user-id'] === 'string' ? req.headers['x-user-id'] : null);
  if (queryAccountId) {
    res.__zaloSseAccountId = String(queryAccountId);
  }
  sseClients.add(res);
  logger.info(
    `SSE client connected (total=${sseClients.size}) ip=${req.ip} account=${res.__zaloSseAccountId || 'all'}`
  );

  // Initial ping để client confirm connected
  res.write(`event: ping\ndata: {"ok":true,"account_id":"${res.__zaloSseAccountId || ''}"}\n\n`);

  const heartbeat = setInterval(() => {
    try { res.write(`:heartbeat\n\n`); } catch (_) { /* noop */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    logger.info(`SSE client disconnected (total=${sseClients.size})`);
  });
});

// Export broadcaster cho phần khác hook vào (ví dụ listener mới khi nhận message).
export const zaloEventBus = { broadcast: broadcastEvent };

export default router;