/**
 * Zalo API client cho InvoiceFlow Frontend.
 * Gọi thẳng zalo-bridge Node (services/zalo-bridge) — KHÔNG qua Python backend.
 *
 * Bridge chạy ở http://localhost:3001 theo mặc định. Có thể override bằng:
 *   NEXT_PUBLIC_ZALO_BRIDGE_URL  (ưu tiên)
 *   NEXT_PUBLIC_API_BASE_URL     (fallback)
 *
 * accountId mặc định = "shop-owner" (khớp với extension-login-zalo khi POST import-session).
 */

const BRIDGE_URL =
  (typeof process !== "undefined" &&
    (process.env.NEXT_PUBLIC_ZALO_BRIDGE_URL ||
      process.env.NEXT_PUBLIC_API_BASE_URL)) ||
  "http://localhost:3001";

const ZALO_API_KEY =
  (typeof process !== "undefined" &&
    (process.env.NEXT_PUBLIC_ZALO_API_KEY ||
      process.env.NEXT_PUBLIC_BRIDGE_API_KEY)) ||
  "";

export const ZALO_ACCOUNT_ID =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_ZALO_ACCOUNT_ID) ||
  "shop-owner";

export class ZaloApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;
  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = "ZaloApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  body?: unknown;
  formData?: FormData;
  signal?: AbortSignal;
  timeoutMs?: number;
  accountId?: string;
};

