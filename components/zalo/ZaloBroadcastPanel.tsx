"use client";

import { CheckCircle2, Loader2, MessageSquarePlus, Plus, Send, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { ZaloBroadcastResponse, ZaloBroadcastStatus, ZaloConversation } from "@/lib/zalo-api";

interface Props {
  conversations: ZaloConversation[];
  open: boolean;
  onClose: () => void;
  sending: boolean;
  status: ZaloBroadcastResponse | ZaloBroadcastStatus | null;
  /**
   * Nhận toàn bộ messages[] (≥1). Hook xử lý việc gửi từng message lần lượt
   * tới tất cả targets — backend tự động queue + delay 5s giữa các lần.
   * Backward-compat: nếu hook cũ chỉ nhận content, có thể chỉ gửi message[0].
   */
  onSend: (
    messages: string[],
    targets: { id: string; name: string; thread_type?: "user" | "group" }[]
  ) => void;
}

const TEMPLATES = [
  { label: "Thông báo đơn hàng", text: "Đơn hàng của bạn đã được xác nhận. Cảm ơn bạn đã mua sắm!" },
  { label: "Khuyến mãi", text: "🎉 Shop đang có chương trình khuyến mãi đặc biệt. Inbox để được tư vấn nhé!" },
  { label: "Cảm ơn", text: "Cảm ơn bạn đã ủng hộ shop. Hẹn gặp lại!" },
];

export function ZaloBroadcastPanel({
  conversations,
  open,
  onClose,
  sending,
  status,
  onSend,
}: Props) {
  const [messages, setMessages] = useState<string[]>([""]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) =>
      (c.conversation_name || "").toLowerCase().includes(q)
    );
  }, [conversations, search]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const toggleAll = () => {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((c) => c.conversation_id)));
    }
  };

  const updateMessage = (idx: number, value: string) => {
    setMessages((prev) => prev.map((m, i) => (i === idx ? value : m)));
  };

  const addMessage = () => {
    if (messages.length >= 20) return; // Hard cap để tránh spam nhầm
    setMessages((prev) => [...prev, ""]);
  };

  const removeMessage = (idx: number) => {
    setMessages((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      // Luôn giữ ít nhất 1 message slot (không xoá hết).
      return next.length === 0 ? [""] : next;
    });
  };

  const applyTemplate = (idx: number, text: string) => {
    updateMessage(idx, text);
  };

  const handleSend = () => {
    const validMessages = messages.map((m) => m.trim()).filter((m) => m.length > 0);
    if (validMessages.length === 0 || selected.size === 0) return;
    const targets = Array.from(selected).map((id) => {
      const c = conversations.find((x) => x.conversation_id === id);
      return {
        id,
        name: c?.conversation_name || "Unknown",
        thread_type: (c?.thread_type === "group" ? "group" : "user") as
          | "user"
          | "group",
      };
    });
    onSend(validMessages, targets);
    setMessages([""]);
    setSelected(new Set());
  };

  const validCount = messages.filter((m) => m.trim().length > 0).length;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4 backdrop-blur-sm">
      <div className="flex h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-gradient-to-r from-emerald-600 to-emerald-700 px-5 py-3 text-white">
          <div className="flex items-center gap-2">
            <MessageSquarePlus className="h-5 w-5" />
            <div>
              <div className="text-base font-bold">Gửi tin nhắn hàng loạt</div>
              <div className="text-xs opacity-80">
                Nhiều tin nhắn · nhiều người nhận · gửi tuần tự theo thứ tự
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-lg hover:bg-white/10"
            title="Đóng"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Target list */}
          <div className="flex w-2/5 flex-col border-r border-slate-200">
            <div className="flex items-center justify-between gap-2 border-b border-slate-200 p-2.5">
              <div className="text-xs font-semibold text-slate-700">
                Đã chọn <span className="text-emerald-600">{selected.size}</span> / {conversations.length}
              </div>
              <button
                onClick={toggleAll}
                className="text-[11px] font-semibold text-emerald-600 hover:underline"
              >
                {selected.size === filtered.length ? "Bỏ chọn tất cả" : "Chọn tất cả"}
              </button>
            </div>
            <div className="border-b border-slate-200 p-2">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Tìm kiếm..."
                className="w-full rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs outline-none focus:border-emerald-500"
              />
            </div>
            <div className="flex-1 overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-400">
                  Không có hội thoại nào
                </div>
              ) : (
                filtered.map((c) => {
                  const checked = selected.has(c.conversation_id);
                  return (
                    <label
                      key={c.conversation_id}
                      className={`flex cursor-pointer items-center gap-2 border-b border-slate-100 px-3 py-2 transition hover:bg-slate-50 ${
                        checked ? "bg-emerald-50" : ""
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(c.conversation_id)}
                        className="h-3.5 w-3.5 rounded text-emerald-600"
                      />
                      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-blue-500 to-blue-700 text-[10px] font-bold text-white">
                        {c.conversation_name?.[0]?.toUpperCase() || "?"}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-semibold text-slate-800">
                          {c.conversation_name || "Không tên"}
                        </div>
                      </div>
                    </label>
                  );
                })
              )}
            </div>
          </div>

          {/* Messages editor */}
          <div className="flex w-3/5 flex-col">
            <div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
              <div>
                <div className="text-xs font-semibold text-slate-700">
                  Tin nhắn ({validCount}/{messages.length} hợp lệ)
                </div>
                <div className="text-[11px] text-slate-500">
                  Gửi tuần tự: tin 1 → hết người nhận → tin 2 → hết người nhận → ...
                </div>
              </div>
              <button
                onClick={addMessage}
                disabled={messages.length >= 20}
                className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-[11px] font-bold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-50"
                title={messages.length >= 20 ? "Tối đa 20 tin nhắn" : "Thêm tin nhắn"}
              >
                <Plus className="h-3 w-3" />
                Thêm
              </button>
            </div>

            {/* Templates chỉ apply cho message slot đầu tiên (nhanh) */}
            <div className="border-b border-slate-200 px-3 py-2">
              <div className="mb-1.5 text-[11px] font-semibold text-slate-600">
                Mẫu nhanh (áp dụng vào ô đang focus):
              </div>
              <div className="flex flex-wrap gap-1.5">
                {TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.label}
                    onClick={() => {
                      // Apply cho message đầu tiên có nội dung; nếu tất cả rỗng → apply cho slot 0.
                      const idx = messages.findIndex((m) => m.trim().length === 0);
                      applyTemplate(idx === -1 ? 0 : idx, tpl.text);
                    }}
                    className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-700 transition hover:border-emerald-500 hover:bg-emerald-50 hover:text-emerald-700"
                  >
                    {tpl.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {messages.map((msg, idx) => (
                <div
                  key={idx}
                  className={`rounded-lg border-2 transition ${
                    msg.trim().length > 0
                      ? "border-emerald-200 bg-emerald-50/30"
                      : "border-slate-200 bg-slate-50"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 border-b border-slate-200/60">
                    <div className="flex items-center gap-1.5">
                      <span className="grid h-5 w-5 place-items-center rounded-full bg-emerald-600 text-[10px] font-bold text-white">
                        {idx + 1}
                      </span>
                      <span className="text-[11px] font-semibold text-slate-700">
                        Tin nhắn #{idx + 1}
                      </span>
                      <span className="text-[10px] text-slate-500">
                        {msg.trim().length > 0 ? `${msg.trim().length} ký tự` : "trống"}
                      </span>
                    </div>
                    {messages.length > 1 && (
                      <button
                        onClick={() => removeMessage(idx)}
                        className="grid h-6 w-6 place-items-center rounded text-slate-400 transition hover:bg-red-50 hover:text-red-500"
                        title="Xoá tin nhắn này"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <textarea
                    value={msg}
                    onChange={(e) => updateMessage(idx, e.target.value)}
                    placeholder={`Nhập nội dung tin nhắn #${idx + 1}...`}
                    className="block w-full resize-none rounded-b-md bg-white px-3 py-2 text-sm outline-none focus:bg-white"
                    rows={3}
                  />
                </div>
              ))}

              {messages.length < 20 && (
                <button
                  onClick={addMessage}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border-2 border-dashed border-slate-300 bg-white py-2 text-xs font-semibold text-slate-500 transition hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-700"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Thêm tin nhắn khác
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <div className="text-xs text-slate-600">
            {status ? (
              <span className="inline-flex items-center gap-1 text-emerald-600">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Đã gửi tới {(status as ZaloBroadcastResponse).total_targets ?? (status as ZaloBroadcastStatus).total} người nhận (campaign {status.campaign_id.slice(0, 8)})
              </span>
            ) : (
              <span>
                Sẽ gửi <b>{validCount}</b> tin nhắn × <b>{selected.size}</b> người nhận = <b>{validCount * selected.size}</b> tin,
                delay 5s mỗi lần để tránh bị Zalo chặn.
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-slate-400"
            >
              Đóng
            </button>
            <button
              onClick={handleSend}
              disabled={sending || validCount === 0 || selected.size === 0}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-bold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-50"
            >
              {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Gửi {validCount * selected.size} tin
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}