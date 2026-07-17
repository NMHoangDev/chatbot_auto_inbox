/**
 * threadInfoResolver.js
 *
 * Resolve tên thật của 1 group/user Zalo qua ZCA API, dùng CHUNG cho:
 *   - route /api/all-platform/zalo/group-info + /user-info (gọi từ FE)
 *   - supabaseSync.js persistIncomingMessage (gọi từ bridge, không cần FE mở tab)
 *
 * Cache module-level (không phải per-request/per-ctx) để 2 nơi gọi cùng
 * group/user trong cùng TTL không tốn thêm request ZCA thật.
 */

import { logger } from '../utils/logger.js';

const GROUP_SUCCESS_TTL_MS = 60_000;
const GROUP_FAILURE_TTL_MS = 60_000;
// USER: negative cache TTL dài hơn hẳn — getUserInfo (ZCA
// /api/social/friend/getprofiles/v2) chỉ trả hồ sơ cho người ĐÃ LÀ BẠN BÈ.
// Người lạ nhắn tin sẽ fail y hệt mỗi lần gọi (ZCA code:112, không transient)
// cho tới khi 2 bên kết bạn → cache lỗi lâu để tránh dồn dập gọi ZCA thật.
const USER_SUCCESS_TTL_MS = 60_000;
const USER_FAILURE_TTL_MS = 10 * 60_000;

const groupCache = new Map(); // key `${accountId}:${groupId}` -> { ts, payload, failed }
const userCache = new Map(); // key `${accountId}:${userId}` -> { ts, payload, failed }

// ── Fallback: getCMRecent() snapshot ────────────────────────────────────────
// getGroupInfo()/getUserInfo() có giới hạn riêng (rate-limit, hoặc — với
// getUserInfo — CHỈ trả hồ sơ cho người đã là bạn bè). getCMRecent() (danh
// sách hội thoại gần đây, cùng nguồn dữ liệu route GET /conversations dùng
// để hiển thị tên) không có giới hạn "phải là bạn bè" — đây là API mà Zalo
// Web dùng để hiện tên thật cho CẢ tin nhắn làm quen (message request) từ
// người lạ. Dùng làm lớp fallback thứ 2 trước khi đành chấp nhận "không
// resolve được" — tránh phụ thuộc vào DOM-scrape qua extension (chưa được
// cài đặt ở phía extension, xem ghi chú trong useZalo.ts requestExtensionDomSync).
// Cache riêng, ngắn hạn — 1 lần fetch dùng chung cho MỌI groupId/userId cần
// tra trong cùng cửa sổ thời gian, tránh gọi getCMRecent() lặp lại liên tục.
const RECENT_SNAPSHOT_TTL_MS = 20_000;
const recentSnapshotByAccount = new Map(); // accountId -> { ts, promise }

async function getRecentSnapshot(api, accountId) {
  const now = Date.now();
  const cached = recentSnapshotByAccount.get(accountId);
  if (cached && now - cached.ts < RECENT_SNAPSHOT_TTL_MS) return cached.promise;
  const promise = api
    .getCMRecent(200, 0)
    .then((resp) => resp?.conversations || resp || [])
    .catch((e) => {
      logger.warn(`[${accountId}] getRecentSnapshot failed`, { err: e?.message });
      return [];
    });
  recentSnapshotByAccount.set(accountId, { ts: now, promise });
  return promise;
}

async function resolveViaRecentList(api, accountId, threadId) {
  try {
    const list = await getRecentSnapshot(api, accountId);
    const match = list.find((c) => String(c.threadId ?? c.id ?? '') === String(threadId));
    const name = match?.name || match?.displayName;
    if (!match || !name) return null;
    return { name, avatar: match.avatar || null };
  } catch (_) {
    return null;
  }
}

/**
 * @param {object} api — zca-js API instance (session đang login)
 * @param {string} accountId
 * @param {string} groupId
 * @returns {Promise<{ok: boolean, group_name?: string, avatar_url?: string|null, ...} | null>}
 *   null khi không có `api` (session chưa sẵn sàng) — caller nên giữ nguyên tên cũ trong case này.
 */
