/**
 * accountRegistry.js
 *
 * Quản lý metadata Zalo accounts: account_id → display_name / owner / status / ...
 * Mirror 1 phần với file data/sessions/<id>.json của sessionManager (cookies).
 *
 * 2 nguồn dữ liệu giữ đồng bộ với nhau:
 *   1) File: services/zalo-bridge/data/accounts.json  ← nguồn chính, dùng cho
 *      bridge (mỗi node process tự đọc/ghi, nhanh, không phụ thuộc DB).
 *   2) Supabase: bảng public.zalo_accounts ← phụ, dùng cho UI web (Next.js)
 *      query nhanh. Bridge update cả 2 khi có thay đổi; UI chỉ đọc Supabase.
 *
 * Lý do dual-write:
 *   - Bridge KHÔNG cần DB lúc startup để biết có bao nhiêu account (load file).
 *   - Supabase có thể tạm không khả dụng → bridge vẫn chạy, chỉ UI thiếu
 *     metadata → vẫn lấy được từ sessionManager.getStatus.
 *
 * Event bus: sessionManager phát event 'account_status_changed' mỗi khi status
 * đổi (login thành công, mất WS, logout). Registry lắng nghe → persist cả 2 nơi.
 *
 * Schema file (accounts.json):
 *   {
 *     "shop-owner": {
 *       "display_name": "Shop chính",
 *       "owner_staff_id": null,
 *       "status": "connected",
 *       "phone": "+84...",
 *       "zalo_user_id": "...",
 *       "zalo_display_name": "Nguyễn Văn A",
 *       "last_seen_at": "2026-07-06T...",
 *       "last_error": null,
 *       "metadata": {}
 *     },
 *     ...
 *   }
 *
 * Lưu ý:
 *   - Thread-safe: ghi file atomic qua writeFileSync + rename; tránh 2 process
 *     cùng ghi đè (1 process Node = 1 server).
 *   - Schema version đặt ở key "version" để migrate dễ.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const REGISTRY_PATH = path.join(DATA_DIR, 'accounts.json');
const SCHEMA_VERSION = 1;

function ensureDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (_) {
    /* ignore */
  }
}

function readFile() {
  ensureDir();
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_) {
    /* missing or malformed → fresh */
  }
  return { version: SCHEMA_VERSION, accounts: {} };
}

let _cache = readFile();
let _flushTimer = null;

function scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    writeFileAtomic();
  }, 500); // batch updates 500ms để tránh thrash
}

function writeFileAtomic() {
  ensureDir();
  const tmp = REGISTRY_PATH + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(_cache, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, REGISTRY_PATH);
  } catch (e) {
    logger.error('[accountRegistry] flush failed', { err: e.message });
  }
}

function writeSync() {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  writeFileAtomic();
}

function normalize(id, patch = {}) {
  const prev = _cache.accounts[id] || {};
  return {
    display_name: patch.display_name ?? prev.display_name ?? id,
    owner_staff_id: patch.owner_staff_id ?? prev.owner_staff_id ?? null,
    status: patch.status ?? prev.status ?? 'disconnected',
    phone: patch.phone ?? prev.phone ?? null,
    zalo_user_id: patch.zalo_user_id ?? prev.zalo_user_id ?? null,
    zalo_display_name: patch.zalo_display_name ?? prev.zalo_display_name ?? null,
    last_seen_at: patch.last_seen_at ?? prev.last_seen_at ?? null,
    last_error: patch.last_error ?? prev.last_error ?? null,
    metadata: patch.metadata ?? prev.metadata ?? {}
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Trả về metadata của 1 account, hoặc null nếu chưa đăng ký. */
export function getAccount(id) {
  return _cache.accounts[id] ? { account_id: id, ..._cache.accounts[id] } : null;
}

/** Liệt kê tất cả account đã đăng ký. */
export function listAccounts() {
  return Object.entries(_cache.accounts).map(([id, meta]) => ({
    account_id: id,
    ...meta
  }));
}

/**
 * Đăng ký / cập nhật metadata cho 1 account. Ghi debounce 500ms xuống đĩa.
 * Bắt buộc có accountId unique. Return true nếu thành công.
 */
export function upsertAccount(id, patch) {
  if (!id || typeof id !== 'string') return false;
  const sanitizedId = id.trim();
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(sanitizedId)) return false;
  _cache.accounts[sanitizedId] = normalize(sanitizedId, patch);
  scheduleFlush();
  return true;
}

/** Cập nhật status nhanh (gọi từ sessionManager hook). */
export function setStatus(id, status, opts = {}) {
  const prev = getAccount(id);
  if (!prev) return false;
  const patch = { status };
  if (opts.zaloUserId) patch.zalo_user_id = String(opts.zaloUserId);
  if (opts.zaloDisplayName) patch.zalo_display_name = String(opts.zaloDisplayName);
  if (opts.lastError !== undefined) patch.last_error = opts.lastError;
  if (status === 'connected') patch.last_seen_at = new Date().toISOString();
  return upsertAccount(id, patch);
}

/** Xoá account khỏi registry. KHÔNG xoá file data/sessions/<id>.json. */
export function removeAccount(id) {
  if (_cache.accounts[id]) {
    delete _cache.accounts[id];
    scheduleFlush();
    return true;
  }
  return false;
}

/**
 * Gọi lúc khởi động bridge: auto-register account "shop-owner" nếu chưa có.
 * Đảm bảo backward compat — code cũ dùng cứng "shop-owner" vẫn thấy trong
 * danh sách.
 */
export function ensureBootstrapped() {
  if (!_cache.accounts['shop-owner']) {
    upsertAccount('shop-owner', { display_name: 'Shop chính' });
    writeSync();
  }
}

/**
 * Sync metadata từ Supabase xuống file cache.
 * Thường gọi sau khi admin update zalo_accounts table — UI không cần khởi
 * động lại bridge để thấy owner/display_name mới.
 */
export function hydrateFromList(list = []) {
  for (const item of list) {
    if (!item?.account_id) continue;
    _cache.accounts[item.account_id] = normalize(item.account_id, item);
  }
  writeSync();
}

/** Force flush xuống đĩa, dùng khi shutdown. */
export function flush() {
  writeSync();
}
