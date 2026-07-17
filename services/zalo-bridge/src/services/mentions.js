/**
 * mentions.js
 *
 * Helper dùng chung cho tag/@mention Zalo — được cả route gửi tin thủ công
 * (`routes/zalo-client.js`) và forward engine (`forwardEngine.js`) dùng, để
 * "@all" luôn tự tag toàn bộ thành viên nhóm dù gửi trực tiếp hay qua forward.
 */

// ── "@all": tag toàn bộ thành viên nhóm ─────────────────────────────────────
// Zalo có sẵn 1 cơ chế mention-all ở tầng protocol: 1 mention entry với uid
// đặc biệt "-1" khiến server tự fan-out thông báo tới MỌI thành viên nhóm,
// không cần biết trước danh sách member (xem zca-js
// apis/sendMessage.js#handleMentions: `type: m.uid == "-1" ? 1 : 0`). Chỉ có
// hiệu lực khi gửi vào group — zca-js tự bỏ qua mentions nếu là thread user.
export function buildAllMentions(text) {
  const match = /@all\b/i.exec(text || '');
  if (!match) return undefined;
  return [{ pos: match.index, len: match[0].length, uid: '-1' }];
}
