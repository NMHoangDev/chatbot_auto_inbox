"use client";

/**
 * Trimmed AppProvider — chỉ giữ phần state liên quan tới multi-account Zalo
 * (nguyên bản InvoiceFlowManager gộp chung với state scan hoá đơn, không cần
 * cho demo này). Giữ nguyên tên export (AppProvider/useApp) + interface con
 * mà components/zalo/* và useZalo.ts đang dùng để không phải sửa import ở
 * các file đã copy.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode
} from "react";
import { zaloAccountsApi, type ZaloAccountSummary } from "@/lib/zalo-api";

interface AppContextType {
  error: string;
  setError: (msg: string) => void;
  notice: string;
  setNotice: (msg: string) => void;
  zaloAccounts: ZaloAccountSummary[];
  loadingZaloAccounts: boolean;
  currentAccountId: string | null;
  setCurrentAccountId: (id: string | null) => void;
  refreshZaloAccounts: () => Promise<void>;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

const ACC_STORAGE_KEY = "zalo-current-account-id";

export function AppProvider({ children }: { children: ReactNode }) {
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [zaloAccounts, setZaloAccounts] = useState<ZaloAccountSummary[]>([]);
  const [loadingZaloAccounts, setLoadingZaloAccounts] = useState(false);
  const [currentAccountId, _setCurrentAccountId] = useState<string | null>(null);

  const setCurrentAccountId = useCallback((id: string | null) => {
    _setCurrentAccountId(id);
    if (typeof window !== "undefined") {
      try {
        if (id) window.localStorage.setItem(ACC_STORAGE_KEY, id);
        else window.localStorage.removeItem(ACC_STORAGE_KEY);
      } catch {
        /* ignore */
      }
    }
  }, []);

  const refreshZaloAccounts = useCallback(async () => {
    setLoadingZaloAccounts(true);
    try {
      const data = await zaloAccountsApi.list();
      const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
      setZaloAccounts(accounts);
      // Auto-select: 1) localStorage nếu còn tồn tại, 2) connected đầu tiên, 3) bất kỳ.
      _setCurrentAccountId((prev) => {
        if (prev && accounts.some((a) => a.account_id === prev)) return prev;
        if (typeof window !== "undefined") {
          try {
            const saved = window.localStorage.getItem(ACC_STORAGE_KEY);
            if (saved && accounts.some((a) => a.account_id === saved)) return saved;
          } catch {
            /* ignore */
          }
        }
        const connected = accounts.find((a) => a.status === "connected");
        return connected?.account_id ?? accounts[0]?.account_id ?? null;
      });
    } catch {
      setZaloAccounts([]);
    } finally {
      setLoadingZaloAccounts(false);
    }
  }, []);

  useEffect(() => {
    void refreshZaloAccounts();
  }, [refreshZaloAccounts]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => {
      void refreshZaloAccounts();
    };
    window.addEventListener("zalo-account-changed", handler);
    return () => window.removeEventListener("zalo-account-changed", handler);
  }, [refreshZaloAccounts]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(""), 5200);
    return () => window.clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    if (!error) return;
    const t = window.setTimeout(() => setError(""), 7600);
    return () => window.clearTimeout(t);
  }, [error]);

  return (
    <AppContext.Provider
      value={{
        error,
        setError,
        notice,
        setNotice,
        zaloAccounts,
        loadingZaloAccounts,
        currentAccountId,
        setCurrentAccountId,
        refreshZaloAccounts
      }}
    >
      {children}
      {(error || notice) && (
        <div className="pointer-events-none fixed inset-x-0 top-3 z-[200] flex flex-col items-center gap-2 px-4">
          {error ? (
            <div className="pointer-events-auto max-w-md rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 shadow-sm">
              {error}
            </div>
          ) : null}
          {notice ? (
            <div className="pointer-events-auto max-w-md rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 shadow-sm">
              {notice}
            </div>
          ) : null}
        </div>
      )}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp must be used within AppProvider");
  return context;
}
