/**
 * ZaloSyncService - Complete wrapper service for Zalo message synchronization
 *
 * Features:
 * - Realtime message sync (personal + group)
 * - Chat history crawling with pagination
 * - Auto-reconnect with exponential backoff
 * - Message gap detection on reconnect
 * - Credential persistence (avoid re-QR scan)
 * - Event-based architecture for web app integration
 *
 * Usage:
 * ```typescript
 * import { ZaloSyncService } from "./ZaloSyncService.js";
 *
 * const service = new ZaloSyncService({ logging: true });
 *
 * // Login with saved credentials or QR
 * await service.loginWithCredentials(savedCredentials);
 * // OR: const creds = await service.loginWithQR();
 *
 * // Listen for realtime messages
 * service.on("message", (msg) => console.log(msg));
 *
 * // Start sync
 * await service.startSync();
 *
 * // Crawl history
 * const userMsgs = await service.crawlUserChatHistory("USER_ID", { maxMessages: 200 });
 * const groupMsgs = await service.crawlGroupChatHistory("GROUP_ID", { maxMessages: 500 });
 * ```
 */
import EventEmitter from "events";
import { type Credentials, type API } from "./zalo.js";
import { ThreadType } from "./models/index.js";
import type { Message, UserMessage, GroupMessage } from "./models/Message.js";
import type { Reaction } from "./models/Reaction.js";
import type { Typing } from "./models/Typing.js";
import type { FriendEvent } from "./models/FriendEvent.js";
import type { GroupEvent } from "./models/GroupEvent.js";
import type { Undo } from "./models/Undo.js";
import type { SeenMessage } from "./models/SeenMessage.js";
import type { DeliveredMessage } from "./models/DeliveredMessage.js";
import { CloseReason, type AutoReconnectOptions } from "./apis/listen.js";
import type { LoginQRCallback } from "./apis/loginQR.js";
import type { Options } from "./context.js";
export type SyncServiceOptions = Partial<Options> & {
    /** Auto-reconnect configuration */
    autoReconnect?: Partial<AutoReconnectOptions>;
    /** Delay between crawl requests in ms to avoid rate limiting (default: 500) */
    crawlDelay?: number;
    /** Whether to fetch missed messages after reconnect (default: true) */
    fetchMissedOnReconnect?: boolean;
};
export type SavedCredentials = Credentials & {
    savedAt?: number;
};
export type CrawlOptions = {
    /** Maximum number of messages to crawl (default: 100) */
    maxMessages?: number;
    /** Starting message ID for pagination */
    startFromMsgId?: string;
    /** Delay between pagination requests in ms (default: 500) */
    delay?: number;
};
export type CrawlResult<T> = {
    messages: T[];
    totalFetched: number;
    hasMore: boolean;
    lastMsgId?: string;
};
export type SyncStatus = {
    isConnected: boolean;
    isListening: boolean;
    reconnectAttempts: number;
    lastUserMsgId: string | null;
    lastGroupMsgId: string | null;
    uptime: number;
};
interface SyncServiceEvents {
    message: [message: Message];
    user_message: [message: UserMessage];
    group_message: [message: GroupMessage];
    old_messages: [messages: Message[], type: ThreadType];
    reaction: [reaction: Reaction];
    typing: [typing: Typing];
    undo: [data: Undo];
    seen_messages: [messages: SeenMessage[]];
    delivered_messages: [messages: DeliveredMessage[]];
    friend_event: [data: FriendEvent];
    group_event: [data: GroupEvent];
    connected: [];
    disconnected: [code: CloseReason, reason: string];
    reconnecting: [attempt: number, delay: number];
    reconnected: [];
    closed: [code: CloseReason, reason: string];
    error: [error: unknown];
    sync_started: [];
    sync_stopped: [];
    credentials_ready: [credentials: SavedCredentials];
    missed_messages: [messages: Message[], type: ThreadType];
}
export declare class ZaloSyncService extends EventEmitter<SyncServiceEvents> {
    private zalo;
    private api;
    private options;
    private startTime;
    private isListening;
    private credentials;
    constructor(options?: SyncServiceOptions);
    /**
     * Login with saved credentials (cookie/imei/userAgent)
     * Use this to avoid re-scanning QR code
     */
    loginWithCredentials(credentials: SavedCredentials): Promise<API>;
    /**
     * Login with QR code
     * Returns credentials that can be saved for future logins
     */
    loginWithQR(options?: {
        userAgent?: string;
        language?: string;
        qrPath?: string;
    }, callback?: LoginQRCallback): Promise<{
        api: API;
        credentials: SavedCredentials;
    }>;
    /**
     * Start realtime message synchronization
     * Listens for all messages (personal + group) in realtime
     */
    startSync(): Promise<void>;
    /**
     * Stop realtime synchronization
     */
    stopSync(): void;
    /**
     * Crawl personal (DM) chat history with automatic pagination
     *
     * @param userId User ID to get chat history with
     * @param options Crawl options
     */
    crawlUserChatHistory(userId: string, options?: CrawlOptions): Promise<CrawlResult<UserMessage>>;
    /**
     * Crawl group chat history with automatic pagination
     *
     * @param groupId Group ID to get chat history from
     * @param options Crawl options
     */
    crawlGroupChatHistory(groupId: string, options?: CrawlOptions): Promise<CrawlResult<GroupMessage>>;
    /**
     * Crawl old messages via WebSocket (Promise-based)
     * Works for both personal and group messages
     */
    crawlOldMessagesViaWs(threadType: ThreadType, lastMsgId?: string | null, timeoutMs?: number): Promise<Message[]>;
    /**
     * Get all groups the user belongs to
     */
    getAllGroups(): Promise<import("./index.js").GetAllGroupsResponse>;
    /**
     * Get all friends
     */
    getAllFriends(): Promise<import("./index.js").GetAllFriendsResponse>;
    /**
     * Get group info
     */
    getGroupInfo(groupId: string): Promise<import("./index.js").GroupInfoResponse>;
    /**
     * Send a message (personal or group)
     */
    sendMessage(content: string, threadId: string, type?: ThreadType): Promise<{
        message: import("./index.js").SendMessageResult | null;
        attachment: import("./index.js").SendMessageResult[];
    }>;
    /**
     * Get current sync status
     */
    getStatus(): SyncStatus;
    /**
     * Get the underlying API instance for advanced usage
     */
    getAPI(): API | null;
    /**
     * Get saved credentials (for persistence)
     */
    getSavedCredentials(): SavedCredentials | null;
    /**
     * Keep the connection alive (call periodically)
     */
    keepAlive(): Promise<import("./index.js").KeepAliveResponse>;
    /**
     * Fetch messages that might have been missed during a disconnection
     */
    private fetchMissedMessages;
    private sleep;
}
export {};
