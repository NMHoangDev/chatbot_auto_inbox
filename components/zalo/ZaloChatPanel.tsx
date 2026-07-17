"use client";

import { AtSign, Image as ImageIcon, Loader2, MessageCircle, Paperclip, RefreshCw, Send, User, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ZaloConversation, ZaloGroupMember, ZaloMention, ZaloMessage } from "@/lib/zalo-api";

interface Props {
  conv: ZaloConversation | null;
  messages: ZaloMessage[];
  loading: boolean;
  sending: boolean;
  replyText: string;
  setReplyText: (s: string) => void;
  pendingFiles: File[];
  setPendingFiles: (files: File[]) => void;
  /** Thành viên nhóm đang mở — nguồn gợi ý khi gõ "@". Rỗng với DM. */
  members: ZaloGroupMember[];
  mentions: ZaloMention[];
  setMentions: (updater: ZaloMention[] | ((prev: ZaloMention[]) => ZaloMention[])) => void;
  onSend: () => void;
  onSync: () => void;
}

type MentionCandidate = ZaloGroupMember & { insertText?: string };

const TAG_ALL_CANDIDATE: MentionCandidate = {
  uid: "-1",
  name: "Tất cả mọi người",
  avatar: null,
  insertText: "all",
};

function normalizeForSearch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase();
}

// ── Diff-shift mentions khi text đổi ────────────────────────────────────────
// Textarea không phải rich-editor nên mention chỉ là 1 cặp (pos, len, uid)
// trỏ vào text thường — mỗi lần user gõ thêm/xoá ký tự, mọi mention nằm SAU
// vị trí sửa phải dịch offset theo đúng độ lệch độ dài, còn mention nào bị
// sửa đè lên (user gõ đè vào giữa tên đã tag) phải loại bỏ vì không còn đúng
// nữa. Tìm phần chung ở đầu + cuối 2 chuỗi để xác định đúng vùng đã đổi.
function shiftMentions(oldText: string, newText: string, list: ZaloMention[]): ZaloMention[] {
  if (list.length === 0) return list;
  const maxStart = Math.min(oldText.length, newText.length);
  let start = 0;
  while (start < maxStart && oldText[start] === newText[start]) start++;
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const delta = newEnd - oldEnd;
  const result: ZaloMention[] = [];
  for (const m of list) {
    const mEnd = m.pos + m.len;
    if (mEnd <= start) {
      result.push(m);
    } else if (m.pos >= oldEnd) {
      result.push({ ...m, pos: m.pos + delta });
    }
    // else: mention overlaps vùng vừa sửa → bỏ, không còn hợp lệ.
  }
  return result;
}

// Tìm trigger "@" đang gõ dở trước vị trí con trỏ (caret). Chỉ tính là
// trigger nếu "@" đứng ở đầu chuỗi hoặc ngay sau khoảng trắng/xuống dòng
// (tránh nhầm với email, vd "a@b.com"), và giữa "@" và caret không có
// khoảng trắng (gõ dấu cách → coi như huỷ, giống Slack/Messenger).
function findMentionTrigger(text: string, caret: number): { start: number; query: string } | null {
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === "@") {
      const before = i === 0 ? " " : text[i - 1];
      if (/\s/.test(before)) {
        return { start: i, query: text.slice(i + 1, caret) };
      }
      return null;
    }
    if (/\s/.test(ch)) return null;
    i--;
  }
  return null;
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
  members,
  mentions,
  setMentions,
  onSend,
  onSync,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [dragOver, setDragOver] = useState(false);

  // Dropdown gợi ý "@" — chỉ có ý nghĩa trong group (Zalo chỉ tag được người
  // trong group, DM không có khái niệm "tag" ai khác ngoài đối phương).
  const isGroup = conv?.thread_type === "group";
  const [mentionTrigger, setMentionTrigger] = useState<{ start: number; query: string } | null>(null);
  const [highlightIdx, setHighlightIdx] = useState(0);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  // Đổi hội thoại → đóng dropdown đang mở dở (tránh tag nhầm nhóm khác).
  useEffect(() => {
    setMentionTrigger(null);
  }, [conv?.conversation_id]);

  const candidates: MentionCandidate[] = useMemo(() => {
    if (!mentionTrigger || !isGroup) return [];
    const q = normalizeForSearch(mentionTrigger.query);
    const pool: MentionCandidate[] = [TAG_ALL_CANDIDATE, ...members];
    const filtered = q.length === 0 ? pool : pool.filter((m) => normalizeForSearch(m.name).includes(q));
    return filtered.slice(0, 8);
  }, [mentionTrigger, isGroup, members]);

  useEffect(() => {
    setHighlightIdx(0);
  }, [candidates.length, mentionTrigger?.start]);

  const handleFileSelect = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setPendingFiles([...pendingFiles, ...Array.from(files)]);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    handleFileSelect(e.dataTransfer.files);
  };

  const handleReplyChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const oldText = replyText;
    const newText = e.target.value;
    setMentions((prev) => shiftMentions(oldText, newText, prev));
    setReplyText(newText);
    const caret = e.target.selectionStart ?? newText.length;
    setMentionTrigger(isGroup ? findMentionTrigger(newText, caret) : null);
  };

  const selectMention = (member: MentionCandidate) => {
    if (!mentionTrigger) return;
    const { start, query } = mentionTrigger;
    const caret = start + 1 + query.length;
    const insertName = member.insertText ?? member.name;
    const insertion = `@${insertName} `;
    const newText = replyText.slice(0, start) + insertion + replyText.slice(caret);
    const shifted = shiftMentions(replyText, newText, mentions);
    const mentionLen = insertion.trimEnd().length;
    setMentions([...shifted, { pos: start, len: mentionLen, uid: member.uid }]);
    setReplyText(newText);
    setMentionTrigger(null);
    const cursor = start + insertion.length;
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(cursor, cursor);
    });
  };

  const handleReplyKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionTrigger && candidates.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIdx((i) => (i + 1) % candidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIdx((i) => (i - 1 + candidates.length) % candidates.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectMention(candidates[highlightIdx]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionTrigger(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void onSend();
    }
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
        <div className="relative flex-1">
          {mentionTrigger && candidates.length > 0 && (
            <div className="absolute bottom-full left-0 z-10 mb-1.5 max-h-56 w-64 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
              {candidates.map((c, i) => (
                <button
                  key={c.uid}
                  type="button"
                  onMouseDown={(e) => {
                    // preventDefault: giữ focus textarea, tránh blur đóng dropdown
                    // trước khi onClick kịp chạy.
                    e.preventDefault();
                    selectMention(c);
                  }}
                  onMouseEnter={() => setHighlightIdx(i)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                    i === highlightIdx ? "bg-blue-50 text-blue-700" : "text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  {c.uid === "-1" ? (
                    <div className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-blue-100 text-blue-600">
                      <AtSign className="h-3.5 w-3.5" />
                    </div>
                  ) : c.avatar ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.avatar} alt="" className="h-6 w-6 shrink-0 rounded-full object-cover" />
                  ) : (
                    <div className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-slate-300 text-[10px] font-bold text-white">
                      {c.name?.[0]?.toUpperCase() || <User className="h-3 w-3" />}
                    </div>
                  )}
                  <span className="truncate">{c.name}</span>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={replyText}
            onChange={handleReplyChange}
            onKeyDown={handleReplyKeyDown}
            placeholder={isGroup ? "Nhập tin nhắn... (gõ @ để tag thành viên)" : "Nhập tin nhắn..."}
            rows={1}
            className="w-full resize-none rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm outline-none focus:border-blue-500 focus:bg-white"
          />
        </div>
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