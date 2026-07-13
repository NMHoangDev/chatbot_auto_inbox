"use client";

/**
 * ZaloAccountSwitcher
 * ─────────────────────────────────────────────────────────────────────────
 * Dropdown nằm header trang /thong-bao-zalo cho phép user chọn account Zalo
 * nào đang xem. Tự động poll `refreshZaloAccounts` mỗi 15s để cập nhật status
 * (connected/disconnected/error). Khi account đang chọn chuyển trạng thái
 * (vd logout từ extension) → toast cảnh báo.
 *
 * - Hiển thị TẤT CẢ account trong zaloAccounts (admin xem hết).
 *   Sau Phase 3, admin sẽ có nút "Thêm nhân viên" để filter staff.
 * - Nút "+ Thêm tài khoản" mở modal nhập slug + tên → POST /auth/accounts.
 * - Click vào item → setCurrentAccountId → useZalo hook refresh tất cả.
 *
 * Backward compat: nếu currentAccountId = "shop-owner" (giá trị legacy), vẫn
 * hiển thị + không gây lỗi nếu account đó chưa có trong registry.
 */

import { Loader2, Plus, RefreshCw, Users2, X, Check, AlertTriangle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { zaloAccountsApi, type ZaloAccountSummary } from "@/lib/zalo-api";
import { useApp } from "@/components/providers/AppProvider";

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

function statusDot(status: string) {
  const color =
    status === "connected"
      ? "bg-emerald-500"
      : status === "waiting_qr"
        ? "bg-blue-500"
        : status === "error"
          ? "bg-red-500"
          : "bg-slate-400";
  return (
    <span className="relative inline-flex items-center">
      <span className={`absolute inline-flex h-2.5 w-2.5 animate-ping rounded-full opacity-60 ${color}`} />
      <span className={`relative inline-flex h-2 w-2 rounded-full ${color}`} />
    </span>
  );
}

export default function ZaloAccountSwitcher() {
  const {
    zaloAccounts,
    currentAccountId,
    setCurrentAccountId,
    refreshZaloAccounts,
    loadingZaloAccounts,
    setError,
    setNotice
  } = useApp();

  const [open, setOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ accountId: "", displayName: "" });
  const [creating, setCreating] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  const current = zaloAccounts.find((a) => a.account_id === currentAccountId);

  // Click outside đóng.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Tự refresh mỗi 15s để status sát thực tế (WS reconnect, logout...).
  useEffect(() => {
    const id = window.setInterval(() => {
      void refreshZaloAccounts().catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(id);
  }, [refreshZaloAccounts]);

  // PHASE 4: Lắng nghe SSE account_status_changed (qua useZalo dispatch event)
  // → refresh ngay lập tức, không đợi interval. Đảm bảo khi user login/logout
  // từ extension → badge đổi trong vòng 1s.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => {
      void refreshZaloAccounts();
    };
    window.addEventListener("zalo-account-status-changed", handler);
    window.addEventListener("zalo-account-changed", handler);
    return () => {
      window.removeEventListener("zalo-account-status-changed", handler);
      window.removeEventListener("zalo-account-changed", handler);
    };
  }, [refreshZaloAccounts]);

  function handlePick(id: string) {
    setCurrentAccountId(id);
    setOpen(false);
    setNotice(`Đã chuyển sang tài khoản "${zaloAccounts.find((a) => a.account_id === id)?.display_name || id}".`);
    // Bắn event để useZalo hook reload.
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("zalo-account-changed", { detail: { accountId: id } }));
    }
  }

  async function handleCreate() {
    const slug = createForm.accountId.trim();
    const name = createForm.displayName.trim();
    if (!slug) {
      setError("Vui lòng nhập accountId (slug không dấu, vd: shop-owner)");
      return;
    }
    setCreating(true);
    try {
      const res = await zaloAccountsApi.create({
        accountId: slug,
        displayName: name || slug
      });
      // Refresh registry + chọn luôn account mới.
      await refreshZaloAccounts();
      setCurrentAccountId(res.account.account_id);
      setNotice(`Đã tạo tài khoản "${res.account.display_name}". Mở trang connect để quét QR.`);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("zalo-account-changed", { detail: { accountId: res.account.account_id } }));
      }
      setShowCreate(false);
      setCreateForm({ accountId: "", displayName: "" });
      setOpen(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Không tạo được tài khoản.";
      setError(msg);
    } finally {
      setCreating(false);
    }
  }

  if (zaloAccounts.length === 0 && !loadingZaloAccounts) {
    return (
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
        Bridge chưa sẵn sàng.
        <button
          type="button"
          onClick={() => void refreshZaloAccounts()}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
      >
        {current ? (
          <>
            {statusDot(current.status)}
            <span className="truncate max-w-[12rem]">
              {current.display_name}
            </span>
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${statusBadge(current.status).cls}`}>
              {statusBadge(current.status).label}
            </span>
          </>
        ) : (
          <>
            <Users2 className="h-4 w-4 text-slate-400" />
            <span>Chọn tài khoản Zalo</span>
          </>
        )}
        <RefreshCw
          className={`h-3 w-3 ${loadingZaloAccounts ? "animate-spin text-slate-400" : "text-slate-300"}`}
          onClick={(e) => {
            e.stopPropagation();
            void refreshZaloAccounts();
          }}
        />
      </button>

      {open ? (
        <div className="absolute right-0 z-40 mt-2 w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
          <div className="border-b border-slate-100 px-3 py-2 text-xs font-semibold uppercase text-slate-500">
            Tài khoản Zalo
          </div>
          <div className="max-h-72 overflow-auto py-1">
            {zaloAccounts.map((acc) => {
              const selected = acc.account_id === currentAccountId;
              return (
                <button
                  type="button"
                  key={acc.account_id}
                  onClick={() => handlePick(acc.account_id)}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50 ${
                    selected ? "bg-blue-50" : ""
                  }`}
                >
                  {statusDot(acc.status)}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold text-slate-900" title={acc.display_name}>
                      {acc.display_name}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      <span className="font-mono">{acc.account_id}</span>
                      {acc.zalo_display_name ? (
                        <>
                          {" · "}
                          {acc.zalo_display_name}
                        </>
                      ) : null}
                    </div>
                    {acc.last_error ? (
                      <div className="mt-0.5 text-[10px] text-red-600 line-clamp-1" title={acc.last_error}>
                        {acc.last_error}
                      </div>
                    ) : null}
                  </div>
                  {selected ? (
                    <Check className="h-4 w-4 shrink-0 text-primary" />
                  ) : null}
                </button>
              );
            })}
            {zaloAccounts.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-slate-500">
                Chưa có tài khoản Zalo nào. Bấm "+ Thêm" để tạo.
              </div>
            ) : null}
          </div>
          <div className="border-t border-slate-100 bg-slate-50/80 px-3 py-2">
            {showCreate ? (
              <div className="space-y-2">
                <input
                  type="text"
                  value={createForm.accountId}
                  onChange={(e) => setCreateForm((f) => ({ ...f, accountId: e.target.value }))}
                  placeholder="accountId (vd: leads-01)"
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 font-mono text-xs focus:border-primary focus:outline-none"
                />
                <input
                  type="text"
                  value={createForm.displayName}
                  onChange={(e) => setCreateForm((f) => ({ ...f, displayName: e.target.value }))}
                  placeholder="Tên hiển thị (vd: Lead Page 01)"
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs focus:border-primary focus:outline-none"
                />
                <div className="flex items-center justify-end gap-1">
                  <button
                    type="button"
                    onClick={() => setShowCreate(false)}
                    disabled={creating}
                    className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                  >
                    Hủy
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCreate()}
                    disabled={creating || !createForm.accountId.trim()}
                    className="inline-flex items-center gap-1 rounded bg-primary px-2 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                    Tạo
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-primary/40 bg-primary/5 px-3 py-2 text-xs font-semibold text-primary hover:bg-primary/10"
              >
                <Plus className="h-3.5 w-3.5" />
                Thêm tài khoản
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
