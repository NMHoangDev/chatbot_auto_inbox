/**
 * Trang quản lý tài khoản Zalo: danh sách, tạo mới, gán nhân viên.
 *
 * Demo này không có hệ thống login nhân viên (xem README + lib/zalo/auth.ts)
 * — luôn coi mọi người dùng là admin, không lọc theo cookie/staff nữa.
 */

import { createClient } from "@supabase/supabase-js";
import ZaloAccountsDashboard from "@/components/zalo/ZaloAccountsDashboard";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  "";

async function loadInitialData() {
  if (!SUPABASE_URL || !KEY) {
    return { staff: null, accounts: [], staffList: [], assignments: [], role: "admin" as const };
  }
  const sb = createClient(SUPABASE_URL, KEY, { auth: { persistSession: false } });

  const [accountsRes, staffListRes, assignmentsRes] = await Promise.all([
    sb.from("zalo_accounts").select("*").order("created_at"),
    sb.from("staff").select("*").order("created_at"),
    sb.from("staff_zalo_assignments").select("*")
  ]);

  return {
    staff: null,
    accounts: accountsRes.data || [],
    staffList: staffListRes.data || [],
    assignments: assignmentsRes.data || [],
    role: "admin" as const
  };
}

export const dynamic = "force-dynamic";

export default async function ZaloAccountsPage() {
  const data = await loadInitialData();
  return <ZaloAccountsDashboard initialData={data} />;
}
