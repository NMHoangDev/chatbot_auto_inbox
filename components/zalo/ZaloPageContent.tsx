"use client";

import { Loader2, MessageCircle, Radio, X } from "lucide-react";
import { useState } from "react";
import { useZalo } from "./useZalo";
import { ZaloAuthCard } from "./ZaloAuthCard";
import { ZaloBroadcastPanel } from "./ZaloBroadcastPanel";
import { ZaloChatPanel } from "./ZaloChatPanel";
import { ZaloConversationList } from "./ZaloConversationList";

export function ZaloPageContent() {
  const z = useZalo();
  const [broadcastOpen, setBroadcastOpen] = useState(false);

  const currentConv = z.conversations.find((c) => c.conversation_id === z.openConvId) || null;
  const isBroadcasting = z.broadcastStatus && z.broadcastStatus.status !== "completed" && z.broadcastStatus.status !== "failed";
  // Trong lúc polling dùng ZaloBroadcastStatus (có total/sent), ngay sau
  // khi send thì status là ZaloBroadcastResponse (có total_targets). Lấy max.
  type AnyBroadcast = { total?: number; total_targets?: number; sent?: number };
  const bStatus = z.broadcastStatus as AnyBroadcast | null;
  const broadcastTotal = bStatus?.total ?? bStatus?.total_targets ?? 0;
  const broadcastSent = bStatus?.sent ?? 0;
  const broadcastPct = broadcastTotal > 0
    ? Math.min(100, Math.round((broadcastSent / broadcastTotal) * 100))
    : 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header card */}
      <ZaloAuthCard
        status={z.loginStatus}
        loading={z.authLoading}
        error={z.authError}
        onImport={z.importFromExtension}
        onLogout={z.logout}
        onRefresh={z.refreshAuth}
        onReconnect={z.reconnectBridge}
        reconnecting={z.reconnecting}
      />

      {/* Realtime + Broadcast banner (ẩn khi không có gì để hiển thị) */}
      {(z.sseState !== "closed" && z.sseState !== "open") || isBroadcasting ? (
        <div className="mb-1.5 flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs shadow-sm">
          {z.sseState !== "open" && (
            <span className="inline-flex items-center gap-1.5 text-amber-600">
              <Loader2 className="h-3 w-3 animate-spin" />
              {z.sseState === "connecting" ? "Đang kết nối realtime..." : "Realtime đang reconnect..."}
            </span>
          )}
          {z.sseState === "open" && (
            <span className="inline-flex items-center gap-1.5 text-emerald-600">
              <Radio className="h-3 w-3 animate-pulse" />
              Realtime đang bật — sẽ tự đồng bộ khi có tin nhắn mới
            </span>
          )}
          {isBroadcasting && (
            <div className="flex flex-1 items-center gap-2">
              <MessageCircle className="h-3.5 w-3.5 text-emerald-600" />
              <div className="flex-1">
                <div className="mb-1 flex items-center justify-between text-[11px] font-semibold text-slate-700">
                  <span>Đang gửi broadcast tới {broadcastTotal} người nhận</span>
                  <span className="tabular-nums text-emerald-700">
                    {broadcastSent}/{broadcastTotal} ({broadcastPct}%)
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                    style={{ width: `${broadcastPct}%` }}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {/* Main layout: 3-pane */}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,3fr)_minmax(0,7fr)] gap-3">
        {/* Conversation list */}
        <div className="hidden min-h-0 lg:block">
          <ZaloConversationList
            conversations={z.conversations}
            loading={z.loadingConvs}
            openConvId={z.openConvId}
            onOpen={z.openConversation}
            onSync={z.syncConversations}
            onSelectBroadcast={() => setBroadcastOpen(true)}
          />
        </div>

        {/* Chat panel */}
        <div className="min-h-0">
          <ZaloChatPanel
            conv={currentConv}
            messages={z.messages}
            loading={z.loadingChat}
            sending={z.sending}
            replyText={z.replyText}
            setReplyText={z.setReplyText}
            pendingFiles={z.pendingFiles}
            setPendingFiles={z.setPendingFiles}
            members={z.groupMembers}
            mentions={z.mentions}
            setMentions={z.setMentions}
            onSend={z.sendCurrentMessage}
            onSync={z.syncCurrentChat}
          />
        </div>
      </div>

      {/* Mobile conversation list (visible when <lg) */}
      <div className="block min-h-[300px] lg:hidden">
        <ZaloConversationList
          conversations={z.conversations}
          loading={z.loadingConvs}
          openConvId={z.openConvId}
          onOpen={z.openConversation}
          onSync={z.syncConversations}
          onSelectBroadcast={() => setBroadcastOpen(true)}
        />
      </div>

      {/* Broadcast modal */}
      <ZaloBroadcastPanel
        conversations={z.conversations}
        open={broadcastOpen}
        onClose={() => setBroadcastOpen(false)}
        sending={z.broadcasting}
        status={z.broadcastStatus}
        onSend={z.sendBroadcast}
      />

      {/* Toast */}
      {z.toast && (
        <div
          className={`fixed bottom-4 right-4 z-[60] flex max-w-sm items-start gap-2 rounded-lg px-4 py-3 text-xs font-semibold text-white shadow-lg ${
            z.toast.ok ? "bg-emerald-600" : "bg-red-600"
          }`}
        >
          <span className="flex-1">{z.toast.msg}</span>
          <button onClick={() => z.showToast("", true)}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}