"use client";

/**
 * Client dashboard cho /zalo/accounts.
 *
 * Hiển thị:
 *   - Sidebar: danh sách nhân viên + button "Thêm nhân viên" (admin only).
 *   - Main panel: danh sách Zalo account + nút CRUD + assign.
 *   - Modal assign: chọn nhân viên + toggle can_view/can_send/can_broadcast.
 *   - Banner đổi user hiện tại (debug): chọn staff để "login as".
 */

import {
  AlertTriangle,
  Check,
  Loader2,
  Plus,
  RefreshCw,
  Shield,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { zaloAccountsApi, zaloStaffApi } from "@/lib/zalo-api";

type Staff = {
  id: string;
  email: string;
  full_name: string;
  role: "admin" | "staff";
  is_active: boolean;
};

type Assignment = {
  staff_id: string;
  account_id: string;
  can_view: boolean;
  can_send: boolean;
  can_broadcast: boolean;
};

type ZaloAccount = {
  account_id: string;
  display_name: string;
  status: string;
  zalo_user_id?: string | null;
  zalo_display_name?: string | null;
  owner_staff_id?: string | null;
  last_seen_at?: string | null;
  last_error?: string | null;
};

type InitialData = {
  staff: Staff | null;
  accounts: ZaloAccount[];
  staffList: Staff[];
  assignments: Assignment[];
  role?: "admin" | "staff" | "system";
};

function statusBadge(status: string) {
  switch (status) {
    case "connected":
      return { label: "Đã kết nối", cls: "bg-emerald-50 text-emerald-700" };
    case "waiting_qr":
      return { label: "Chờ QR", cls: "bg-blue-50 text-blue-700" };
    case "error":
      return { label: "Lỗi", cls: "bg-red-50 text-red-700" };
    default:
      return { label: "Chưa kết nối", cls: "bg-slate-100 text-slate-600" };
  }
}

export default function ZaloAccountsDashboard({
  initialData
}: {
  initialData: InitialData;
}) {
  const role = initialData.role || "system";
  const isAdmin = role === "admin";

  const [accounts, setAccounts] = useState<ZaloAccount[]>(initialData.accounts);
  const [staffList, setStaffList] = useState<Staff[]>(initialData.staffList);
  const [assignments, setAssignments] = useState<Assignment[]>(initialData.assignments);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Modal: tạo account
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ accountId: "", displayName: "" });
  const [creating, setCreating] = useState(false);

  // Modal: tạo staff
  const [showCreateStaff, setShowCreateStaff] = useState(false);
  const [staffForm, setStaffForm] = useState({ email: "", full_name: "", role: "staff" });
  const [creatingStaff, setCreatingStaff] = useState(false);

  // Modal: assign cho account X
  const [assignAccountId, setAssignAccountId] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const [acc, st] = await Promise.all([
        zaloAccountsApi.list(),
        zaloStaffApi.list()
      ]);
      setAccounts(acc.accounts || []);
      setStaffList(st.staff || []);
      setAssignments(st.assignments || []);
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Lỗi tải dữ liệu.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Initial pull — nếu SSR data trống thì gọi lại.
    if (accounts.length === 0 && staffList.length === 0) void refresh();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleCreate() {
    if (!createForm.accountId.trim()) return;
    setCreating(true);
    try {
      await zaloAccountsApi.create({
        accountId: createForm.accountId.trim(),
        displayName: createForm.displayName.trim() || createForm.accountId.trim()
      });
      setShowCreate(false);
      setCreateForm({ accountId: "", displayName: "" });
      setNotice("Đã tạo tài khoản. Mở trang connect để quét QR.");
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("zalo-account-changed"));
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi tạo tài khoản.");
    } finally {
      setCreating(false);
    }
  }

  async function handleCreateStaff() {
    if (!staffForm.email.trim() || !staffForm.full_name.trim()) return;
    setCreatingStaff(true);
    try {
      await zaloStaffApi.upsert({
        email: staffForm.email.trim(),
        full_name: staffForm.full_name.trim(),
        role: staffForm.role === "admin" ? "admin" : "staff"
      });
      setShowCreateStaff(false);
      setStaffForm({ email: "", full_name: "", role: "staff" });
      setNotice("Đã tạo nhân viên.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi tạo nhân viên.");
    } finally {
      setCreatingStaff(false);
    }
  }

  async function handleAssign(staffId: string, accountId: string, flags: { can_view: boolean; can_send: boolean; can_broadcast: boolean }) {
    try {
      await zaloStaffApi.assign(staffId, { account_id: accountId, ...flags });
      setNotice("Đã gán quyền.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi gán quyền.");
    }
  }

  async function handleUnassign(staffId: string, accountId: string) {
    try {
      await zaloStaffApi.unassign(staffId, accountId);
      setNotice("Đã thu hồi quyền.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi thu hồi quyền.");
    }
  }

  async function handleResetPassword(s: Staff) {
    if (!confirm(`Đặt lại mật khẩu cho "${s.full_name}"?\n\nLần đăng nhập kế tiếp của họ sẽ set mật khẩu mới.`)) return;
    try {
      const res = await fetch(`/api/zalo/staff/${s.id}/reset-password`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Lỗi đặt lại mật khẩu.");
      setNotice(`Đã đặt lại mật khẩu cho "${s.full_name}".`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi đặt lại mật khẩu.");
    }
  }

  async function handleDelete(accountId: string) {
    if (!confirm(`Xoá tài khoản "${accountId}" khỏi registry?\n\nFile cookies vẫn được giữ — chỉ xoá metadata.`)) return;
    try {
      await zaloAccountsApi.remove(accountId);
      setNotice("Đã xoá.");
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("zalo-account-changed"));
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi xoá tài khoản.");
    }
  }

  const accountsByStaff = useMemo(() => {
    const map = new Map<string, Assignment[]>();
    for (const a of assignments) {
      const list = map.get(a.staff_id) ?? [];
      list.push(a);
      map.set(a.staff_id, list);
    }
    return map;
  }, [assignments]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      {/* Header */}
      <header className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Quản lý tài khoản Zalo</h1>
          <p className="text-xs text-slate-500">
            Theo dõi trạng thái các tài khoản Zalo đang kết nối và phân quyền nhân viên.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              isAdmin
                ? "bg-emerald-50 text-emerald-700"
                : "bg-blue-50 text-blue-700"
            }`}
            title={
              isAdmin
                ? "Bạn đang đăng nhập với quyền admin"
                : "Bạn đang đăng nhập với quyền staff"
            }
          >
            {isAdmin ? <ShieldCheck className="h-3 w-3" /> : <Shield className="h-3 w-3" />}
            {isAdmin ? "Admin" : "Staff"}
          </span>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Làm mới
          </button>
        </div>
      </header>

      {/* Toasts */}
      {notice ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          {notice}
          <button type="button" onClick={() => setNotice(null)} className="ml-2 underline">Đóng</button>
        </div>
      ) : null}
      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
          <button type="button" onClick={() => setError(null)} className="ml-2 underline">Đóng</button>
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
        {/* Staff sidebar */}
        <aside className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="inline-flex items-center gap-1 text-xs font-bold uppercase text-slate-500">
              <Users className="h-3.5 w-3.5" />
              Nhân viên
            </h2>
            {isAdmin ? (
              <button
                type="button"
                onClick={() => setShowCreateStaff(true)}
                className="inline-flex items-center gap-1 rounded text-[11px] font-semibold text-primary hover:underline"
              >
                <Plus className="h-3 w-3" />
                Thêm
              </button>
            ) : null}
          </div>
          <div className="space-y-1">
            {staffList.length === 0 ? (
              <p className="text-xs text-slate-500">Chưa có nhân viên nào.</p>
            ) : (
              staffList.map((s) => {
                const assigned = accountsByStaff.get(s.id) || [];
                return (
                  <div
                    key={s.id}
                    className={`rounded-md border px-2 py-1.5 text-xs ${
                      initialData.staff?.id === s.id
                        ? "border-primary/40 bg-primary/5"
                        : "border-slate-200 bg-white"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold text-slate-900" title={s.full_name}>
                          {s.full_name}
                        </div>
                        <div className="truncate text-[10.5px] text-slate-500" title={s.email}>
                          {s.email}
                        </div>
                      </div>
                      <span
                        className={`ml-1 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                          s.role === "admin" ? "bg-emerald-50 text-emerald-700" : "bg-blue-50 text-blue-700"
                        }`}
                      >
                        {s.role === "admin" ? "Admin" : "Staff"}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-1 text-[10.5px] text-slate-500">
                      <span>{assigned.length > 0 ? `${assigned.length} TK Zalo` : "Chưa được gán TK"}</span>
                      {isAdmin ? (
                        <button
                          type="button"
                          onClick={() => void handleResetPassword(s)}
                          className="shrink-0 text-primary hover:underline"
                        >
                          Đặt lại mật khẩu
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </div>
          {!isAdmin ? (
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-700">
              <AlertTriangle className="mr-1 inline h-3 w-3" />
              Bạn đang xem với quyền staff. Liên hệ admin để được gán thêm tài khoản.
            </div>
          ) : null}
        </aside>

        {/* Accounts list */}
        <section className="rounded-lg border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
            <h2 className="text-sm font-bold text-slate-800">
              Tài khoản Zalo {accounts.length > 0 ? `(${accounts.length})` : ""}
            </h2>
            {isAdmin ? (
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
              >
                <Plus className="h-3.5 w-3.5" />
                Thêm tài khoản
              </button>
            ) : null}
          </div>
          <div className="divide-y divide-slate-100">
            {accounts.length === 0 ? (
              <div className="px-6 py-12 text-center text-sm text-slate-500">
                Chưa có tài khoản Zalo nào.
              </div>
            ) : (
              accounts.map((acc) => {
                const a = statusBadge(acc.status);
                return (
                  <div key={acc.account_id} className="px-4 py-3 hover:bg-slate-50/60">
                    <div className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-semibold text-slate-900" title={acc.display_name}>
                            {acc.display_name}
                          </span>
                          <span
                            className={`inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${a.cls}`}
                          >
                            {a.label}
                          </span>
                          <span className="font-mono text-[10px] text-slate-400">{acc.account_id}</span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-slate-500">
                          {acc.zalo_display_name ? `Tên Zalo: ${acc.zalo_display_name}` : "Chưa đăng nhập Zalo"}
                          {acc.last_seen_at ? ` · lần cuối: ${new Date(acc.last_seen_at).toLocaleString("vi-VN")}` : ""}
                        </div>
                        {acc.last_error ? (
                          <div className="mt-0.5 truncate text-[11px] text-red-600" title={acc.last_error}>
                            {acc.last_error}
                          </div>
                        ) : null}
                      </div>
                      {isAdmin ? (
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setAssignAccountId(acc.account_id)}
                            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                          >
                            <UserPlus className="h-3 w-3" />
                            Gán nhân viên
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDelete(acc.account_id)}
                            className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-50"
                            title="Xoá khỏi registry (giữ file cookies)"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>
      </div>

      {/* Modal: Create account */}
      {showCreate ? (
        <div className="fixed inset-0 z-[170] grid place-items-center bg-slate-950/50 px-4 backdrop-blur-sm">
          <button
            type="button"
            className="absolute inset-0"
            aria-label="Đóng"
            onClick={() => setShowCreate(false)}
          />
          <div className="relative w-full max-w-md rounded-xl border bg-white p-5 shadow-2xl">
            <div className="mb-3 text-base font-semibold">Tạo tài khoản Zalo</div>
            <div className="space-y-2">
              <input
                type="text"
                placeholder="accountId (vd: shop-owner, leads-01)"
                value={createForm.accountId}
                onChange={(e) => setCreateForm((f) => ({ ...f, accountId: e.target.value }))}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono focus:border-primary focus:outline-none"
              />
              <input
                type="text"
                placeholder="Tên hiển thị (vd: Shop chính)"
                value={createForm.displayName}
                onChange={(e) => setCreateForm((f) => ({ ...f, displayName: e.target.value }))}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-primary focus:outline-none"
              />
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="rounded-md border bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={() => void handleCreate()}
                disabled={creating || !createForm.accountId.trim()}
                className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                Tạo
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Modal: Create staff */}
      {showCreateStaff ? (
        <div className="fixed inset-0 z-[170] grid place-items-center bg-slate-950/50 px-4 backdrop-blur-sm">
          <button
            type="button"
            className="absolute inset-0"
            aria-label="Đóng"
            onClick={() => setShowCreateStaff(false)}
          />
          <div className="relative w-full max-w-md rounded-xl border bg-white p-5 shadow-2xl">
            <div className="mb-3 text-base font-semibold">Thêm nhân viên</div>
            <div className="space-y-2">
              <input
                type="email"
                placeholder="Email (vd: binh@congty.com)"
                value={staffForm.email}
                onChange={(e) => setStaffForm((f) => ({ ...f, email: e.target.value }))}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-primary focus:outline-none"
              />
              <input
                type="text"
                placeholder="Họ tên"
                value={staffForm.full_name}
                onChange={(e) => setStaffForm((f) => ({ ...f, full_name: e.target.value }))}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-primary focus:outline-none"
              />
              <select
                value={staffForm.role}
                onChange={(e) => setStaffForm((f) => ({ ...f, role: e.target.value }))}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-primary focus:outline-none"
              >
                <option value="staff">Staff</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCreateStaff(false)}
                className="rounded-md border bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={() => void handleCreateStaff()}
                disabled={creatingStaff || !staffForm.email.trim() || !staffForm.full_name.trim()}
                className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {creatingStaff ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                Tạo
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Modal: Assign staff */}
      {assignAccountId ? (
        <AssignModal
          accountId={assignAccountId}
          accountName={accounts.find((a) => a.account_id === assignAccountId)?.display_name || assignAccountId}
          staffList={staffList.filter((s) => s.role !== "admin")}
          assignments={assignments.filter((a) => a.account_id === assignAccountId)}
          onClose={() => setAssignAccountId(null)}
          onAssign={handleAssign}
          onUnassign={handleUnassign}
        />
      ) : null}
    </div>
  );
}

function AssignModal({
  accountId,
  accountName,
  staffList,
  assignments,
  onClose,
  onAssign,
  onUnassign
}: {
  accountId: string;
  accountName: string;
  staffList: Staff[];
  assignments: Assignment[];
  onClose: () => void;
  onAssign: (staffId: string, accountId: string, flags: { can_view: boolean; can_send: boolean; can_broadcast: boolean }) => Promise<void>;
  onUnassign: (staffId: string, accountId: string) => Promise<void>;
}) {
  const [flagsByStaff, setFlagsByStaff] = useState<
    Record<string, { can_view: boolean; can_send: boolean; can_broadcast: boolean }>
  >(() => {
    const out: Record<string, { can_view: boolean; can_send: boolean; can_broadcast: boolean }> = {};
    for (const s of staffList) {
      const a = assignments.find((x) => x.staff_id === s.id);
      out[s.id] = a
        ? { can_view: a.can_view, can_send: a.can_send, can_broadcast: a.can_broadcast }
        : { can_view: true, can_send: true, can_broadcast: false };
    }
    return out;
  });

  return (
    <div className="fixed inset-0 z-[170] grid place-items-center bg-slate-950/50 px-4 backdrop-blur-sm">
      <button type="button" className="absolute inset-0" aria-label="Đóng" onClick={onClose} />
      <div className="relative w-full max-w-lg rounded-xl border bg-white p-5 shadow-2xl">
        <div className="mb-3">
          <div className="text-base font-semibold">Gán nhân viên vào "{accountName}"</div>
          <div className="mt-0.5 text-xs text-slate-500">
            accountId: <span className="font-mono">{accountId}</span>
          </div>
        </div>
        <div className="max-h-72 space-y-1 overflow-auto rounded-md border border-slate-200">
          {staffList.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-slate-500">
              Chưa có staff nào (admin có thể xem tất cả account mà không cần assign).
            </div>
          ) : (
            staffList.map((s) => {
              const assigned = assignments.some((x) => x.staff_id === s.id);
              const flags = flagsByStaff[s.id];
              return (
                <div key={s.id} className="border-b border-slate-100 px-3 py-2 last:border-b-0">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-semibold text-slate-900">{s.full_name}</div>
                      <div className="truncate text-[10.5px] text-slate-500">{s.email}</div>
                    </div>
                    {assigned ? (
                      <button
                        type="button"
                        onClick={() => void onUnassign(s.id, accountId)}
                        className="rounded-md border border-red-200 bg-white px-2 py-1 text-[10.5px] font-semibold text-red-700 hover:bg-red-50"
                      >
                        Thu hồi
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void onAssign(s.id, accountId, flags)}
                        className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[10.5px] font-semibold text-white hover:opacity-90"
                      >
                        <Plus className="h-3 w-3" />
                        Gán
                      </button>
                    )}
                  </div>
                  {!assigned ? (
                    <div className="mt-1 flex items-center gap-2 text-[10.5px]">
                      {(["can_view", "can_send", "can_broadcast"] as const).map((k) => (
                        <label key={k} className="inline-flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={flags[k]}
                            onChange={(e) =>
                              setFlagsByStaff((m) => ({
                                ...m,
                                [s.id]: { ...flags, [k]: e.target.checked }
                              }))
                            }
                          />
                          {k === "can_view"
                            ? "Xem"
                            : k === "can_send"
                              ? "Gửi"
                              : "Broadcast"}
                        </label>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}