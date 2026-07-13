/**
 * /api routes — endpoint called by extension-login-zalo
 *
 * POST /api/all-platform/zalo/auth/import-session
 *   Body (from extension): { account_id, chatwoot_account_id, user_id, owner_id, cookies, user_agent, imei }
 *   Convention: owner_id carries the Chatwoot inbox_id when triggered from /connect page
 *
 * Lưu ý: KHÔNG validate cookie theo key ở đây nữa. Extension thường chỉ lấy
 * được cookie web (zpsid / zpw_sek), các cookie API (zppsid / zppwsid / zphpsid)
 * sẽ được zca-js tự refresh trong lần gọi API đầu tiên. Cứ forward toàn bộ
 * cookies sang zca-js.login() — nó sẽ quyết định phiên hợp lệ hay không.
 */

import { Router } from 'express';
import { sessionManager } from '../services/sessionManager.js';
import { logger } from '../utils/logger.js';

const router = Router();

router.post('/all-platform/zalo/auth/import-session', async (req, res) => {
  try {
    const body = req.body;

    const accountId = String(body.account_id || body.accountId || 'default').trim() || 'default';
    const chatwootAccountId = String(
      body.chatwoot_account_id ||
      body.chatwootAccountId ||
      body.cw_account_id ||
      body.cwAccountId ||
      ''
    ).trim();

    // inboxId is passed via owner_id field (our convention with the extension)
    const inboxId = body.inbox_id || body.inboxId || body.owner_id || null;

    // Chấp nhận cả mảng cookies (chuẩn mới) lẫn chuỗi cookie cũ (fallback).
    let cookies = body.cookies || body.cookie || [];
    if (typeof cookies === 'string') {
      try {
        const parsed = JSON.parse(cookies);
        if (Array.isArray(parsed)) cookies = parsed;
      } catch (_) {
        // Không parse được thì bỏ — zca-js sẽ báo lỗi rõ ràng hơn.
      }
    }

    const userAgent = body.user_agent || body.userAgent || '';
    const imei = body.imei || '';

    if (!Array.isArray(cookies) || cookies.length === 0) {
      return res.status(400).json({ error: 'No cookies provided' });
    }

    const keys = cookies.map(c => String(c.key || c.name || '').toLowerCase()).filter(Boolean);

    logger.info('import-session payload details', {
      accountId,
      chatwootAccountId,
      inboxId,
      cookieCount: cookies.length,
      cookieKeys: keys,
      hasUserAgent: Boolean(userAgent),
      hasImei: Boolean(imei),
    });

    // Không reject khi thiếu cookie — chỉ log cảnh báo. zca-js sẽ tự quyết định.
    if (keys.length === 0) {
      return res.status(400).json({ error: 'Cookie entries have no key/name field' });
    }

    const result = await sessionManager.loginWithCookies(accountId, inboxId, {
      cookie: cookies,
      userAgent,
      imei,
      chatwootAccountId,
    });

    logger.info('Session imported via extension', { accountId, chatwootAccountId, inboxId, zaloId: result?.zaloId });

    res.json({
      success: true,
      accountId,
      chatwootAccountId,
      inboxId,
      zaloId: result?.zaloId,
      displayName: result?.displayName || '',
      message: 'Zalo session imported successfully',
      cookies_count: cookies.length,
    });
  } catch (err) {
    logger.error('Extension import-session failed', { err: err.message });
    res.status(500).json({ success: false, error: err.message || 'Import session failed' });
  }
});

export default router;
