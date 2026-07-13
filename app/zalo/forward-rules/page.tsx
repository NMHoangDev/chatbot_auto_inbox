/**
 * Trang cấu hình "Nhóm chính" auto-forward: tin nhắn gửi trong 1 nhóm Zalo
 * được chọn làm nhóm chính sẽ tự động chuyển tiếp sang các nhóm đích khác.
 *
 * Demo này không có hệ thống login nhân viên (xem README + lib/zalo/auth.ts)
 * — luôn coi mọi người dùng là admin nên luôn hiển thị đủ nút tạo/sửa/xoá.
 * Enforcement thực sự (nếu sau này thêm login) vẫn nằm ở API route
 * (app/api/zalo/forward-rules), không phải ở đây.
 */

import ZaloForwardRulesDashboard from "@/components/zalo/ZaloForwardRulesDashboard";

export const dynamic = "force-dynamic";

export default function ZaloForwardRulesPage() {
  return <ZaloForwardRulesDashboard role="admin" />;
}
