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
    };
    groupCache.set(key, { ts: now, payload, failed: false });
    return payload;
  } catch (e) {
    logger.warn(`[${accountId}] resolveGroupInfo(${groupId}) failed`, {
      err: e?.message,
      code: e?.code,
    });
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
 *   null khi không có `api`. `ok:false` khi user không phải bạn bè (ZCA giới hạn) —
 *   caller nên fallback DOM scrape (chỉ FE làm được) hoặc giữ tên cũ.
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
    payload = { ok: false, error: 'getUserInfo failed', detail: e?.message, thread_id: userId };
    userCache.set(key, { ts: now, payload, failed: true });
    return payload;
  }
}
