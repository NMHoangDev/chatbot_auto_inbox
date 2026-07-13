/**
 * sessionManager.js
 *
 * Quản lý nhiều phiên đăng nhập Zalo (multi-account).
 * Mỗi "account" được định danh bằng accountId (VD: phone số / email / custom slug).
 *
 * Dữ liệu phiên (credentials) được persist vào ./data/sessions/<accountId>.json
 * để service có thể tự restore sau khi restart.
 */

import { Zalo, ThreadType } from 'zca-js';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chatwootService } from './chatwootService.js';
import { logger } from '../utils/logger.js';
import crypto from 'crypto';
import { persistIncomingMessage, catchUpRecentMessages, reconcileFallbackConversationNames } from './supabaseSync.js';
import { handleIncomingGroupMessage } from './forwardEngine.js';
import * as accountRegistry from './accountRegistry.js';

// Lazy-loaded event bus (avoid circular import với routes/zalo-client.js)
let _zaloEventBus = null;
export function setZaloEventBus(bus) {
  _zaloEventBus = bus;
}
function emitEvent(type, data) {
  try { _zaloEventBus?.broadcast(type, data); } catch (_) { /* ignore */ }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data/sessions');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Metadata image helper cho zca-js ─────────────────────────────────────────
async function imageMetadataGetter(filePath) {
  const buf = await fs.promises.readFile(filePath);
  const meta = await sharp(buf).metadata();
  return { height: meta.height, width: meta.width, size: meta.size ?? buf.length };
}

// ── Session state ─────────────────────────────────────────────────────────────────
/**
 * @type {Map<string, {
 *   api: import('zca-js').API,
 *   zaloId: string,
 *   inboxId: string|null,
 *   qrPng: Buffer|null,
 *   status: 'waiting_qr'|'logged_in'|'error',
 *   isWsConnected: boolean,
 *   listenerId: number,
 *   isSyncing: boolean,
 *   syncLock: Promise|null,
 *   syncIntervalId: any,
 *   watchdogId: any,
 *   reconnectAttempts: number,
 *   lastAliveCheckTime: number
 * }>}
 */
const sessions = new Map();

// Monotonic counter để phân biệt listener cũ vs mới (Bug 3 fix)
let listenerIdCounter = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────
function credPath(accountId) {
  return path.join(DATA_DIR, `${accountId}.json`);
}

// Mirror sang accountRegistry mỗi khi status state đổi. Best-effort — nếu
// file write fail thì log warn, không block luồng chính.
function reflectStatus(accountId, status, opts = {}) {
  try {
    accountRegistry.setStatus(accountId, status, opts);
    // PHASE 4: Phát SSE event để FE có thể reactive update UI (status dot
    // trong switcher, badge, toast cảnh báo). Chỉ phát khi status THẬT SỰ đổi
    // để tránh spam. setStatus trả về false nếu account chưa đăng ký.
    if (statusChanged(accountId, status)) {
      try {
        // Lazy require để tránh circular import với routes/zalo-client.js
        if (!globalThis.__zaloStatusEventBus) {
          // eslint-disable-next-line global-require
          globalThis.__zaloStatusEventBus = require('../routes/zalo-client.js').zaloEventBus;
        }
        const bus = globalThis.__zaloStatusEventBus;
        if (bus && bus.broadcast) {
          const acct = accountRegistry.getAccount(accountId);
          bus.broadcast('account_status_changed', {
            account_id: accountId,
            status,
            display_name: acct?.display_name || accountId,
            zalo_user_id: acct?.zalo_user_id || null,
            zalo_display_name: acct?.zalo_display_name || null,
            last_error: acct?.last_error || null,
            last_seen_at: acct?.last_seen_at || null,
            ts: Date.now()
          });
        }
      } catch (_) {
        /* event bus not ready yet */
      }
    }
  } catch (e) {
    logger.warn(`[${accountId}] accountRegistry.setStatus failed: ${e.message}`);
  }
}

// Memo tránh broadcast khi status set cùng giá trị liên tiếp (vd retry reconnect).
const _lastStatus = new Map();
function statusChanged(accountId, newStatus) {
  const prev = _lastStatus.get(accountId);
  if (prev === newStatus) return false;
  _lastStatus.set(accountId, newStatus);
  return true;
}

function saveCreds(accountId, creds) {
  fs.writeFileSync(credPath(accountId), JSON.stringify(creds, null, 2), { mode: 0o600 });
}

function loadCreds(accountId) {
  try {
    return JSON.parse(fs.readFileSync(credPath(accountId), 'utf8'));
  } catch {
    return null;
  }
}

function getChatwootAccountId(accountId) {
  const sessionAccountId = sessions.get(accountId)?.chatwootAccountId;
  if (sessionAccountId) return sessionAccountId;
  const savedAccountId = loadCreds(accountId)?.chatwootAccountId;
  return savedAccountId || accountId;
}

const sentMessagesCache = new Set();
const sentMessageFingerprints = new Set();

function cacheForOneMinute(cache, key) {
  if (!key) return;
  cache.add(key);
  setTimeout(() => cache.delete(key), 60000);
}

function normalizeMessageId(id) {
  if (id === undefined || id === null || id === '') return null;
  return String(id);
}

function markMessageAsSentByChatwoot(accountId, ...ids) {
  for (const id of ids.map(normalizeMessageId).filter(Boolean)) {
    cacheForOneMinute(sentMessagesCache, `${accountId}_${id}`);
  }
}

function isMessageSentByChatwoot(accountId, ...ids) {
  return ids
    .map(normalizeMessageId)
    .filter(Boolean)
    .some(id => sentMessagesCache.has(`${accountId}_${id}`));
}

function extractMessageText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'number' || typeof content === 'boolean') return String(content);
  if (Array.isArray(content)) return content.map(extractMessageText).filter(Boolean).join(' ');
  if (typeof content === 'object') {
    return content.msg || content.message || content.text || content.title || content.description || content.desc || content.href || content.url || '';
  }
  return '';
}

function messageFingerprint(accountId, threadId, text) {
  const compactText = String(text || '').trim().replace(/\s+/g, ' ');
  if (!compactText) return null;
  return `${accountId}_${threadId || ''}_${compactText}`;
}

function markMessageFingerprintAsSent(accountId, threadId, content) {
  const fp = messageFingerprint(accountId, threadId, extractMessageText(content?.msg ?? content));
  cacheForOneMinute(sentMessageFingerprints, fp);
}

function isMessageFingerprintSent(accountId, threadId, content) {
  const fp = messageFingerprint(accountId, threadId, extractMessageText(content));
  return fp ? sentMessageFingerprints.has(fp) : false;
}

