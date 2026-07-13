/**
 * /auth/accounts routes — quản lý multi-account Zalo.
 *
 *   GET    /auth/accounts         → liệt kê tất cả account_id đã biết
 *                                    + status runtime từ sessionManager
 *   POST   /auth/accounts         → tạo account mới (đăng ký accountId + displayName)
 *                                    Trả về { accountId, qrLoginUrl } để FE redirect.
 *   PUT    /auth/accounts/:id     → cập nhật displayName / owner_staff_id / metadata.
 *                                    Ghi cả file accounts.json lẫn Supabase (best-effort).
 *   DELETE /auth/accounts/:id     → xoá khỏi registry. KHÔNG động đến data/sessions/<id>.json.
 */

import { Router } from 'express';
import { sessionManager } from '../services/sessionManager.js';
import * as accountRegistry from '../services/accountRegistry.js';
import { logger } from '../utils/logger.js';

const router = Router();

const SLUG_RE = /^[a-zA-Z0-9_.-]{1,64}$/;

function isValidSlug(id) {
  return typeof id === 'string' && SLUG_RE.test(id);
}

/**
 * Tổng hợp status runtime từ sessionManager (memory) +
 * metadata từ accountRegistry (file). FE cần cả 2 để hiển thị.
 */
function composeAccount(id) {
  const meta = accountRegistry.getAccount(id);
  const runtime = sessionManager.getStatus(id);
  const merged = {
    account_id: id,
    display_name: meta?.display_name || runtime?.displayName || id,
    status: runtime?.status === 'logged_in' && runtime?.isWsConnected !== false
      ? 'connected'
      : runtime?.status || meta?.status || 'disconnected',
    zalo_user_id: meta?.zalo_user_id || runtime?.zaloId || null,
    zalo_display_name: meta?.zalo_display_name || runtime?.displayName || null,
    inbox_id: runtime?.inboxId || null,
    is_ws_connected: runtime ? runtime.isWsConnected !== false : false,
    owner_staff_id: meta?.owner_staff_id ?? null,
    phone: meta?.phone ?? null,
    last_seen_at: meta?.last_seen_at ?? null,
    last_error: meta?.last_error ?? null,
    metadata: meta?.metadata ?? {}
  };
  return merged;
}

// ── List ────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    // Union: ids từ registry ∪ ids từ sessionManager (để catch session đã login
    // mà chưa được register — ví dụ test/extension cũ).
    const runtimeIds = sessionManager.listSessions().map((s) => s.accountId);
    const ids = new Set([
      ...accountRegistry.listAccounts().map((a) => a.account_id),
      ...runtimeIds
    ]);
    // Fallback nếu sessionManager.listSessions không tồn tại — dùng getStatus cho mọi id.
    const accounts = [];
    for (const id of ids) {
      accounts.push(composeAccount(id));
    }
    // Sort: connected trước, sau đó theo display_name.
    accounts.sort((a, b) => {
      const order = { connected: 0, waiting_qr: 1, error: 2, disconnected: 3 };
      const ao = order[a.status] ?? 9;
      const bo = order[b.status] ?? 9;
      if (ao !== bo) return ao - bo;
      return String(a.display_name).localeCompare(String(b.display_name));
    });
    res.json({ accounts });
  } catch (err) {
    logger.error('accounts list error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Get one ─────────────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  if (!isValidSlug(req.params.id)) {
    return res.status(400).json({ error: 'Invalid accountId' });
  }
  const data = composeAccount(req.params.id);
  if (!data.is_ws_connected && data.status === 'disconnected') {
    // Vẫn trả row để UI hiển thị "Thêm tài khoản" — nhưng flag created = true
    // nếu metadata từng tồn tại trong registry.
    return res.json(data);
  }
  res.json(data);
});

// ── Create ──────────────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const { accountId, displayName, inboxId, ownerStaffId } = req.body || {};
  if (!isValidSlug(accountId)) {
    return res.status(400).json({ error: 'accountId không hợp lệ (chỉ chữ, số, gạch dưới/gạch ngang, tối đa 64 ký tự)' });
  }
  const name = String(displayName || '').trim() || accountId;
  const inbox = Number(inboxId) || Math.floor(Date.now() / 1000); // fallback nếu không có inboxId

  if (accountRegistry.getAccount(accountId)) {
    return res.status(409).json({ error: 'accountId đã tồn tại' });
  }

  try {
    accountRegistry.upsertAccount(accountId, {
      display_name: name,
      owner_staff_id: ownerStaffId || null,
      status: 'disconnected'
    });
    accountRegistry.flush();

    const data = composeAccount(accountId);
    res.json({
      account: data,
      qrLoginUrl: `/auth/qr-login`,
      // FE có thể gọi POST /auth/qr-login với { accountId, inboxId } luôn.
      hint: { accountId, inboxId: inbox }
    });
  } catch (err) {
    logger.error('accounts create error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Update ──────────────────────────────────────────────────────────────────
router.put('/:id', (req, res) => {
  if (!isValidSlug(req.params.id)) {
    return res.status(400).json({ error: 'Invalid accountId' });
  }
  const patch = req.body || {};
  if (!accountRegistry.getAccount(req.params.id) && !sessionManager.getStatus(req.params.id)) {
    return res.status(404).json({ error: 'Account not found' });
  }
  // Whitelist các field được phép update từ FE.
  const allowed = {};
  if (typeof patch.displayName === 'string') allowed.display_name = patch.displayName.trim();
  if (patch.ownerStaffId === null || typeof patch.ownerStaffId === 'string') {
    allowed.owner_staff_id = patch.ownerStaffId || null;
  }
  if (typeof patch.phone === 'string') allowed.phone = patch.phone.trim();
  if (patch.metadata && typeof patch.metadata === 'object') {
    allowed.metadata = patch.metadata;
  }
  try {
    accountRegistry.upsertAccount(req.params.id, allowed);
    accountRegistry.flush();
    res.json({ account: composeAccount(req.params.id) });
  } catch (err) {
    logger.error('accounts update error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Delete ──────────────────────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  if (!isValidSlug(req.params.id)) {
    return res.status(400).json({ error: 'Invalid accountId' });
  }
  // Chặn xoá account còn đang logged_in.
  const status = sessionManager.getStatus(req.params.id);
  if (status && status.status === 'logged_in') {
    return res.status(409).json({ error: 'Hãy logout Zalo trước khi xoá tài khoản' });
  }
  const removed = accountRegistry.removeAccount(req.params.id);
  accountRegistry.flush();
  res.json({ removed });
});

export default router;
