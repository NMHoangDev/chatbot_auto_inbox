/**
 * /status routes - thông tin hệ thống và quản lý sessions
 *
 * GET /status/sessions       - Danh sách tất cả sessions
 * GET /status/sessions/:id   - Chi tiết 1 session
 */

import { Router } from 'express';
import { sessionManager } from '../services/sessionManager.js';

const router = Router();

router.get('/sessions', (_, res) => {
  res.json({ sessions: sessionManager.listSessions() });
});

router.get('/sessions/:accountId', (req, res) => {
  const status = sessionManager.getStatus(req.params.accountId);
  if (!status) return res.status(404).json({ error: 'Not found' });
  res.json(status);
});

export default router;
