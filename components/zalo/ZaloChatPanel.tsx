"use client";

import { Image as ImageIcon, Loader2, MessageCircle, Paperclip, RefreshCw, Send, User, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ZaloConversation, ZaloMessage } from "@/lib/zalo-api";

interface Props {
  conv: ZaloConversation | null;
  messages: ZaloMessage[];
  loading: boolean;
  sending: boolean;
  replyText: string;
  setReplyText: (s: string) => void;
  pendingFiles: File[];
  setPendingFiles: (files: File[]) => void;
  onSend: () => void;
  onSync: () => void;
}

function formatTime(dateStr?: string | null): string {
  if (!dateStr) return "";
  const t = new Date(dateStr);
  if (Number.isNaN(t.getTime())) return dateStr;
  return t.toLocaleString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  });
}

function MessageBubble({ msg }: { msg: ZaloMessage }) {
  const mine = msg.is_sent;
  const [expanded, setExpanded] = useState(false);

  if (msg.is_deleted) {
    return (
      <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
        <div className="rounded-2xl bg-slate-100 px-4 py-2 text-xs italic text-slate-400">
          Tin nhắn đã bị thu hồi
        </div>
      </div>
    );
  }

  return (
    <div className={`flex gap-2 ${mine ? "justify-end" : "justify-start"}`}>
      {!mine && (
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-slate-300 text-xs font-bold text-white">
          {msg.sender_name?.[0]?.toUpperCase() || <User className="h-3.5 w-3.5" />}
        </div>
      )}
      <div className={`max-w-[80%] ${mine ? "items-end" : "items-start"} flex flex-col gap-0.5`}>
        {!mine && msg.sender_name && (
          <div className="px-2 text-[11px] font-semibold text-slate-500">{msg.sender_name}</div>
        )}
        <div
          className={`rounded-2xl px-4 py-2 text-sm leading-relaxed ${
            mine
              ? "rounded-br-sm bg-blue-600 text-white"
              : "rounded-bl-sm bg-white text-slate-800 shadow-sm"
          }`}
        >
          {/* Ảnh */}
          {msg.image_urls && msg.image_urls.length > 0 && (
            <div className={`grid gap-1 ${msg.image_urls.length > 1 ? "grid-cols-2" : ""}`}>
              {msg.image_urls.map((url, i) => (
                <a
                  key={i}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={url}
                    alt={`image-${i}`}
                    className="max-h-56 max-w-full rounded-lg object-cover transition hover:opacity-90"
                  />
                </a>
              ))}
            </div>
          )}

          {/* Text */}
          {msg.content && (
            <div
              className={`whitespace-pre-wrap break-words ${
                msg.image_urls && msg.image_urls.length > 0 ? "mt-2" : ""
              }`}
              onClick={() => setExpanded(!expanded)}
            >
              {msg.content}
            </div>
          )}
        </div>
        <div className={`px-2 text-[11px] text-slate-400 ${mine ? "text-right" : ""}`}>
          {formatTime(msg.timestamp || msg.time_text)}
        </div>
      </div>
    </div>
  );
}

export function ZaloChatPanel({
  conv,
  messages,
  loading,
  sending,
  replyText,
  setReplyText,
  pendingFiles,
  setPendingFiles,
  onSend,
  onSync,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const handleFileSelect = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setPendingFiles([...pendingFiles, ...Array.from(files)]);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    handleFileSelect(e.dataTransfer.files);
  };

  if (!conv) {
    return (
      <div className="flex h-full items-center justify-center rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="text-center text-xs text-slate-400">
          <MessageCircle className="mx-auto mb-2 h-12 w-12 text-slate-200" />
          <p>Chọn một hội thoại để bắt đầu nhắn tin</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gradient-to-br from-blue-500 to-blue-700 text-sm font-bold text-white">
            {conv.conversation_name?.[0]?.toUpperCase() || "?"}
          </div>
          <div className="min-w-0">
            <div className="truncate text-base font-bold text-slate-800">
              {conv.conversation_name || "Không tên"}
            </div>
            <div className="text-xs text-slate-500">
              {conv.message_count || 0} tin nhắn
            </div>
          </div>
        </div>
        <button
          onClick={onSync}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-blue-500 hover:text-blue-600 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Sync
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto bg-slate-50 p-4">
        {loading && messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            Đang tải tin nhắn...
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-400">
            Chưa có tin nhắn nào. Hãy bắt đầu cuộc trò chuyện!
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((m, idx) => {
              // Key ổn định để React không re-mount khi setMessages thay thế
              // list bằng list mới (vd SSE refresh). Ưu tiên message_id; nếu
              // row SSE cũ không có id (trước fix), dùng composite key từ
              // (timestamp+sender+content) để vẫn dedupe key — tránh React
              // warning "duplicate key" khi DB có row trùng.
              const tsRaw = m.timestamp ? new Date(m.timestamp).getTime() : 0;
              const mId = m.message_id
                ? String(m.message_id)
                : `${Number.isFinite(tsRaw) ? tsRaw : idx}|${m.sender_id ?? ""}|${(m.content ?? "").slice(0, 50)}`;
              return <MessageBubble key={mId} msg={m} />;
            })}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* File previews */}
      {pendingFiles.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-2 border-t border-slate-200 bg-slate-50 p-2.5">
          {pendingFiles.map((f, i) => (
            <div
              key={i}
              className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs"
            >
              {f.type.startsWith("image/") ? (
                <ImageIcon className="h-3.5 w-3.5 text-blue-500" />
              ) : (
                <Paperclip className="h-3.5 w-3.5 text-slate-500" />
              )}
              <span className="max-w-[140px] truncate">{f.name}</span>
              <button
                onClick={() => setPendingFiles(pendingFiles.filter((_, idx) => idx !== i))}
                className="ml-1 text-slate-400 hover:text-red-500"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input */}
      <div
        className={`flex shrink-0 items-end gap-2 border-t border-slate-200 p-3 ${
          dragOver ? "bg-blue-50" : "bg-white"
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => handleFileSelect(e.target.files)}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-blue-600"
          title="Đính kèm file"
        >
          <Paperclip className="h-5 w-5" />
        </button>
        <textarea
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void onSend();
            }
          }}
          placeholder="Nhập tin nhắn..."
          rows={1}
          className="flex-1 resize-none rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm outline-none focus:border-blue-500 focus:bg-white"
        />
        <button
          onClick={onSend}
          disabled={sending || (!replyText.trim() && pendingFiles.length === 0)}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-blue-600 text-white shadow-sm transition hover:bg-blue-700 disabled:opacity-50"
          title="Gửi"
        >
          {sending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
        </button>
      </div>
    </div>
  );
}