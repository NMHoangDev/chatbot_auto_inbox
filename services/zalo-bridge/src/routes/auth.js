/**
 * /auth routes
 *
 * POST /auth/qr-login        - Bắt đầu login QR (trả về accountId)
 * GET  /auth/qr-image/:id   - Lấy ảnh QR PNG (public, không cần auth)
 * GET  /auth/status/:id     - Kiểm tra trạng thái đăng nhập
 * POST /auth/cookie-login    - Login bằng cookie từ extension
 * DELETE /auth/logout/:id   - Đăng xuất
 */

import { Router } from 'express';
import { sessionManager } from '../services/sessionManager.js';
import { chatwootService } from '../services/chatwootService.js';
import { logger } from '../utils/logger.js';

const router = Router();

// ── Start QR login ────────────────────────────────────────────────────────────
router.post('/qr-login', async (req, res) => {
  try {
    const { accountId, inboxId } = req.body;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });
    if (!inboxId) return res.status(400).json({ error: 'inboxId required' });

    const result = await sessionManager.startQrLogin(accountId, inboxId);
    res.json({ ...result, accountId, inboxId, qrImageUrl: `/auth/qr-image/${accountId}` });
  } catch (err) {
    logger.error('qr-login error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Get QR image ──────────────────────────────────────────────────────────────
router.get('/qr-image/:accountId', async (req, res) => {
  const { accountId } = req.params;

  // Poll for up to 15s for QR to generate
  let tries = 0;
  while (tries < 30) {
    const buf = sessionManager.getQrImage(accountId);
    if (buf) {
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'no-cache');
      return res.send(buf);
    }
    await new Promise(r => setTimeout(r, 500));
    tries++;
  }
  res.status(404).json({ error: 'QR not ready yet, retry in a moment' });
});

// ── Status ────────────────────────────────────────────────────────────────────
router.get('/status/:accountId', (req, res) => {
  const status = sessionManager.getStatus(req.params.accountId);
  if (!status) return res.status(404).json({ error: 'Session not found' });
  res.json(status);
});

// ── Session check (used by ZaloConnectPage.vue in Chatwoot) ──────────────────
// Returns connected=true/false so Vue can show status without needing admin.
// NOTE: Returns cached session state immediately (no Zalo API call) to avoid blocking UI.
router.get('/session/:accountId', (req, res) => {
  const accountId = req.params.accountId;
  const queryChatwootAccountId = req.query.chatwootAccountId || req.query.chatwoot_account_id;
  if (queryChatwootAccountId) {
    sessionManager.setChatwootAccountId(accountId, queryChatwootAccountId);
  }
  const session = sessionManager.getSession(accountId);
  if (!session) {
    return res.json({ connected: false, accountId });
  }

  const isConnected = session.status === 'logged_in' && (session.isWsConnected !== false);

  res.json({
    connected: isConnected,
    accountId,
    chatwootAccountId: session.chatwootAccountId || queryChatwootAccountId || '',
    zaloId: session.zaloId,
    displayName: session.displayName || '',
    inboxId: session.inboxId,
    status: session.status,
    isWsConnected: session.isWsConnected || false,
  });
});

// ── Cookie login (from extension-login-zalo) ──────────────────────────────────
router.post('/cookie-login', async (req, res) => {
  try {
    const { accountId, inboxId, imei, cookie, userAgent, chatwootAccountId, chatwoot_account_id } = req.body;
    if (!accountId || !inboxId || !cookie) {
      return res.status(400).json({ error: 'accountId, inboxId and cookie required' });
    }

    // KHÔNG gate theo required cookies ở đây nữa — zca-js tự quyết định phiên
    // hợp lệ dựa trên bất kỳ cookie Zalo nào được cung cấp.
    const result = await sessionManager.loginWithCookies(accountId, inboxId, {
      imei,
      cookie,
      userAgent,
      chatwootAccountId: chatwootAccountId || chatwoot_account_id,
    });
    res.json(result);
  } catch (err) {
    logger.error('cookie-login error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Set / update inboxId for an existing session ──────────────────────────────
router.post('/set-inbox', async (req, res) => {
  try {
    const { accountId, inboxId } = req.body;
    if (!accountId || !inboxId) return res.status(400).json({ error: 'accountId and inboxId required' });
    const ok = sessionManager.setInboxId(accountId, Number(inboxId));
    if (!ok) return res.status(404).json({ error: 'Session not found' });
    res.json({ success: true, accountId, inboxId: Number(inboxId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Force sync Zalo contacts ──────────────────────────────────────────────────
router.post('/sync-contacts', async (req, res) => {
  try {
    const { accountId, chatwootAccountId, chatwoot_account_id, fullSync = false } = req.body;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });
    const api = sessionManager.getApi(accountId);
    const status = sessionManager.getStatus(accountId);
    if (!api || !status || status.status !== 'logged_in') {
      return res.status(400).json({ error: 'Zalo account is not logged in or active' });
    }
    const inboxId = status.inboxId;
    if (!inboxId) {
      return res.status(400).json({ error: 'No Inbox ID assigned to this Zalo account' });
    }

    const cwAccountId = chatwootAccountId || chatwoot_account_id || sessionManager.getChatwootAccountId(accountId) || accountId;
    sessionManager.setChatwootAccountId(accountId, cwAccountId);

    // Prioritize messages. Full contact/group sync can be very slow on personal
    // Zalo accounts with hundreds of friends/groups, and it should not block
    // realtime chat delivery.
    await sessionManager.syncMissedMessages(accountId, api, inboxId, 0);

    if (fullSync === true || fullSync === 'true') {
      await chatwootService.syncAllZaloContacts(cwAccountId, api, inboxId);
    }

    res.json({
      success: true,
      mode: fullSync === true || fullSync === 'true' ? 'full' : 'messages',
      message: 'Synchronization completed successfully',
    });
  } catch (err) {
    logger.error('sync-contacts error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Logout ────────────────────────────────────────────────────────────────────
router.delete('/logout/:accountId', async (req, res) => {
  try {
    await sessionManager.destroySession(req.params.accountId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
