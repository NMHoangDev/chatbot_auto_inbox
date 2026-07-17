"use client";

import { Loader2, MessageSquare, MessageSquarePlus, Pin, RefreshCcw, Search, Send } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ZaloConversation } from "@/lib/zalo-api";

interface Props {
  conversations: ZaloConversation[];
  loading: boolean;
  openConvId: string | null;
  onOpen: (id: string) => void;
  onSync: () => void;
  onSelectBroadcast: () => void;
  onTogglePin: (conversationId: string, pinned: boolean) => void;
}

function formatRelativeTime(dateStr?: string | null): string {
  if (!dateStr) return "";
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return "";
  const now = Date.now();
  const diff = (now - t) / 1000;
  if (diff < 60) return "vừa xong";
  if (diff < 3600) return `${Math.floor(diff / 60)} phút`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} giờ`;
  if (diff < 604800) return `${Math.floor(diff / 86400)} ngày`;
  return new Date(dateStr).toLocaleDateString("vi-VN");
}

export function ZaloConversationList({
  conversations,
  loading,
  openConvId,
  onOpen,
  onSync,
  onSelectBroadcast,
  onTogglePin,
}: Props) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) =>
      (c.conversation_name || "").toLowerCase().includes(q)
    );
  }, [conversations, query]);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      {/* Header */}
      <div className="shrink-0 border-b border-slate-200 p-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-slate-800">
            Hội thoại
            <span className="ml-1 text-[11px] font-normal text-slate-400">
              ({filtered.length} — sắp xếp theo tin nhắn mới nhất)
            </span>
          </h3>
          <div className="flex items-center gap-1">
            <button
              onClick={onSelectBroadcast}
              className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-700"
              title="Gửi broadcast hàng loạt"
            >
              <MessageSquarePlus className="h-3.5 w-3.5" />
              Broadcast
            </button>
            <Link
              href="/zalo/forward-rules"
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 transition hover:border-blue-500 hover:text-blue-600"
              title="Cấu hình chuyển tiếp tự động từ nhóm chính"
            >
              <Send className="h-3.5 w-3.5" />
              Chuyển tiếp
            </Link>
            <button
              onClick={onSync}
              disabled={loading}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 transition hover:border-blue-500 hover:text-blue-600 disabled:opacity-50"
            >
              <RefreshCcw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              Sync
            </button>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5">
          <Search className="h-4 w-4 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Tìm hội thoại..."
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
          />
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {loading && conversations.length === 0 ? (
          <div className="flex h-full items-center justify-center p-4 text-xs text-slate-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Đang tải...
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-xs text-slate-500">
            <MessageSquare className="h-8 w-8 text-slate-300" />
            <p>{conversations.length === 0 ? "Chưa có hội thoại nào" : "Không tìm thấy"}</p>
            {conversations.length === 0 && (
              <button
                onClick={onSync}
                className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:underline"
              >
                <RefreshCcw className="h-3 w-3" />
                Sync ngay
              </button>
            )}
          </div>
        ) : (
          filtered.map((c) => {
            const active = c.conversation_id === openConvId;
            const pinned = !!c.is_pinned;
            return (
              // div (không phải <button>) vì bên trong còn 1 nút ghim riêng —
              // button lồng button là HTML không hợp lệ, browser sẽ tự đẩy
              // nút con ra ngoài khi parse, làm gãy hành vi click.
              <div
                key={c.conversation_id}
                role="button"
                tabIndex={0}
                onClick={() => onOpen(c.conversation_id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") onOpen(c.conversation_id);
                }}
                className={`flex w-full cursor-pointer items-start gap-3 border-b border-slate-100 px-3.5 py-3.5 text-left transition hover:bg-slate-50 ${
                  active ? "bg-blue-50" : pinned ? "bg-amber-50/60" : ""
                }`}
              >
                <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-gradient-to-br from-blue-500 to-blue-700 text-base font-bold text-white">
                  {c.conversation_name?.[0]?.toUpperCase() || "?"}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-1">
                    <div className="flex min-w-0 items-center gap-1">
                      {pinned && <Pin className="h-3 w-3 shrink-0 fill-amber-500 text-amber-500" />}
                      <div className="truncate text-sm font-bold text-slate-800">
                        {c.conversation_name || "Không tên"}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span className="text-[11px] text-slate-400">
                        {formatRelativeTime(c.latest_message_at)}
                      </span>
                      <span
                        role="button"
                        tabIndex={0}
                        title={pinned ? "Bỏ ghim" : "Ghim hội thoại lên đầu"}
                        onClick={(e) => {
                          e.stopPropagation();
                          onTogglePin(c.conversation_id, !pinned);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.stopPropagation();
                            e.preventDefault();
                            onTogglePin(c.conversation_id, !pinned);
                          }
                        }}
                        className={`grid h-6 w-6 place-items-center rounded-full transition hover:bg-slate-200 ${
                          pinned ? "text-amber-500" : "text-slate-300 hover:text-slate-500"
                        }`}
                      >
                        <Pin className={`h-3.5 w-3.5 ${pinned ? "fill-amber-500" : ""}`} />
                      </span>
                    </div>
                  </div>
                  <div className="mt-0.5 truncate text-xs text-slate-500">
                    {c.latest_content || (c.has_messages ? "..." : "Chưa có tin nhắn")}
                  </div>
                  {c.unread_count > 0 && (
                    <span className="mt-1 inline-flex min-w-[20px] items-center justify-center rounded-full bg-red-500 px-1.5 text-[11px] font-bold text-white">
                      {c.unread_count}
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}