function describeError(err) {
  if (!err) return {};
  return {
    name: err.name,
    message: err.message || String(err),
    code: err.code,
    status: err.status,
    responseStatus: err.response?.status,
    responseData: err.response?.data,
    stack: err.stack,
  };
}

function unwrapZaloMessage(msg) {
  return msg?.data || msg || {};
}

function getZaloMessageId(msg) {
  const data = unwrapZaloMessage(msg);
  return data.msgId || data.cliMsgId || data.globalMsgId || data.msgID || data.id;
}

function getZaloMessageTimestamp(msg) {
  const data = unwrapZaloMessage(msg);
  return Number(data.ts || data.timestamp || data.time || data.createTime || 0);
}

function getZaloMessageSenderId(msg) {
  const data = unwrapZaloMessage(msg);
  return data.uidFrom || data.fromId || data.senderId || '';
}

async function resolveOwnZaloProfile(api, fallbackId) {
  const fallback = { zaloId: fallbackId, displayName: '' };
  try {
    const info = await api.fetchAccountInfo?.();
    const data = info?.data || info?.profile || info?.user || info || {};
    return {
      zaloId: String(data.uid || data.userId || data.zaloId || data.id || fallbackId || ''),
      displayName: String(
        data.display_name ||
        data.displayName ||
        data.fullName ||
        data.name ||
        data.zaloName ||
        data.username ||
        ''
      ).trim(),
    };
  } catch (err) {
    logger.warn(`Cannot resolve own Zalo profile: ${err.message}`);
    return fallback;
  }
}

async function buildFallbackSyncConversations(accountId, api, maxRecent) {
  const conversations = [];
  const seen = new Set();

  try {
    const friends = await api.getAllFriends(Math.min(maxRecent, 200), 1);
    for (const friend of friends || []) {
      const threadId = String(friend.userId || friend.uid || friend.id || '');
      if (!threadId || seen.has(`u:${threadId}`)) continue;
      seen.add(`u:${threadId}`);
      conversations.push({ threadId, type: 1, updateTime: Date.now(), source: 'friends_fallback' });
      if (conversations.length >= maxRecent) break;
    }
    logger.info(`[${accountId}] Fallback sync collected ${conversations.length} friend conversations.`);
  } catch (err) {
    logger.error(`[${accountId}] Fallback sync failed to fetch friends`, describeError(err));
  }

  if (conversations.length >= maxRecent) return conversations;

  try {
    const groupsRes = await api.getAllGroups();
    const ids = new Set();
    if (groupsRes?.gridVerMap) Object.keys(groupsRes.gridVerMap).forEach(id => ids.add(String(id)));
    if (groupsRes?.gridInfoMap) Object.keys(groupsRes.gridInfoMap).forEach(id => ids.add(String(id)));

    for (const threadId of ids) {
      if (!threadId || seen.has(`g:${threadId}`)) continue;
      seen.add(`g:${threadId}`);
      conversations.push({ threadId, type: 2, updateTime: Date.now(), source: 'groups_fallback' });
      if (conversations.length >= maxRecent) break;
    }
    logger.info(`[${accountId}] Fallback sync collected ${conversations.length} total friend/group conversations.`);
  } catch (err) {
    logger.error(`[${accountId}] Fallback sync failed to fetch groups`, describeError(err));
  }

  return conversations;
}

async function syncMissedMessages(accountId, api, inboxId, lookbackHours = 72) {
  const chatwootAccountId = getChatwootAccountId(accountId);
  if (!inboxId) {
    logger.warn(`[${accountId}] Skip syncMissedMessages: no inboxId provided.`);
    return;
  }
  try {
    const maxRecent = lookbackHours === 0 ? 500 : 100;
    logger.info(`[${accountId}] Starting missed messages sync (inboxId=${inboxId}, lookbackHours=${lookbackHours}, maxRecent=${maxRecent})...`);

    let conversations = [];
    let lastTime = 0;
    while (conversations.length < maxRecent) {
      try {
        const countToFetch = Math.min(100, maxRecent - conversations.length);
        const res = await api.getCMRecent(countToFetch, lastTime);
        const batch = res?.conversations || [];
        if (batch.length === 0) break;

        conversations.push(...batch);

        if (batch.length < countToFetch) break;

        const lastConv = batch[batch.length - 1];
        if (lastConv && lastConv.updateTime) {
          lastTime = Number(lastConv.updateTime);
        } else {
          break;
        }
      } catch (apiErr) {
        logger.error(`[${accountId}] getCMRecent failed during sync page`, describeError(apiErr));
        break;
      }
    }

    logger.info(`[${accountId}] Found ${conversations.length} recent conversations from Zalo.`);

    if (conversations.length === 0 && lookbackHours === 0) {
      logger.warn(`[${accountId}] No recent conversations from getCMRecent; running manual sync fallback.`);
      conversations = await buildFallbackSyncConversations(accountId, api, Math.min(maxRecent, 250));
    }

    if (lookbackHours > 0) {
      const threshold = Date.now() - (lookbackHours * 60 * 60 * 1000);
      conversations = conversations.filter(conv => conv.updateTime && conv.updateTime > threshold);
      logger.info(`[${accountId}] Filtered to ${conversations.length} conversations updated in the last ${lookbackHours} hours.`);
    }

    for (const conv of conversations) {
      const threadId = conv.threadId;
      const isGroup = conv.type === 2; // type=2 is group in Zalo CM, 1 is personal

      // Resolve Chatwoot conversation
      const displayName = isGroup ? `Zalo Nhóm ${threadId}` : `Zalo ${threadId}`;
      const cwConv = await chatwootService.getOrCreateConversationForZaloUser(chatwootAccountId, inboxId, threadId, displayName, isGroup);
      if (!cwConv?.id) {
        logger.warn(`[${accountId}] Cannot get Chatwoot conversation for thread ${threadId}, skipping history sync.`);
        continue;
      }

      // Fetch last 30 Chatwoot messages for this conversation to collect existing external_ids
      const cwMessages = await chatwootService.getMessages(chatwootAccountId, cwConv.id);
      const existingExternalIds = new Set(
        cwMessages.map(m => m.external_id).filter(Boolean).map(String)
      );

      // Get history from Zalo (last 30 messages)
      let zaloMsgs = [];
      try {
        if (isGroup) {
          const historyRes = await api.getGroupChatHistory(threadId, 30);
          zaloMsgs = historyRes?.groupMsgs || [];
        } else {
          const historyRes = await api.getUserChatHistory(threadId, 30);
          zaloMsgs = historyRes?.msgs || [];
        }
      } catch (histErr) {
        logger.error(`[${accountId}] Failed to fetch chat history for thread ${threadId}`, describeError(histErr));
        continue;
      }

      // Filter out messages that already exist in Chatwoot
      const missedMsgs = zaloMsgs.filter(msg => {
        const id = getZaloMessageId(msg);
        return id && !existingExternalIds.has(String(id));
      });

      if (missedMsgs.length > 0) {
        logger.info(`[${accountId}] Found ${missedMsgs.length} missed messages for thread ${threadId}. Syncing...`);

        // Sort by timestamp ascending to post in chronological order
        missedMsgs.sort((a, b) => getZaloMessageTimestamp(a) - getZaloMessageTimestamp(b));

        const ownZaloId = await api.getOwnId?.() || '';

        for (const msg of missedMsgs) {
          const data = unwrapZaloMessage(msg);
          const isSelf = Boolean(msg?.isSelf) || String(getZaloMessageSenderId(data)) === String(ownZaloId);
          // Re-wrap in the structure expected by handleIncomingMessage
          const wrappedMsg = {
            data,
            threadId: msg?.threadId || threadId,
            type: msg?.type || (isGroup ? ThreadType.Group : ThreadType.User)
          };
          try {
            await chatwootService.handleIncomingMessage(chatwootAccountId, inboxId, wrappedMsg, api, isSelf);
          } catch (importErr) {
            logger.error(`[${accountId}] Failed to import missed message ${getZaloMessageId(data)}`, describeError(importErr));
          }
        }
      }
    }
    logger.info(`[${accountId}] History sync completed.`);
  } catch (err) {
    logger.error(`[${accountId}] Unexpected error during syncMissedMessages`, { err: err.message });
  }
}