async function request<T = unknown>(
  path: string,
  opts: RequestOptions = {}
): Promise<T> {
  const { method = "GET", body, formData, signal, timeoutMs = 60_000, accountId: optAccountId } = opts;

  const finalHeaders: Record<string, string> = {
    // Ưu tiên accountId truyền qua opts (multi-account) → fallback env/default.
    "X-User-ID": optAccountId || ZALO_ACCOUNT_ID,
  };
  if (ZALO_API_KEY) finalHeaders["X-API-Key"] = ZALO_API_KEY;

  if (!formData && !finalHeaders["Content-Type"]) {
    finalHeaders["Content-Type"] = "application/json";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const finalSignal = signal ?? controller.signal;
  if (signal) {
    signal.addEventListener("abort", () => controller.abort());
  }

  try {
    const res = await fetch(`${BRIDGE_URL}${path}`, {
      method,
      headers: finalHeaders,
      body: formData
        ? formData
        : body === undefined
          ? undefined
          : typeof body === "string"
            ? body
            : JSON.stringify(body),
      signal: finalSignal,
    });

    const contentType = res.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");
    const payload = isJson ? await res.json() : await res.text();

    if (!res.ok) {
      const msg =
        (isJson && (payload?.detail || payload?.message || payload?.error)) ||
        (typeof payload === "string" ? payload : `HTTP ${res.status}`);
      throw new ZaloApiError(
        String(msg),
        res.status,
        isJson ? payload?.code : undefined,
        isJson ? payload : undefined
      );
    }
    return payload as T;
  } finally {
    clearTimeout(timer);
  }
}

export type ZaloLoginStatus = {
  user_id: string;
  session_id: string | null;
  status: "not_logged_in" | "waiting_scan" | "confirmed" | "session_expired";
  is_logged_in: boolean;
  session_expired: boolean;
  qr_base64?: string | null;
  zalo_id?: string;
  display_name?: string;
  inbox_id?: number | string | null;
};

export type ZaloConversation = {
  conversation_id: string;
  conversation_name: string;
  account_id: string;
  thread_id: string;
  thread_type: "user" | "group";
  message_count: number;
  latest_message_at?: string | null;
  latest_content?: string | null;
  latest_sender_name?: string | null;
  latest_is_self?: boolean;
  has_messages: boolean;
  avatar_url?: string | null;
  unread_count: number;
  last_message_ts?: string | number | null;
};

export type ZaloMessage = {
  message_id: string;
  sender_id?: string | null;
  sender_name?: string | null;
  timestamp?: string | null;
  time_text?: string | null;
  type: string;
  content?: string | null;
  image_urls?: string[];
  is_sent: boolean;
  is_deleted: boolean;
  group_id?: string | null;
};

export type ZaloGroupMember = {
  uid: string;
  name: string;
  avatar: string | null;
};

/**
 * 1 lượt tag người trong tin nhắn — pos/len tính theo UTF-16 code unit
 * (JS string index, tức `text.length`/`text.slice()` bình thường). zca-js
 * validate mentions bằng đúng `msg.length` (cũng UTF-16) nên browser JS và
 * Node JS luôn khớp offset dù text có dấu tiếng Việt — không cần quy đổi.
 * uid "-1" là mã đặc biệt của Zalo cho "tag toàn bộ thành viên nhóm".
 */
export type ZaloMention = {
  pos: number;
  len: number;
  uid: string;
};

export type ZaloBroadcastTarget = {
  id: string;
  name: string;
  /**
   * Loại thread để backend route đúng (group vs user).
   * Nếu thiếu, backend fallback theo prefix conversation_id ('g:'/'u:').
   * Nên gửi kèm để tránh trường hợp Zalo trả về type khác 1/2/'group' →
   * bridge build conversation_id = "u:<groupId>" → broadcast gửi nhầm vào DM.
   */
  thread_type?: "user" | "group";
};

export type ZaloBroadcastResponse = {
  campaign_id: string;
  status: string;
  total_targets: number;
  /**
   * Số tin nhắn trong campaign (>=1). Mặc định 1 nếu backend chỉ trả về
   * total_targets (legacy). Dùng để UI hiển thị "đang gửi tin nhắn 2/5".
   */
  total_messages?: number;
  /**
   * Tổng job = total_targets × total_messages. Tương đương `total` trong
   * ZaloBroadcastStatus. Backend mới trả về để frontend tính progress chính
   * xác ngay từ lúc nhận response.
   */
  total_jobs?: number;
};

export type ZaloBroadcastStatus = {
  campaign_id: string;
  status: string;
  total: number;
  sent: number;
  failed: number;
  errors: string[];
  /**
   * Index (0-based) của message đang được gửi. undefined nếu backend cũ
   * chưa hỗ trợ.
   */
  current_message?: number;
  /**
   * Tổng số message trong campaign. undefined nếu backend cũ chưa hỗ trợ.
   */
  total_messages?: number;
  /**
   * Progress theo từng message (chỉ có khi backend mới). Mỗi entry gồm
   * { index, preview, sent, failed } — UI có thể render list "Tin 1: 12/50".
   */
  per_message?: Array<{
    index: number;
    preview: string;
    sent: number;
    failed: number;
  }>;
};

export const zaloApi = {
  baseURL: BRIDGE_URL,
  accountId: ZALO_ACCOUNT_ID,

  async getLoginStatus(accountId: string = ZALO_ACCOUNT_ID): Promise<ZaloLoginStatus> {
    return request<ZaloLoginStatus>(`/api/all-platform/zalo/auth/status?account_id=${encodeURIComponent(accountId)}`);
  },

  /**
   * Import session — gọi trực tiếp từ frontend KHÔNG qua extension (fallback).
   * Flow bình thường: extension tự POST qua `IMPORT_ZALO_SESSION` rồi tới
   * /api/all-platform/zalo/auth/import-session. Hàm này chỉ dùng khi test
   * hoặc debug.
   */
  async importSession(payload: {
    cookies: Array<Record<string, unknown>>;
    user_agent: string;
    imei?: string;
  }): Promise<{
    status: string;
    cookies_count: number;
    message: string;
  }> {
    return request("/api/all-platform/zalo/auth/import-session", {
      method: "POST",
      body: { account_id: ZALO_ACCOUNT_ID, ...payload },
    });
  },

  async logout(accountId: string = ZALO_ACCOUNT_ID): Promise<{ success: boolean }> {
    return request(`/auth/logout/${encodeURIComponent(accountId)}`, { method: "DELETE" });
  },

  /**
   * Force reconnect WS — dùng khi UI phát hiện SSE không nhận event mới trong khi
   * status vẫn "logged_in". Backend stop listener cũ + restore từ credentials.
   */
  async reconnect(accountId: string = ZALO_ACCOUNT_ID): Promise<{
    ok: boolean;
    before: string | null;
    after: string | null;
    is_logged_in: boolean;
    is_ws_connected: boolean;
    error?: string;
  }> {
    return request("/api/all-platform/zalo/auth/reconnect", {
      method: "POST",
      body: { account_id: accountId },
    });
  },

  async getConversations(limit = 200, accountId: string = ZALO_ACCOUNT_ID): Promise<{
    account_id: string;
    conversations: ZaloConversation[];
    total: number;
  }> {
    return request(
      `/api/all-platform/zalo/conversations?account_id=${encodeURIComponent(accountId)}&limit=${limit}`
    );
  },

  async syncConversations(accountId: string = ZALO_ACCOUNT_ID): Promise<{
    account_id: string;
    groups_count: number;
    friends_count: number;
    total: number;
  }> {
    return request(
      `/api/all-platform/zalo/conversations/sync?account_id=${encodeURIComponent(accountId)}`,
      { method: "POST" }
    );
  },

  /**
   * Lấy thông tin 1 group cụ thể (tên + avatar) từ Zalo bridge.
   * Trả về `null` nếu bridge không tìm thấy / session hết hạn / ZCA fail.
   *
   * Dùng khi SSE nhận message group mà thread chưa có row trong DB → frontend
   * upsert vào zalo_conversations_ui với tên THẬT, không phải "Group <id>".
   */
  async getGroupInfo(groupId: string, accountId: string = ZALO_ACCOUNT_ID): Promise<{
    ok: boolean;
    thread_id: string;
    thread_type: "group";
    group_name: string;
    avatar_url: string | null;
    /**
     * Danh sách thành viên nhóm — dùng để gợi ý khi user gõ "@" trong ô nhập
     * tin nhắn (xem ZaloChatPanel). Rỗng nếu bridge chỉ resolve được tên qua
     * fallback getCMRecent (không có member list).
     */
    members?: ZaloGroupMember[];
  } | null> {
    if (!groupId) return null;
    try {
      const data = await request<{
        ok: boolean;
        thread_id: string;
        thread_type: "group";
        group_name: string;
        avatar_url: string | null;
        members?: ZaloGroupMember[];
      }>(
        `/api/all-platform/zalo/group-info?account_id=${encodeURIComponent(accountId)}&group_id=${encodeURIComponent(groupId)}`,
        { timeoutMs: 10_000 }
      );
      return data && data.ok ? data : null;
    } catch (e) {
      // 404 / 401 / 502 đều coi như "không có data" → fallback.
      if (e instanceof ZaloApiError && (e.status === 404 || e.status === 401 || e.status === 502)) {
        return null;
      }
      // Lỗi khác (network/timeout) → vẫn trả null, frontend sẽ fallback.
      return null;
    }
  },

  /**
   * Lấy thông tin 1 user cụ thể (tên + avatar) từ Zalo bridge — tương đương
   * getGroupInfo nhưng cho DM. Dùng khi thread `user` mới xuất hiện mà
   * sender_name không có sẵn (SSE/catch-up thiếu dName) → tránh kẹt vĩnh viễn
   * ở tên fallback "Zalo <id>".
   */
  async getUserInfo(userId: string, accountId: string = ZALO_ACCOUNT_ID): Promise<{
    ok: boolean;
    thread_id: string;
    thread_type: "user";
    user_name: string;
    avatar_url: string | null;
  } | null> {
    if (!userId) return null;
    try {
      const data = await request<{
        ok: boolean;
        thread_id: string;
        thread_type: "user";
        user_name: string;
        avatar_url: string | null;
      }>(
        `/api/all-platform/zalo/user-info?account_id=${encodeURIComponent(accountId)}&user_id=${encodeURIComponent(userId)}`,
        { timeoutMs: 10_000 }
      );
      return data && data.ok ? data : null;
    } catch (e) {
      if (e instanceof ZaloApiError && (e.status === 404 || e.status === 401 || e.status === 502)) {
        return null;
      }
      return null;
    }
  },

  async getMessages(
    conversationId: string,
    limit = 100,
    offset = 0
  ): Promise<{
    messages: ZaloMessage[];
    total: number;
    limit: number;
    offset: number;
    has_more: boolean;
  }> {
    // Đọc từ Next.js route handler /api/zalo/messages (route query thread_id đúng).
    // Dùng relative path + fetch trực tiếp (không qua request() vì request luôn
    // thêm BRIDGE_URL → gọi sang bridge Node 3001 sẽ trả 404).
    // conversation_id dạng "u:4686..." hoặc "g:4686..." → chỉ lấy phần thread_id.
    const threadId = conversationId.includes(":")
      ? conversationId.split(":").slice(1).join(":")
      : conversationId;
    const url = `/api/zalo/messages?account_id=shop-owner&thread_id=${encodeURIComponent(threadId)}&limit=${limit}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new ZaloApiError(t || `HTTP ${res.status}`, res.status);
    }
    const json = await res.json();
    return {
      messages: Array.isArray(json?.messages) ? json.messages : [],
      total: Number(json?.total) || 0,
      limit,
      offset,
      has_more: false,
    };
  },

  async syncMessages(conversationId: string, count = 50): Promise<{
    conversation_id: string;
    synced: number;
    total: number;
  }> {
    // Bridge local không có route /sync-messages — fallback no-op.
    return { conversation_id: conversationId, synced: 0, total: 0 };
  },

  async sendMessage(
    conversationId: string,
    text: string,
    /**
     * BẮT BUỘC truyền để bridge biết gửi ThreadType.Group vs User.
     * Trước đây thiếu → bridge fallback 'user' → gửi nhầm vào DM.
     */
    threadType: "user" | "group",
    accountId: string = ZALO_ACCOUNT_ID,
    /** Tag người cụ thể — chỉ có hiệu lực khi threadType === "group". */
    mentions?: ZaloMention[]
  ): Promise<{ ok: boolean; conversation_id: string; message: string }> {
    return request(
      `/api/all-platform/zalo/conversations/${encodeURIComponent(conversationId)}/send?account_id=${encodeURIComponent(accountId)}`,
      {
        method: "POST",
        body: {
          text,
          thread_type: threadType,
          ...(mentions && mentions.length > 0 ? { mentions } : {}),
        },
      }
    );
  },

  async sendMedia(
    conversationId: string,
    files: File[],
    text: string | undefined,
    threadType: "user" | "group",
    accountId: string = ZALO_ACCOUNT_ID,
    mentions?: ZaloMention[]
  ): Promise<{ ok: boolean; files_sent: number; message: string }> {
    const fd = new FormData();
    if (text) fd.append("text", text);
    fd.append("thread_type", threadType);
    if (mentions && mentions.length > 0) fd.append("mentions", JSON.stringify(mentions));
    files.forEach((f) => fd.append("files", f, f.name));
    return request(
      `/api/all-platform/zalo/conversations/${encodeURIComponent(conversationId)}/send-media?account_id=${encodeURIComponent(accountId)}`,
      { method: "POST", formData: fd, timeoutMs: 120_000 }
    );
  },

  async markRead(conversationId: string, accountId: string = ZALO_ACCOUNT_ID): Promise<{ ok: boolean }> {
    return request(
      `/api/all-platform/zalo/conversations/${encodeURIComponent(conversationId)}/read?account_id=${encodeURIComponent(accountId)}`,
      { method: "POST" }
    );
  },

  async sendBroadcast(payload: {
    /**
     * Nhiều tin nhắn sẽ gửi LẦN LƯỢT tới TẤT CẢ targets theo thứ tự:
     * tin 1 → hết targets → tin 2 → hết targets → ... Backend delay 3s
     * giữa các lần gửi và 3s giữa message cuối → message kế tiếp.
     *
     * Backward-compatible: nếu chỉ truyền `content` (1 tin), backend
     * wrap thành `[content]`.
     */
    content?: string;
    messages?: string[];
    targets: ZaloBroadcastTarget[];
  }, accountId: string = ZALO_ACCOUNT_ID): Promise<ZaloBroadcastResponse> {
    return request(
      `/api/all-platform/zalo/broadcasts?account_id=${encodeURIComponent(accountId)}`,
      {
        method: "POST",
        body: payload,
      }
    );
  },

  async getBroadcastStatus(campaignId: string, accountId: string = ZALO_ACCOUNT_ID): Promise<ZaloBroadcastStatus> {
    return request(
      `/api/all-platform/zalo/broadcasts/${encodeURIComponent(campaignId)}?account_id=${encodeURIComponent(accountId)}`
    );
  },

  subscribeEvents(
    onEvent: (event: { type: string; data: unknown }) => void,
    accountId: string = ZALO_ACCOUNT_ID
  ): () => void {
    const url = `${BRIDGE_URL}/api/all-platform/zalo/events?account_id=${encodeURIComponent(accountId)}`;
    const es = new EventSource(url, { withCredentials: false });

    const handler = (type: string) => (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        onEvent({ type, data });
      } catch {
        onEvent({ type, data: e.data });
      }
    };

    const handlers: Array<[string, (e: MessageEvent) => void]> = [
      ["new_message", handler("new_message")],
      ["session_expired", handler("session_expired")],
      ["auth-status", handler("auth-status")],
      ["ping", () => {}], // ignore heartbeats
    ];

    handlers.forEach(([t, h]) => es.addEventListener(t, h));
    es.addEventListener("error", () => {
      // EventSource tự reconnect.
    });

    return () => {
      handlers.forEach(([t, h]) => es.removeEventListener(t, h));
      es.close();
    };
  },

  /**
   * Mở raw EventSource cho phép caller quản lý reconnect + lắng nghe 'open'/'error'
   * để hiển thị trạng thái realtime. Caller chịu trách nhiệm đóng và tạo lại.
   */
  openEventSource(accountId: string = ZALO_ACCOUNT_ID): EventSource {
    const url = `${BRIDGE_URL}/api/all-platform/zalo/events?account_id=${encodeURIComponent(accountId)}`;
    return new EventSource(url, { withCredentials: false });
  },
};

// ── Multi-account helpers (Phase 2) ─────────────────────────────────────────
// CRUD qua Next.js route /api/zalo/accounts (proxy → zalo-bridge + mirror Supabase).
// Đặt ngoài zaloApi để tránh nhầm với các method legacy hardcode shop-owner.

export type ZaloAccountSummary = {
  account_id: string;
  display_name: string;
  status: "connected" | "waiting_qr" | "disconnected" | "error";
  zalo_user_id?: string | null;
  zalo_display_name?: string | null;
  inbox_id?: number | string | null;
  is_ws_connected?: boolean;
  owner_staff_id?: string | null;
  phone?: string | null;
  last_seen_at?: string | null;
  last_error?: string | null;
  metadata?: Record<string, unknown>;
};

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    throw new ZaloApiError(text || `HTTP ${res.status}`, res.status);
  }
  return res.json() as Promise<T>;
}

export const zaloAccountsApi = {
  async list(): Promise<{ accounts: ZaloAccountSummary[] }> {
    const res = await fetch("/api/zalo/accounts", { cache: "no-store" });
    return readJson(res);
  },
  async get(accountId: string): Promise<ZaloAccountSummary> {
    const res = await fetch(`/api/zalo/accounts/${encodeURIComponent(accountId)}`, {
      cache: "no-store"
    });
    return readJson(res);
  },
  async create(payload: {
    accountId: string;
    displayName: string;
    inboxId?: number;
    ownerStaffId?: string | null;
  }): Promise<{ account: ZaloAccountSummary }> {
    const res = await fetch("/api/zalo/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return readJson(res);
  },
  async update(
    accountId: string,
    payload: {
      displayName?: string;
      ownerStaffId?: string | null;
      phone?: string | null;
    }
  ): Promise<{ account: ZaloAccountSummary }> {
    const res = await fetch(`/api/zalo/accounts/${encodeURIComponent(accountId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return readJson(res);
  },
  async remove(accountId: string): Promise<{ removed: boolean }> {
    const res = await fetch(`/api/zalo/accounts/${encodeURIComponent(accountId)}`, {
      method: "DELETE"
    });
    return readJson(res);
  }
};

export type StaffRecord = {
  id: string;
  email: string;
  full_name: string;
  role: "admin" | "staff";
  is_active: boolean;
  avatar_url?: string | null;
  created_at: string;
};

export type StaffAssignment = {
  staff_id: string;
  account_id: string;
  can_view: boolean;
  can_send: boolean;
  can_broadcast: boolean;
};

export const zaloStaffApi = {
  async list(): Promise<{ staff: StaffRecord[]; assignments: StaffAssignment[] }> {
    const res = await fetch("/api/zalo/staff", { cache: "no-store" });
    return readJson(res);
  },
  async upsert(payload: { email: string; full_name: string; role?: "admin" | "staff" }) {
    const res = await fetch("/api/zalo/staff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return readJson(res);
  },
  async assign(
    staffId: string,
    payload: {
      account_id: string;
      can_view?: boolean;
      can_send?: boolean;
      can_broadcast?: boolean;
    }
  ) {
    const res = await fetch(
      `/api/zalo/staff/${encodeURIComponent(staffId)}/assign`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }
    );
    return readJson(res);
  },
  async unassign(staffId: string, accountId: string) {
    const res = await fetch(
      `/api/zalo/staff/${encodeURIComponent(staffId)}/assign?account_id=${encodeURIComponent(accountId)}`,
      { method: "DELETE" }
    );
    return readJson(res);
  }
};

// ── Auth API (Phase 3) ──────────────────────────────────────────────────────
// Login/logout cho staff. Đơn giản hóa: chỉ switch user qua cookie, không có
// password (cookie-based cho demo nội bộ). Sau này có thể thay bằng OAuth/JWT.
//
// Session được lưu ở cookie `current_staff_id` (HttpOnly=false để client đọc
// được). Tất cả route /api/zalo/* đọc cookie này qua getCurrentStaff() để:
//   - Filter conversations/messages theo assigned accounts
//   - Ghi log staff_id khi gửi/broadcast
//   - Phân quyền admin/staff

export type CurrentStaff = {
  id: string | null;
  email: string;
  full_name: string;
  role: "admin" | "staff" | "system";
  assignments: Array<{
    account_id: string;
    can_view: boolean;
    can_send: boolean;
    can_broadcast: boolean;
  }>;
};

export const zaloAuthApi = {
  async me(): Promise<{ staff: CurrentStaff; has_session: boolean }> {
    const res = await fetch("/api/auth/zalo/me", { cache: "no-store" });
    if (!res.ok) {
      return {
        staff: {
          id: null,
          email: "",
          full_name: "Chưa đăng nhập",
          role: "system",
          assignments: []
        },
        has_session: false
      };
    }
    const data = (await res.json()) as { staff?: CurrentStaff; has_session?: boolean };
    return {
      staff: data.staff || {
        id: null,
        email: "",
        full_name: "Chưa đăng nhập",
        role: "system",
        assignments: []
      },
      has_session: !!data.has_session
    };
  },
  async login(staffId: string, password: string): Promise<{ ok: true; staffId: string }> {
    const res = await fetch("/api/auth/zalo/me", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ staffId, password }),
      credentials: "include"
    });
    return readJson(res);
  },
  async logout(): Promise<{ ok: true }> {
    const res = await fetch("/api/auth/zalo/me", {
      method: "DELETE",
      credentials: "include"
    });
    return readJson(res);
  }
};