export async function resolveGroupInfo(api, accountId, groupId) {
  const key = `${accountId}:${groupId}`;
  const now = Date.now();
  const cached = groupCache.get(key);
  if (cached) {
    const ttl = cached.failed ? GROUP_FAILURE_TTL_MS : GROUP_SUCCESS_TTL_MS;
    if (cached.ts > now - ttl) return cached.payload;
  }
  if (!api) return null;

  let payload;
  try {
    const response = await api.getGroupInfo(groupId);
    const groupData = response?.gridInfoMap?.[groupId] || null;
    if (!groupData || !groupData.name) {
      const viaRecent = await resolveViaRecentList(api, accountId, groupId);
      if (viaRecent) {
        payload = {
          ok: true,
          thread_id: groupId,
          thread_type: 'group',
          group_name: viaRecent.name,
          group_desc: null,
          avatar_url: viaRecent.avatar,
          member_count: 0,
          group_type: 'group',
        };
        groupCache.set(key, { ts: now, payload, failed: false });
        return payload;
      }
      payload = { ok: false, error: 'group not found or empty name', thread_id: groupId };
      groupCache.set(key, { ts: now, payload, failed: true });
      return payload;
    }
    payload = {
      ok: true,
      thread_id: groupId,
      thread_type: 'group',
      group_name: groupData.name,
      group_desc: groupData.desc || null,
      avatar_url: groupData.fullAvt || groupData.avt || null,
      member_count: groupData.totalMember || (groupData.memberIds?.length || 0),
      group_type: groupData.type === 2 ? 'community' : 'group',
      // Danh sách thành viên — dùng cho gợi ý "@" tag người cụ thể ở FE
      // (xem ZaloChatPanel). getGroupInfo() đã trả sẵn currentMems (id + tên
      // hiển thị) nên không cần gọi thêm getGroupMembersInfo.
      members: Array.isArray(groupData.currentMems)
        ? groupData.currentMems.map((m) => ({
            uid: String(m.id),
            name: m.dName || m.zaloName || String(m.id),
            avatar: m.avatar || null,
          }))
        : [],
    };
    groupCache.set(key, { ts: now, payload, failed: false });
    return payload;
  } catch (e) {
    logger.warn(`[${accountId}] resolveGroupInfo(${groupId}) failed`, {
      err: e?.message,
      code: e?.code,
    });
    const viaRecent = await resolveViaRecentList(api, accountId, groupId);
    if (viaRecent) {
      payload = {
        ok: true,
        thread_id: groupId,
        thread_type: 'group',
        group_name: viaRecent.name,
        group_desc: null,
        avatar_url: viaRecent.avatar,
        member_count: 0,
        group_type: 'group',
      };
      groupCache.set(key, { ts: now, payload, failed: false });
      return payload;
    }
    payload = { ok: false, error: 'getGroupInfo failed', detail: e?.message, thread_id: groupId };
    groupCache.set(key, { ts: now, payload, failed: true });
    return payload;
  }
}

/**
 * @param {object} api — zca-js API instance
 * @param {string} accountId
 * @param {string} userId
 * @returns {Promise<{ok: boolean, user_name?: string, avatar_url?: string|null, ...} | null>}
 *   null khi không có `api`. `ok:false` chỉ khi CẢ getUserInfo (bạn bè) LẪN
 *   getCMRecent (fallback, không giới hạn bạn bè) đều không tìm được tên —
 *   caller nên giữ tên cũ trong case này.
 */
export async function resolveUserInfo(api, accountId, userId) {
  const key = `${accountId}:${userId}`;
  const now = Date.now();
  const cached = userCache.get(key);
  if (cached) {
    const ttl = cached.failed ? USER_FAILURE_TTL_MS : USER_SUCCESS_TTL_MS;
    if (cached.ts > now - ttl) return cached.payload;
  }
  if (!api) return null;

  let payload;
  try {
    const response = await api.getUserInfo(userId);
    const profiles = response?.changed_profiles || {};
    const profile = Object.values(profiles)[0] || null;
    const name = profile?.zaloName || profile?.displayName;
    if (!profile || !name) {
      // getUserInfo (ZCA friend/getprofiles/v2) chỉ trả hồ sơ cho người ĐÃ LÀ
      // bạn bè — người lạ nhắn tin (message request) luôn rơi vào đây. Thử
      // getCMRecent(): API này KHÔNG có giới hạn "phải là bạn bè", cùng nguồn
      // Zalo Web dùng để hiện tên thật cho tin nhắn làm quen.
      const viaRecent = await resolveViaRecentList(api, accountId, userId);
      if (viaRecent) {
        payload = {
          ok: true,
          thread_id: userId,
          thread_type: 'user',
          user_name: viaRecent.name,
          avatar_url: viaRecent.avatar,
        };
        userCache.set(key, { ts: now, payload, failed: false });
        return payload;
      }
      payload = { ok: false, error: 'user not found or empty name', thread_id: userId };
      userCache.set(key, { ts: now, payload, failed: true });
      return payload;
    }
    payload = {
      ok: true,
      thread_id: userId,
      thread_type: 'user',
      user_name: name,
      avatar_url: profile.avatar || null,
    };
    userCache.set(key, { ts: now, payload, failed: false });
    return payload;
  } catch (e) {
    logger.warn(`[${accountId}] resolveUserInfo(${userId}) failed`, {
      err: e?.message,
      code: e?.code,
    });
    const viaRecent = await resolveViaRecentList(api, accountId, userId);
    if (viaRecent) {
      payload = {
        ok: true,
        thread_id: userId,
        thread_type: 'user',
        user_name: viaRecent.name,
        avatar_url: viaRecent.avatar,
      };
      userCache.set(key, { ts: now, payload, failed: false });
      return payload;
    }
    payload = { ok: false, error: 'getUserInfo failed', detail: e?.message, thread_id: userId };
    userCache.set(key, { ts: now, payload, failed: true });
    return payload;
  }
}
