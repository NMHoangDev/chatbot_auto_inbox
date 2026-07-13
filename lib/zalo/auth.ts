/**
 * lib/zalo/auth.ts — session/auth helpers cho Zalo multi-account (Phase 3).
 *
 * Hiện tại InvoiceFlow không có login page. Để phân biệt user (admin vs staff)
 * mà không phá vỡ UX, dùng cơ chế:
 *
 *   1) `current_staff_id` cookie (HttpOnly false) — set bởi /zalo/accounts page.
 *      Mặc định khi không có cookie → "system" (id = null, role = admin để
 *      backward compat với code cũ).
 *   2) Hoặc `x-staff-id` header — cho testing / extension tự xác định.
 *
 * Helper:
 *   getCurrentStaff(req)        → { id, email, full_name, role, assignments[] }
 *   requireAdmin(req)           → throws 403 nếu role != admin
 *   canViewAccount(staff, id)   → true nếu admin hoặc staff assigned
 *   canSendToAccount(staff, id)
 *   canBroadcastTo(staff, id)
 */

import { NextRequest } from "next/server";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  "";

let _adminCache: { id: string | null; email: string | null; full_name: string | null } | null = null;

async function loadAdmin(): Promise<{ id: string | null; email: string | null; full_name: string | null }> {
  if (_adminCache) return _adminCache;
  if (!SUPABASE_URL || !KEY) {
    _adminCache = { id: null, email: null, full_name: null };
    return _adminCache;
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/staff?role=eq.admin&limit=1`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
      cache: "no-store"
    });
    if (!res.ok) throw new Error(`supabase ${res.status}`);
    const rows = (await res.json()) as Array<{ id: string; email: string; full_name: string }>;
    if (rows.length > 0) {
      _adminCache = { id: rows[0].id, email: rows[0].email, full_name: rows[0].full_name };
      return _adminCache;
    }
  } catch {
    /* fallback */
  }
  _adminCache = { id: null, email: null, full_name: null };
  return _adminCache;
}

export type StaffSession = {
  id: string | null;
  email: string;
  full_name: string;
  role: "admin" | "staff" | "system";
  assignments: Array<{ account_id: string; can_view: boolean; can_send: boolean; can_broadcast: boolean }>;
};

/**
 * Đọc staff session từ request.
 *
 * Bản demo này KHÔNG có hệ thống login nhân viên (xem README) — mọi request
 * luôn chạy dưới quyền system admin, bất kể cookie/header nào có mặt. Đây là
 * chủ đích: bỏ qua `current_staff_id` cũng tránh 1 lớp bug thực tế — cookie
 * này không có `Domain`/port cụ thể nên trình duyệt vẫn gửi kèm cho
 * localhost:3000 nếu trước đó bạn từng mở app InvoiceFlowManager gốc (khác
 * port) trên cùng máy, khiến request bị nhận diện nhầm thành 1 nhân viên
 * "staff" thật (không đủ quyền) thay vì admin, gây lỗi Forbidden giả.
 */
export async function getCurrentStaff(_req: NextRequest): Promise<StaffSession> {
  const admin = await loadAdmin();
  return {
    id: admin.id,
    email: admin.email || "system@local",
    full_name: admin.full_name || "System",
    role: "admin",
    assignments: [] // admin không cần explicit assignment
  };
}

/**
 * Phiên bản strict: nếu KHÔNG có cookie/header → trả null thay vì fallback.
 * Caller dùng cho UI quan trọng cần biết rõ "user đã login hay chưa".
 */
export async function getCurrentStaffStrict(req: NextRequest): Promise<StaffSession | null> {
  const headerId = req.headers.get("x-staff-id") || null;
  const cookieId = req.cookies.get("current_staff_id")?.value || null;
  const staffId = cookieId || headerId;
  if (!staffId) return null;
  const staff = await getCurrentStaff(req);
  return staff.id ? staff : null;
}

/**
 * Yêu cầu quyền admin. Trả null nếu OK; trả NextResponse nếu 403.
 * Caller check: const guard = await requireAdmin(req); if (guard) return guard;
 */
export async function requireAdmin(req: NextRequest) {
  const staff = await getCurrentStaff(req);
  if (staff.role !== "admin") {
    return {
      error: Response.json({ error: "Admin only" }, { status: 403 })
    };
  }
  return { staff };
}

export function canViewAccount(staff: StaffSession, accountId: string): boolean {
  if (staff.role === "admin") return true;
  return staff.assignments.some((a) => a.account_id === accountId && a.can_view);
}

export function canSendToAccount(staff: StaffSession, accountId: string): boolean {
  if (staff.role === "admin") return true;
  return staff.assignments.some((a) => a.account_id === accountId && a.can_send);
}

export function canBroadcastTo(staff: StaffSession, accountId: string): boolean {
  if (staff.role === "admin") return true;
  return staff.assignments.some((a) => a.account_id === accountId && a.can_broadcast);
}

/** Cookie options khi set current_staff_id. */
export const STAFF_COOKIE_NAME = "current_staff_id";
export const STAFF_COOKIE_OPTS = {
  path: "/",
  sameSite: "lax" as const,
  httpOnly: false,
  maxAge: 60 * 60 * 24 * 30 // 30 ngày
};