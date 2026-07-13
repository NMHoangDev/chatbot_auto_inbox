"use client";

import { CheckCircle2, ExternalLink, Loader2, LogOut, MessageCircle, PlugZap, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { ZaloLoginStatus } from "@/lib/zalo-api";

interface Props {
  status: ZaloLoginStatus | null;
  loading: boolean;
  error: string | null;
  onImport: () => void;
  onLogout: () => void;
  onRefresh: () => void;
  onReconnect?: () => void;
  reconnecting?: boolean;
}

export function ZaloAuthCard({ status, loading, error, onImport, onLogout, onRefresh, onReconnect, reconnecting }: Props) {
  const isLoggedIn = status?.is_logged_in ?? false;
  const isExpired = status?.session_expired ?? false;

  return (
    <div className="mb-2 rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-blue-500 to-blue-700 text-white shadow-sm">
            <MessageCircle className="h-4 w-4" />
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-bold text-slate-800">Kết nối Zalo</span>
            {isLoggedIn ? (
              <>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 font-semibold text-emerald-700">
                  <Wifi className="h-3 w-3" />
                  Đã kết nối
                </span>
                <span className="text-slate-500">
                  Session: <code className="font-mono">{status?.session_id?.slice(-12) || "—"}</code>
                </span>
              </>
            ) : isExpired ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 font-semibold text-amber-700">
                <WifiOff className="h-3 w-3" />
                Phiên hết hạn
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 font-semibold text-slate-600">
                <WifiOff className="h-3 w-3" />
                Chưa kết nối
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {isLoggedIn ? (
            <>
              <button
                onClick={onReconnect}
                disabled={reconnecting || loading}
                className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-700 transition hover:border-amber-500 hover:bg-amber-100 disabled:opacity-50"
                title="Restart WebSocket Zalo (khi tin nhắn mới không đồng bộ). Sau đó đợi ~5s."
              >
                <PlugZap className={`h-3 w-3 ${reconnecting ? "animate-pulse" : ""}`} />
                {reconnecting ? "Reconnecting..." : "Reconnect WS"}
              </button>
              <button
                onClick={onRefresh}
                disabled={loading}
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 transition hover:border-blue-500 hover:text-blue-600 disabled:opacity-50"
              >
                <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
                Làm mới
              </button>
              <button
                onClick={onLogout}
                disabled={loading}
                className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-red-600 transition hover:bg-red-50 disabled:opacity-50"
              >
                <LogOut className="h-3 w-3" />
                Đăng xuất
              </button>
            </>
          ) : (
            <button
              onClick={onImport}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm transition hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <MessageCircle className="h-3.5 w-3.5" />
              )}
              Đăng nhập Zalo
            </button>
          )}
        </div>
      </div>

      {/* Hướng dẫn khi chưa login */}
      {!isLoggedIn && (
        <div className="mt-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-2.5 text-[11px] text-slate-600">
          <div className="mb-1 flex items-center gap-1 font-bold text-slate-700">
            <span>📋</span>
            <span>Hướng dẫn kết nối (1 click):</span>
          </div>
          <ol className="ml-4 list-decimal space-y-0.5">
            <li>
              Cài extension <code className="rounded bg-slate-200 px-1 font-mono text-[10px]">extension-login-zalo</code> trên Chrome (load unpacked từ <code className="rounded bg-slate-200 px-1 font-mono text-[10px]">extensions/extension-login-zalo</code>).
            </li>
            <li>
              Mở tab <a href="https://chat.zalo.me/" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-semibold text-blue-600 hover:underline">
                chat.zalo.me <ExternalLink className="h-3 w-3" />
              </a> và đăng nhập QR trên điện thoại.
            </li>
            <li>
              <strong className="text-amber-700">Quan trọng:</strong> trước khi bấm "Đăng nhập Zalo" ở đây, hãy <strong>đóng tab chat.zalo.me</strong> trong Chrome. Nếu không, Zalo sẽ đóng WS bridge ngay lập tức do có 2 connection cùng tài khoản (lỗi Overlimit).
            </li>
            <li>
              Quay lại đây bấm nút <strong>Đăng nhập Zalo</strong> — extension tự lấy cookie và gửi về zalo-bridge. Sau khi bridge import xong, <strong className="text-amber-700">giữ đóng tab chat.zalo.me</strong> trong khi dùng UI này.
            </li>
          </ol>
        </div>
      )}

      {isLoggedIn && (
        <div className="mt-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800">
          <strong>Lưu ý:</strong> để WS không bị đóng bởi Zalo (lỗi <code className="font-mono">Overlimit connection</code>), hãy <strong>đóng tab chat.zalo.me</strong> trong Chrome khi dùng UI này. Nếu lỡ mở, bấm <strong>Reconnect WS</strong>.
        </div>
      )}

      {error && (
        <div className="mt-1.5 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">
          ⚠️ {error}
        </div>
      )}

      {isLoggedIn && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-emerald-600">
          <CheckCircle2 className="h-3 w-3" />
          <span>Sẵn sàng gửi tin nhắn và broadcast tới khách hàng.</span>
        </div>
      )}
    </div>
  );
}