// ── Per-event timeout wrapper (Problem C fix) ───────────────────────────────────
// Bọc 1 async handler bởi timeout 20s, tránh 1 event bị treo block toàn bộ queue
function withTimeout(fn, timeoutMs = 20000) {
  return (...args) => {
    Promise.race([
      fn(...args),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Event handler timeout')), timeoutMs))
    ]).catch(err => {
      logger.error(`Event handler error/timeout: ${err.message}`);
    });
  };
}

// ── Sync lock per-account (Bug 5 fix) ─────────────────────────────────────────
const syncLocks = new Map(); // accountId -> Promise

async function acquireSyncLock(accountId) {
  while (syncLocks.has(accountId)) {
    await syncLocks.get(accountId);
  }
  let releaseFn;
  const lockPromise = new Promise(resolve => { releaseFn = resolve; });
  syncLocks.set(accountId, lockPromise);
  return releaseFn;
}

function releaseSyncLock(accountId, releaseFn) {
  syncLocks.delete(accountId);
  if (releaseFn) releaseFn();
}

// ── Message event handler (shared by loginQR + loginCookie) ────────────────
async function attachListener(accountId, api, inboxId) {
  const state = sessions.get(accountId);
  if (state) state.status = 'logged_in';
  // Mirror sang registry → file + persist UI biết account đã connect.
  try {
    accountRegistry.upsertAccount(accountId, {
      display_name: state?.displayName || accountId,
      status: 'connected'
    });
    if (statusChanged(accountId, 'connected')) {
      const acct = accountRegistry.getAccount(accountId);
      if (!globalThis.__zaloStatusEventBus) {
        globalThis.__zaloStatusEventBus = require('../routes/zalo-client.js').zaloEventBus;
      }
      const bus = globalThis.__zaloStatusEventBus;
      if (bus && bus.broadcast) {
        bus.broadcast('account_status_changed', {
          account_id: accountId,
          status: 'connected',
          display_name: acct?.display_name || accountId,
          zalo_user_id: acct?.zalo_user_id || null,
          zalo_display_name: acct?.zalo_display_name || null,
          last_seen_at: acct?.last_seen_at || null,
          ts: Date.now()
        });
      }
    }
  } catch (_) { /* ignore */ }

  // Bug 3 fix: Gán listenerId duy nhất cho listener này
  const myListenerId = ++listenerIdCounter;
  if (state) state.listenerId = myListenerId;

  // Guard: chỉ xử lý event nếu listener này vẫn là listener hiện tại của session
  function isActiveListener() {
    const currentState = sessions.get(accountId);
    return currentState && currentState.listenerId === myListenerId;
  }

  function currentChatwootAccountId() {
    return getChatwootAccountId(accountId);
  }

  api.listener.on('message', withTimeout(async (msg) => {
    if (!isActiveListener()) return; // Bug 3: listener cũ bỏ qua
    const messageIds = [
      msg.data?.cliMsgId,
      msg.data?.msgId,
      msg.data?.globalMsgId,
      msg.data?.clientId,
    ];
    // ── LOG: nhận message thô từ zca-js ────────────────────────────────────
    logger.info(
      `[${accountId}] [RECV] ` +
      `msgType=${msg.type} ` +
      `threadId=${msg.threadId || msg.data?.idTo || 'N/A'} ` +
      `uidFrom=${msg.data?.uidFrom || 'N/A'} ` +
      `isSelf=${!!msg.isSelf} ` +
      `cliMsgId=${msg.data?.cliMsgId || 'N/A'} ` +
      `contentPreview=${(typeof msg.data?.content === 'string' ? msg.data.content : '').slice(0, 50)}`
    );
    // Broadcast SSE ngay từ đầu để InvoiceFlow frontend cập nhật UI real-time
    try {
      // Detect thread_type đầy đủ: msg.type là ThreadType.Group (1) / ThreadType.User (0)
      // Ngoài ra còn check type === 2 (legacy) hoặc 'group' (string).
      const isGroupMsg = msg.type === ThreadType.Group || msg.type === 2 || msg.type === 'group';
      const threadTypeFinal = isGroupMsg ? 'group' : 'user';
      const payload = {
        // thread_id raw để frontend không cần phân biệt — dùng chung cho mọi thread.
        thread_id: msg.threadId || msg.data?.idTo || null,
        group_id: msg.threadId || msg.data?.idTo || null,
        // message_id = Zalo msgId ổn định (string). Frontend dùng làm
        // source_message_id khi save qua /api/zalo/messages → conflict key
        // trùng với row bridge đã upsert (cùng user_id + source_message_id)
        // → ignoreDuplicates=true skip row thứ 2, chống duplicate messages.
        //
        // Lý do: trước đây payload không kèm message_id → FE fallback sinh
        // "sse_<ts>_<random>" làm source_message_id → mỗi SSE fire 1 row mới
        // trong DB dù cùng message → UI render duplicate khi fetch Supabase.
        message_id:
          msg.data?.msgId != null
            ? String(msg.data.msgId)
            : msg.data?.cliMsgId != null
              ? String(msg.data.cliMsgId)
              : msg.data?.globalMsgId != null
                ? String(msg.data.globalMsgId)
                : msg.data?.id != null
                  ? String(msg.data.id)
                  : null,
        sender_id: msg.data?.uidFrom || null,
        sender_name: msg.data?.dName || null,
        content: typeof msg.data?.content === 'string' ? msg.data?.content.slice(0, 200) : null,
        ts: msg.data?.ts || Date.now(),
        is_self: !!msg.isSelf,
        thread_type: threadTypeFinal,
        // PHASE 2: Gắn accountId để SSE filter đúng client đang xem account này.
        // Bridge SSE broadcast sẽ skip client có __zaloSseAccountId khác accountId.
        account_id: accountId,
      };
      // Populate threadTypeCache của zalo-client.js route (nếu import được).
      // Tránh circular import: dùng globalThis để share cache.
      if (payload.thread_id) {
        if (!globalThis.__zaloThreadTypeCache) globalThis.__zaloThreadTypeCache = new Map();
        globalThis.__zaloThreadTypeCache.set(`${accountId}:${payload.thread_id}`, threadTypeFinal);
      }
      // ── LOG: emit SSE với thread_type đã detect ───────────────────────────
      logger.info(
        `[${accountId}] [SSE→FRONTEND] new_message ` +
        `thread=${payload.thread_id} ` +
        `thread_type=${payload.thread_type} ` +
        `sender=${payload.sender_name || payload.sender_id} ` +
        `is_self=${payload.is_self} ` +
        `content=${(payload.content || '').slice(0, 60)}`
      );
      emitEvent('new_message', payload);
      // Persist vào Supabase NGAY TẠI BRIDGE — đảm bảo DB luôn có data kể cả
      // khi frontend không mở / không subscribe SSE. Idempotent với save bên FE
      // (cùng unique key user_id + source_message_id → chỉ giữ 1 row).
      persistIncomingMessage({
        accountId,
        threadId: payload.thread_id,
        threadType: payload.thread_type,
        msg,
        isSelf: payload.is_self,
        api,
      }).catch((err) => {
        logger.error(
          `[${accountId}] persistIncomingMessage err thread=${payload.thread_id}`,
          { err: err instanceof Error ? err.message : String(err) }
        );
      });

      // Auto-forward "nhóm chính" → nhóm đích (xem forwardEngine.js). Fire-and-forget:
      // KHÔNG await để không block xử lý message khác / không dính timeout của
      // withTimeout() khi có nhiều target + delay. Chạy cho MỌI tin nhắn trong group
      // (kể cả isSelf) — đặt trước nhánh isSelf/echo bên dưới để không bị return sớm.
      if (isGroupMsg && payload.thread_id) {
        handleIncomingGroupMessage({
          accountId,
          api,
          msg,
          threadId: payload.thread_id,
        }).catch((err) => {
          logger.error(`[${accountId}] forwardEngine error thread=${payload.thread_id}: ${err.message}`);
        });
      }
    } catch (err) {
      logger.error(`[${accountId}] emitEvent new_message failed: ${err.message}`);
    }

    if (msg.isSelf) {
      const selfThreadId = msg.threadId || msg.data?.idTo || msg.data?.uidFrom;
      if (
        isMessageSentByChatwoot(accountId, ...messageIds) ||
        isMessageFingerprintSent(accountId, selfThreadId, msg.data?.content)
      ) {
        // Bỏ qua tin trùng do chính Chatwoot gửi
        logger.info(`[${accountId}] Ignored Chatwoot echo from Zalo listener for thread=${selfThreadId}`);
        return;
      }
      // Tin nhắn gửi từ điện thoại Zalo -> Đồng bộ dưới dạng Outgoing sang Chatwoot
      try {
        const activeState = sessions.get(accountId);
        const activeInboxId = activeState?.inboxId || inboxId;
        await chatwootService.handleIncomingMessage(currentChatwootAccountId(), activeInboxId, msg, api, true);
      } catch (err) {
        logger.error(`[${accountId}] chatwoot handleIncomingSelfMessage error`, { err: err.message });
      }
      return;
    }
    try {
      const activeState = sessions.get(accountId);
      const activeInboxId = activeState?.inboxId || inboxId;
      await chatwootService.handleIncomingMessage(currentChatwootAccountId(), activeInboxId, msg, api, false);
    } catch (err) {
      logger.error(`[${accountId}] chatwoot handleIncoming error`, { err: err.message });
    }
  }));

  api.listener.on('undo', withTimeout(async (undoData) => {
    if (!isActiveListener()) return;
    try {
      const activeState = sessions.get(accountId);
      const activeInboxId = activeState?.inboxId || inboxId;
      await chatwootService.handleIncomingUndo(currentChatwootAccountId(), activeInboxId, undoData, api);
    } catch (err) {
      logger.error(`[${accountId}] chatwoot handleIncomingUndo error`, { err: err.message });
    }
  }));

  api.listener.on('typing', withTimeout(async (typingData) => {
    if (!isActiveListener()) return;
    try {
      const activeState = sessions.get(accountId);
      const activeInboxId = activeState?.inboxId || inboxId;
      await chatwootService.handleIncomingTyping(currentChatwootAccountId(), activeInboxId, typingData, api);
    } catch (err) {
      logger.error(`[${accountId}] chatwoot handleIncomingTyping error`, { err: err.message });
    }
  }));

  api.listener.on('group_event', withTimeout(async (groupEventData) => {
    if (!isActiveListener()) return;
    try {
      const activeState = sessions.get(accountId);
      const activeInboxId = activeState?.inboxId || inboxId;
      await chatwootService.handleIncomingGroupEvent(currentChatwootAccountId(), activeInboxId, groupEventData, api);
    } catch (err) {
      logger.error(`[${accountId}] chatwoot handleIncomingGroupEvent error`, { err: err.message });
    }
  }));

  // Bug 4 fix: isSyncing được lưu vào session state, không dùng closure local
  const triggerSync = () => {
    const currentState = sessions.get(accountId);
    if (!currentState || currentState.isSyncing) return;
    currentState.isSyncing = true;
    setTimeout(async () => {
      // Bug 5 fix: acquire sync lock trước khi chạy
      let releaseFn;
      try {
        releaseFn = await acquireSyncLock(accountId);
        const cs = sessions.get(accountId);
        if (cs?.api && cs?.status === 'logged_in' && cs?.inboxId) {
          logger.info(`[${accountId}] Running background synchronization...`);
          // Chỉ đồng bộ tin nhắn nhỡ trong 72 giờ qua, không sync lại toàn bộ contacts để giảm tải
          await syncMissedMessages(accountId, cs.api, cs.inboxId, 72);
        }
      } catch (err) {
        logger.error(`[${accountId}] Sync background error: ${err.message}`);
      } finally {
        releaseSyncLock(accountId, releaseFn);
        const cs2 = sessions.get(accountId);
        if (cs2) cs2.isSyncing = false;
      }
    }, 3000);
  };


  // Lắng nghe sự kiện kết nối thành công để cập nhật status hoạt động
  const onConnected = () => {
    if (!isActiveListener()) return;
    logger.info(`[${accountId}] WS connected/reconnected`);
    logger.info(`[${accountId}] zpwServiceMap keys: ${JSON.stringify(Object.keys(api.zpwServiceMap || {}))}`);
    logger.info(`[${accountId}] zpwServiceMap details: ${JSON.stringify(api.zpwServiceMap || {})}`);
    const activeState = sessions.get(accountId);
    if (activeState) {
      activeState.isWsConnected = true;
      activeState.reconnectAttempts = 0; // Reset retry counter on successful connect
      if (activeState.status === 'error') {
        activeState.status = 'logged_in';
      }
    }
    chatwootService.updateAllConversationsStatus(currentChatwootAccountId(), '🟢 Đang hoạt động').catch(err => {
      logger.error(`[${accountId}] Failed to update online status: ${err.message}`);
    });
    triggerSync();
  };

  api.listener.on('connected', onConnected);
  api.listener.on('reconnected', onConnected);

  // Tự động reconnect khi bị ngắt và cập nhật status ngoại tuyến
  api.listener.on('disconnected', (code, reason) => {
    if (!isActiveListener()) return;
    logger.warn(`[${accountId}] WS disconnected code=${code}`, { reason });
    const activeState = sessions.get(accountId);
    if (activeState) {
      activeState.isWsConnected = false;
    }
    reflectStatus(accountId, 'error', { lastError: `ws_disconnected_${code}` });
    chatwootService.updateAllConversationsStatus(currentChatwootAccountId(), '🔴 Ngoại tuyến').catch(err => {
      logger.error(`[${accountId}] Failed to update offline status: ${err.message}`);
    });
  });

  // Problem B fix: Auto-reconnect khi bị kick (3003/3000).
  // Mở rộng (2026-07-13): quan sát thấy WS còn tự đóng với code 1000
  // (NORMAL_CLOSURE) lặp lại mỗi 30-90s trong môi trường demo này — không
  // phải bị kick, nhưng trước đây chỉ 3000/3003 mới trigger reconnect ngay,
  // còn 1000 phải đợi watchdog (5 phút) mới phát hiện và reconnect lại, tạo
  // ra khoảng trống vài phút mỗi lần mà tin nhắn đến KHÔNG được nhận (WS đã
  // chết, không có listener nào đang nghe). Coi MỌI closed event là cần
  // reconnect ngay, không chỉ 2 mã kick — an toàn vì autoReconnect() đã tự
  // giới hạn tối đa 3 lần thử/30s và loginWithCookies() đã guard skip nếu
  // session vẫn đang logged_in + WS connected (không tạo double-connect).
  api.listener.on('closed', (code, reason) => {
    if (!isActiveListener()) return;
    logger.warn(`[${accountId}] WS closed code=${code}, reason=${reason}`);
    const activeState = sessions.get(accountId);
    if (activeState) {
      activeState.isWsConnected = false;
      activeState.status = 'error';
      reflectStatus(accountId, 'error', { lastError: `ws_closed_${code}` });
      if (activeState.syncIntervalId) {
        clearInterval(activeState.syncIntervalId);
      }
    }
    try { api.listener.stop(); } catch {}
    chatwootService.updateAllConversationsStatus(currentChatwootAccountId(), '🔴 Ngoại tuyến').catch(() => {});

    // Auto-reconnect sau 30s với cookie từ disk — cho MỌI mã đóng kết nối,
    // không riêng kick (3000/3003).
    autoReconnect(accountId);
  });

  api.listener.on('error', (err) => {
    if (!isActiveListener()) return;
    logger.error(`[${accountId}] WS error`, { err: String(err) });
    const errStr = String(err).toLowerCase();
    if (errStr.includes('login') || errStr.includes('cookie') || errStr.includes('auth') || errStr.includes('unauthorized')) {
      const activeState = sessions.get(accountId);
      if (activeState) {
        activeState.status = 'error';
        if (activeState.syncIntervalId) {
          clearInterval(activeState.syncIntervalId);
        }
      }
      try { api.listener.stop(); } catch {}
      chatwootService.updateAllConversationsStatus(currentChatwootAccountId(), '🔴 Ngoại tuyến').catch(() => {});
    }
  });

  api.listener.start({ retryOnClose: true });
  logger.info(`[${accountId}] Zalo listener started (inboxId=${inboxId}, listenerId=${myListenerId})`);

  // Catch-up: fetch N message gần nhất từ Zalo + persist vào Supabase. Bù các
  // tin lỡ trong lúc bridge restart, WS reconnect, hoặc account vừa login.
  // Idempotent — gọi nhiều lần vẫn OK, tin đã có sẽ bị skip bởi unique.
  catchUpRecentMessages({ accountId, api, count: 50 }).catch((err) => {
    logger.warn(
      `[${accountId}] catchUpRecentMessages failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  });

  // Sửa các conversation đang kẹt tên tạm "Group <id>" / "Zalo <id>" từ TRƯỚC
  // (tạo ra bởi bridge/FE trước khi có fix tự-resolve) — chạy mỗi lần
  // login/reconnect, không cần frontend mở tab.
  reconcileFallbackConversationNames({ accountId, api }).catch((err) => {
    logger.warn(
      `[${accountId}] reconcileFallbackConversationNames failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  });

  // Thiết lập interval đồng bộ mỗi 24 giờ (để tránh quá tải API Zalo)
  if (state) {
    if (state.syncIntervalId) {
      clearInterval(state.syncIntervalId);
    }
    state.syncIntervalId = setInterval(async () => {
      if (!isActiveListener()) return;
      logger.info(`[${accountId}] Running scheduled daily Zalo contacts sync...`);
      let releaseFn;
      try {
        releaseFn = await acquireSyncLock(accountId);
        const currentState = sessions.get(accountId);
        if (currentState?.api && currentState?.inboxId && currentState?.status === 'logged_in') {
          await chatwootService.syncAllZaloContacts(currentChatwootAccountId(), currentState.api, currentState.inboxId);
        } else {
          logger.warn(`[${accountId}] Scheduled sync skipped: session not logged in or missing inboxId.`);
        }
      } catch (err) {
        logger.error(`[${accountId}] Scheduled syncAllZaloContacts background error: ${err.message}`);
      } finally {
        releaseSyncLock(accountId, releaseFn);
      }
    }, 24 * 60 * 60 * 1000);

    // Watchdog timer — lưới an toàn phòng khi listener 'closed'/'disconnected'
    // không bắn (process treo, event bị miss...) mà autoReconnect() ở đó
    // không tự chạy. Giảm từ 5 phút xuống 45s (2026-07-13): với chu kỳ 5
    // phút, mỗi lần miss 1 disconnect thật sẽ tạo khoảng trống tới 5 phút
    // không nhận được tin nhắn nào — quá dài cho demo cần ổn định. autoReconnect
    // tự no-op nếu đang reconnect/logged_in+WS connected nên gọi dồn dập không
    // gây double-connect.
    if (state.watchdogId) clearInterval(state.watchdogId);
    state.watchdogId = setInterval(() => {
      if (!isActiveListener()) return;
      const cs = sessions.get(accountId);
      if (cs && !cs.isWsConnected && cs.status !== 'waiting_qr') {
        logger.warn(`[${accountId}] Watchdog: session disconnected for too long, attempting auto-reconnect...`);
        autoReconnect(accountId);
      }
    }, 45 * 1000);
  }
}

// Problem B fix: Auto-reconnect khi bị Zalo kick (code 3003/3000)
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 30000; // 30 giây

// Chống double-schedule: sau khi mở rộng autoReconnect() ra MỌI mã đóng WS
// (không chỉ kick 3000/3003, xem listener 'closed' phía trên) + watchdog rút
// xuống 45s, 'closed'/watchdog có thể cùng gọi autoReconnect() cho cùng 1
// accountId trước khi lượt reconnect trước đó kịp chạy xong (30s delay) →
// nếu không chặn, 2 lượt login({cookie}) chạy gần như đồng thời sẽ tạo ra
// đúng vấn đề đang cố sửa (nhiều connection cùng lúc bị Zalo coi là trùng
// lặp). accountId chỉ được gỡ khỏi Set sau khi lượt reconnect đang chờ THỰC
// SỰ chạy xong (thành công hay thất bại).
const reconnectScheduled = new Set();

async function autoReconnect(accountId) {
  if (reconnectScheduled.has(accountId)) return;
  reconnectScheduled.add(accountId);

  const currentState = sessions.get(accountId);
  const attempts = (currentState?.reconnectAttempts || 0) + 1;
  if (attempts > MAX_RECONNECT_ATTEMPTS) {
    logger.error(`[${accountId}] Auto-reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts. Manual intervention required.`);
    // Gửi thông báo vào Chatwoot dưới dạng note nội bộ
    if (currentState?.inboxId) {
      chatwootService.updateAllConversationsStatus(getChatwootAccountId(accountId), `🔴 Mất kết nối - Cần đăng nhập lại`).catch(() => {});
    }
    reconnectScheduled.delete(accountId);
    return;
  }

  if (currentState) currentState.reconnectAttempts = attempts;
  logger.info(`[${accountId}] Auto-reconnect attempt ${attempts}/${MAX_RECONNECT_ATTEMPTS} in ${RECONNECT_DELAY_MS / 1000}s...`);

  setTimeout(async () => {
    const creds = loadCreds(accountId);
    if (!creds) {
      logger.error(`[${accountId}] Auto-reconnect: no saved credentials found.`);
      reconnectScheduled.delete(accountId);
      return;
    }
    try {
      await sessionManager.loginWithCookies(accountId, creds.inboxId ?? null, creds);
      logger.info(`[${accountId}] Auto-reconnect SUCCESS on attempt ${attempts}`);
      reconnectScheduled.delete(accountId);
    } catch (err) {
      logger.error(`[${accountId}] Auto-reconnect attempt ${attempts} failed: ${err.message}`);
      reconnectScheduled.delete(accountId);
      // Tiếp tục thử lại
      autoReconnect(accountId);
    }
  }, RECONNECT_DELAY_MS);
}

function closeSession(accountId) {
  const s = sessions.get(accountId);
  if (s) {
    logger.info(`[${accountId}] Cleaning up active session listener and intervals...`);
    if (s.api) {
      try { s.api.listener.stop(); } catch {}
    }
    if (s.syncIntervalId) {
      clearInterval(s.syncIntervalId);
    }
    if (s.watchdogId) {
      clearInterval(s.watchdogId);
    }
    sessions.delete(accountId);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
export const sessionManager = {
  /**
   * Bắt đầu login QR cho accountId.
   * QR ảnh được lưu tạm vào sessions[accountId].qrPng để route GET /auth/qr-image trả về.
   */
  async startQrLogin(accountId, inboxId) {
    if (sessions.has(accountId)) {
      const s = sessions.get(accountId);
      if (s.status === 'logged_in') throw new Error('Already logged in');
    }
    closeSession(accountId);
    reflectStatus(accountId, 'waiting_qr');

    sessions.set(accountId, {
      api: null,
      zaloId: null,
      displayName: '',
      chatwootAccountId: accountId,
      inboxId,
      qrPng: null,
      status: 'waiting_qr',
      isWsConnected: false,
    });

    const zalo = new Zalo({ imageMetadataGetter, logging: true, selfListen: true });

    // loginQR là Promise dài hạn - resolve khi user scan thành công
    const loginPromise = zalo.loginQR(
      { qrPath: null }, // không ghi file, ta tự xử lý qua callback
      async (event) => {
        const { EventType } = await import('zca-js');
        switch (event.type) {
          case 0: { // QRCodeGenerated
            // event.data là base64 PNG hoặc path — đọc thành buffer
            let qrBuf;
            if (typeof event.data === 'string' && event.data.startsWith('data:')) {
              qrBuf = Buffer.from(event.data.split(',')[1], 'base64');
            } else {
              try { qrBuf = await fs.promises.readFile(event.data); }
              catch { qrBuf = Buffer.from(event.data, 'base64'); }
            }
            const s = sessions.get(accountId);
            if (s) s.qrPng = qrBuf;
            logger.info(`[${accountId}] QR generated`);
            break;
          }
          case 1: // QRCodeExpired
            logger.warn(`[${accountId}] QR expired, retry...`);
            event.retry?.();
            break;
          case 2: // QRCodeScanned
            logger.info(`[${accountId}] QR scanned, awaiting approval`);
            break;
          case 3: // QRCodeDeclined
            logger.warn(`[${accountId}] QR declined by user`);
            break;
          case 4: { // GotLoginInfo
            const creds = event.data; // { imei, cookie, userAgent }
            saveCreds(accountId, { ...creds, inboxId });
            logger.info(`[${accountId}] Login success, credentials saved`);
            break;
          }
        }
      }
    );

    loginPromise
      .then(async (api) => {
        const s = sessions.get(accountId);
        if (s) {
          s.api = api;
          const ownId = await api.getOwnId?.() ?? accountId;
          const profile = await resolveOwnZaloProfile(api, ownId);
          s.zaloId = profile.zaloId || ownId;
          s.displayName = profile.displayName || '';
        }
        await attachListener(accountId, api, inboxId);
      })
      .catch((err) => {
        logger.error(`[${accountId}] QR login failed`, { err: err.message });
        const s = sessions.get(accountId);
        if (s) s.status = 'error';
      });

    return { started: true };
  },

  /**
   * Login bằng cookie (từ extension-login-zalo).
   * creds = { imei, cookie: [{key,value,domain,...}], userAgent }
   */
  async loginWithCookies(accountId, inboxId, creds) {
    logger.info(`[${accountId}] loginWithCookies starting`, {
      hasCookie: !!creds.cookie,
      cookieCount: Array.isArray(creds.cookie) ? creds.cookie.length : 0,
      cookieKeys: Array.isArray(creds.cookie) ? creds.cookie.map(c => c.key || c.name || 'unknown') : [],
      hasImei: !!creds.imei,
      imeiLen: (creds.imei || '').length,
      hasUserAgent: !!creds.userAgent,
      userAgentLen: (creds.userAgent || '').length,
    });

    // Guard: nếu session đã logged_in và WS connected → bỏ qua, tránh
    // tạo connection thứ 2 gây Overlimit connection (code 3000) từ Zalo.
    const existing = sessions.get(accountId);
    if (existing?.api && existing.status === 'logged_in' && existing.isWsConnected) {
      logger.info(`[${accountId}] loginWithCookies skipped — session already logged_in and WS connected`);
      return { success: true, zaloId: existing.zaloId, displayName: existing.displayName, skipped: true };
    }

    closeSession(accountId);

    const zalo = new Zalo({ imageMetadataGetter, logging: true, selfListen: true });

    const imei = creds.imei || crypto.randomUUID();
    if (!creds.imei) {
      logger.info(`[${accountId}] Generated fallback IMEI: ${imei}`);
    }

    let api;
    try {
      api = await zalo.login({
        imei: imei,
        cookie: creds.cookie,
        userAgent: creds.userAgent,
      });
    } catch (loginErr) {
      logger.error(`[${accountId}] zca-js login() threw`, {
        message: loginErr.message,
        stack: loginErr.stack?.split('\n').slice(0, 5).join(' | '),
      });
      throw loginErr;
    }

    let zaloId = accountId;
    try { zaloId = await api.getOwnId?.() ?? accountId; } catch {}
    const profile = await resolveOwnZaloProfile(api, zaloId);
    zaloId = profile.zaloId || zaloId;
    const displayName = profile.displayName || '';

    const chatwootAccountId = String(creds.chatwootAccountId || creds.chatwoot_account_id || accountId);
    sessions.set(accountId, {
      api, zaloId, displayName, chatwootAccountId, inboxId, qrPng: null,
      status: 'logged_in', isWsConnected: true,
      listenerId: 0, isSyncing: false, syncLock: null,
      syncIntervalId: null, watchdogId: null,
      reconnectAttempts: 0, lastAliveCheckTime: 0
    });
    saveCreds(accountId, { ...creds, imei, inboxId, zaloId, displayName, chatwootAccountId });
    reflectStatus(accountId, 'connected', {
      zaloUserId: zaloId,
      zaloDisplayName: displayName
    });
    await attachListener(accountId, api, inboxId);
    logger.info(`[${accountId}] loginWithCookies SUCCESS`, { zaloId, displayName, inboxId });
    return { success: true, zaloId, displayName };
  },

  /** Trả về QR image PNG buffer cho accountId đang login */
  getQrImage(accountId) {
    return sessions.get(accountId)?.qrPng ?? null;
  },

  /** Status của session */
  getStatus(accountId) {
    const s = sessions.get(accountId);
    if (!s) return null;
    return {
      status: s.status,
      zaloId: s.zaloId,
      displayName: s.displayName || '',
      chatwootAccountId: s.chatwootAccountId || getChatwootAccountId(accountId),
      inboxId: s.inboxId,
      isWsConnected: s.isWsConnected || false,
    };
  },

  /** Danh sách tất cả sessions */
  listSessions() {
    return [...sessions.entries()].map(([id, s]) => ({
      accountId: id,
      status: s.status,
      zaloId: s.zaloId,
      displayName: s.displayName || '',
      chatwootAccountId: s.chatwootAccountId || getChatwootAccountId(id),
      inboxId: s.inboxId,
      isWsConnected: s.isWsConnected || false,
    }));
  },

  /** Gửi tin nhắn từ Chatwoot → Zalo */
  async sendMessage(accountId, threadId, threadType, content) {
    const s = sessions.get(accountId);
    if (!s || !s.api) throw new Error(`Session ${accountId} not found or not logged in`);
    const type = threadType === 'group' ? ThreadType.Group : ThreadType.User;
    // ── LOG: request gửi tin từ frontend ───────────────────────────────
    logger.info(
      `[${accountId}] [SEND_REQ] threadId=${threadId} threadType=${threadType} → zca ThreadType(${ThreadType[type]}) content="${(content?.msg || '').slice(0, 80)}"`
    );

    // Gán/Sinh clientId để nhận dạng tin nhắn xuất phát từ Chatwoot
    const clientId = content.clientId || Date.now();
    content.clientId = clientId;
    markMessageAsSentByChatwoot(accountId, String(clientId));
    markMessageFingerprintAsSent(accountId, threadId, content);

    const result = await s.api.sendMessage(content, threadId, type);
    // ── LOG: gửi thành công ────────────────────────────────────
    logger.info(
      `[${accountId}] [SEND_OK] threadId=${threadId} threadType=${threadType} msgId=${result?.message?.msgId || 'N/A'} cliMsgId=${result?.message?.cliMsgId || 'N/A'}`
    );
    const sentIds = [
      clientId,
      result?.message?.msgId,
      result?.message?.cliMsgId,
      result?.message?.globalMsgId,
      ...(result?.attachment || []).flatMap(item => [item?.msgId, item?.cliMsgId, item?.globalMsgId]),
    ];
    markMessageAsSentByChatwoot(accountId, ...sentIds);
    markMessageFingerprintAsSent(accountId, threadId, content);
    return result;
  },

  /** Lấy API instance để route khác dùng */
  getApi(accountId) {
    return sessions.get(accountId)?.api ?? null;
  },

  getChatwootAccountId(accountId) {
    return getChatwootAccountId(accountId);
  },

  setChatwootAccountId(accountId, chatwootAccountId) {
    if (!accountId || !chatwootAccountId) return false;
    const normalized = String(chatwootAccountId);
    const s = sessions.get(accountId);
    if (s) s.chatwootAccountId = normalized;
    const creds = loadCreds(accountId);
    if (creds) saveCreds(accountId, { ...creds, chatwootAccountId: normalized });
    return true;
  },

  /**
   * Trả về thông tin session cho accountId, hoặc null nếu không có.
   * Dùng bởi GET /auth/session/:accountId để Vue component check trạng thái kết nối.
   */
  getSession(accountId) {
    const s = sessions.get(accountId);
    if (!s) return null;
    return {
      status: s.status,
      zaloId: s.zaloId,
      displayName: s.displayName || '',
      chatwootAccountId: s.chatwootAccountId || getChatwootAccountId(accountId),
      inboxId: s.inboxId,
      isWsConnected: s.isWsConnected || false,
    };
  },

  /** Kiểm tra phiên Zalo có thực sự sống hay không qua việc gọi thử API */
  async checkSessionAlive(accountId) {
    const s = sessions.get(accountId);
    if (!s || !s.api) return false;

    // Cache kết quả kiểm tra trong 15 giây để tránh quá tải Zalo API
    const now = Date.now();
    if (s.lastAliveCheckTime && (now - s.lastAliveCheckTime < 15000)) {
      return s.status === 'logged_in';
    }

    s.lastAliveCheckTime = now;
    try {
      const ownIdPromise = s.api.getOwnId();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout check session')), 3000)
      );
      await Promise.race([ownIdPromise, timeoutPromise]);
      return true;
    } catch (err) {
      logger.error(`[${accountId}] Session check failed: ${err.message}`);
      s.status = 'error';
      s.isWsConnected = false;
      try { s.api.listener.stop(); } catch {}
      if (s.syncIntervalId) clearInterval(s.syncIntervalId);
      chatwootService.updateAllConversationsStatus(getChatwootAccountId(accountId), '🔴 Ngoại tuyến').catch(() => {});
      return false;
    }
  },

  /** Đồng bộ các tin nhắn bị nhỡ */
  async syncMissedMessages(accountId, api, inboxId, lookbackHours = 72) {
    return syncMissedMessages(accountId, api, inboxId, lookbackHours);
  },

  /** Restore tất cả sessions từ disk (gọi khi khởi động) */
  async restoreAll() {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const accountId = file.replace('.json', '');
      const creds = loadCreds(accountId);
      if (!creds) continue;
      try {
        logger.info(`[${accountId}] Restoring session from disk...`);
        await this.loginWithCookies(accountId, creds.inboxId ?? null, creds);
      } catch (err) {
        logger.error(`[${accountId}] Restore failed`, { err: err.message });
      }
    }
  },

  /** Cập nhật inboxId cho session đang có */
  setInboxId(accountId, inboxId) {
    const s = sessions.get(accountId);
    if (!s) return false;
    const oldInboxId = s.inboxId;
    s.inboxId = inboxId;
    const creds = loadCreds(accountId);
    if (creds) saveCreds(accountId, { ...creds, inboxId });

    // If inbox binding changes, prioritize missed messages. Full contact/group
    // sync can take a long time on personal Zalo accounts and should not block
    // realtime chat delivery.
    if (s.api && s.status === 'logged_in' && oldInboxId !== inboxId) {
      logger.info(`[${accountId}] Inbox ID changed from ${oldInboxId} to ${inboxId}. Triggering message sync...`);
      (async () => {
        let releaseFn;
        try {
          releaseFn = await acquireSyncLock(accountId);
          await syncMissedMessages(accountId, s.api, inboxId, 72);
        } catch (err) {
          logger.error(`[${accountId}] syncMissedMessages from setInboxId error: ${err.message}`);
        } finally {
          releaseSyncLock(accountId, releaseFn);
        }
      })();
    }
    return true;
  },

  /** Hủy session và xóa credentials */
  async destroySession(accountId) {
    const s = sessions.get(accountId);
    if (s?.api) {
      try { s.api.listener.stop(); } catch {}
    }
    if (s?.syncIntervalId) {
      clearInterval(s.syncIntervalId);
    }
    if (s?.watchdogId) {
      clearInterval(s.watchdogId);
    }
    chatwootService.updateAllConversationsStatus(getChatwootAccountId(accountId), '🔴 Ngoại tuyến').catch(() => {});
    // Bug 2 fix: Dọn dẹp tracked conversations
    chatwootService.clearActiveConversations(accountId);
    sessions.delete(accountId);
    try { fs.unlinkSync(credPath(accountId)); } catch {}
    reflectStatus(accountId, 'disconnected');
  },

  /**
   * Stop listener hiện tại + restore lại từ credentials trên disk.
   * Dùng khi Zalo đóng WS (Overlimit 3000) và muốn reconnect mà không cần login lại.
   * KHÔNG xóa file credentials.
   */
  async restartListener(accountId) {
    const s = sessions.get(accountId);
    if (s?.api) {
      try { s.api.listener.stop(); } catch {}
    }
    if (s?.syncIntervalId) {
      clearInterval(s.syncIntervalId);
    }
    if (s?.watchdogId) {
      clearInterval(s.watchdogId);
    }
    sessions.delete(accountId);
    const creds = loadCreds(accountId);
    if (!creds) {
      logger.warn(`[${accountId}] restartListener: no creds on disk`);
      return { ok: false, reason: 'no_creds' };
    }
    await this.loginWithCookies(accountId, creds.inboxId ?? null, creds);
    return { ok: true };
  },

  async destroyAll() {
    for (const [accountId, s] of sessions.entries()) {
      if (s?.api) {
        try { s.api.listener.stop(); } catch {}
      }
      if (s?.syncIntervalId) {
        clearInterval(s.syncIntervalId);
      }
      if (s?.watchdogId) {
        clearInterval(s.watchdogId);
      }
      chatwootService.updateAllConversationsStatus(getChatwootAccountId(accountId), '🔴 Ngoại tuyến').catch(() => {});
      chatwootService.clearActiveConversations(accountId);
    }
    sessions.clear();
  },
};
