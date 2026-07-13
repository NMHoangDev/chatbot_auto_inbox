/**
 * chatwootService.js — stub.
 *
 * Bản gốc (InvoiceFlowManager) đồng bộ 2 chiều với Chatwoot. Demo này không
 * dùng Chatwoot nên module được thay bằng no-op stub giữ NGUYÊN tên hàm export
 * mà sessionManager.js / webhook (đã bỏ) / forwardEngine.js gọi tới — nhờ vậy
 * sessionManager.js (nơi forwardEngine.js móc vào qua listener 'message') được
 * copy y nguyên từ bản gốc, không cần sửa tay phần lõi nhận tin nhắn.
 *
 * isChatwootEnabled luôn false → mọi lời gọi bên dưới chỉ log debug rồi trả
 * về ngay, không gọi mạng/DB nào.
 */

import { logger } from '../utils/logger.js';

export const isChatwootEnabled = false;

function noop(name) {
  return async (...args) => {
    logger.debug(`[chatwoot-stub] ${name} called (Chatwoot disabled, no-op)`);
    return null;
  };
}

export const chatwootService = {
  handleIncomingMessage: noop('handleIncomingMessage'),
  handleIncomingUndo: noop('handleIncomingUndo'),
  handleIncomingTyping: noop('handleIncomingTyping'),
  handleIncomingGroupEvent: noop('handleIncomingGroupEvent'),
  getMessages: async () => [],
  getOrCreateConversationForZaloUser: noop('getOrCreateConversationForZaloUser'),
  sendToZalo: noop('sendToZalo'),
  updateConversationStatus: noop('updateConversationStatus'),
  syncAllZaloContacts: noop('syncAllZaloContacts'),
  updateAllConversationsStatus: noop('updateAllConversationsStatus'),
  updateMessageExternalId: noop('updateMessageExternalId'),
  getMessageSourceIdFromDb: async () => null,
  clearActiveConversations: () => {},
};