// ── Forward rules API ("nhóm chính" auto-forward) ───────────────────────────
// CRUD qua Next.js route /api/zalo/forward-rules (đọc/ghi Supabase trực tiếp).
// Bridge chỉ đọc bảng này (cache 8s) để tự forward — xem forwardEngine.js.

export type ZaloForwardTarget = {
  id?: number;
  rule_id?: number;
  target_thread_id: string;
  target_thread_name?: string | null;
  is_enabled?: boolean;
};

export type ZaloForwardRule = {
  id: number;
  account_id: string;
  name: string | null;
  master_thread_id: string;
  master_thread_name: string | null;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
  targets: ZaloForwardTarget[];
};

export type ZaloForwardLog = {
  id: number;
  rule_id: number | null;
  account_id: string;
  source_thread_id: string;
  source_msg_id: string | null;
  target_thread_id: string;
  content_type: string;
  status: string;
  error: string | null;
  created_at: string;
};

export const zaloForwardRulesApi = {
  async list(accountId: string = ZALO_ACCOUNT_ID): Promise<{ rules: ZaloForwardRule[] }> {
    const res = await fetch(
      `/api/zalo/forward-rules?account_id=${encodeURIComponent(accountId)}`,
      { cache: "no-store" }
    );
    return readJson(res);
  },
  async create(payload: {
    account_id?: string;
    name?: string;
    master_thread_id: string;
    master_thread_name?: string;
    targets: Array<{ target_thread_id: string; target_thread_name?: string }>;
    is_enabled?: boolean;
  }): Promise<{ rule: ZaloForwardRule }> {
    const res = await fetch("/api/zalo/forward-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: ZALO_ACCOUNT_ID, ...payload })
    });
    return readJson(res);
  },
  async update(
    ruleId: number,
    payload: {
      name?: string | null;
      is_enabled?: boolean;
      master_thread_id?: string;
      master_thread_name?: string | null;
      targets?: Array<{ target_thread_id: string; target_thread_name?: string }>;
    }
  ): Promise<{ ok: true }> {
    const res = await fetch(`/api/zalo/forward-rules/${ruleId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return readJson(res);
  },
  async remove(ruleId: number): Promise<{ ok: true }> {
    const res = await fetch(`/api/zalo/forward-rules/${ruleId}`, { method: "DELETE" });
    return readJson(res);
  },
  async logs(ruleId: number, limit = 30): Promise<{ logs: ZaloForwardLog[] }> {
    const res = await fetch(`/api/zalo/forward-rules/${ruleId}/logs?limit=${limit}`, {
      cache: "no-store"
    });
    return readJson(res);
  }
};

export default zaloApi;