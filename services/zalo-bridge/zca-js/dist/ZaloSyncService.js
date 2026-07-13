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
import { Zalo } from "./zalo.js";
import { ThreadType } from "./models/index.js";
import { CloseReason } from "./apis/listen.js";
// ========== Service ==========
export class ZaloSyncService extends EventEmitter {
    constructor(options = {}) {
        super();
        this.api = null;
        this.startTime = 0;
        this.isListening = false;
        this.credentials = null;
        this.options = Object.assign({ crawlDelay: 500, fetchMissedOnReconnect: true }, options);
        this.zalo = new Zalo(options);
    }
    // ========== Login Methods ==========
    /**
     * Login with saved credentials (cookie/imei/userAgent)
     * Use this to avoid re-scanning QR code
     */
    async loginWithCredentials(credentials) {
        this.credentials = credentials;
        this.api = await this.zalo.login(credentials);
        return this.api;
    }
    /**
     * Login with QR code
     * Returns credentials that can be saved for future logins
     */
    async loginWithQR(options, callback) {
        // Intercept the callback to capture credentials
        let savedCreds = null;
        const wrappedCallback = (event) => {
            if (event.type === 4 /* GotLoginInfo */) {
                savedCreds = {
                    imei: event.data.imei,
                    cookie: event.data.cookie,
                    userAgent: event.data.userAgent,
                    savedAt: Date.now(),
                };
                this.credentials = savedCreds;
                this.emit("credentials_ready", savedCreds);
            }
            if (callback)
                callback(event);
        };
        this.api = await this.zalo.loginQR(options, wrappedCallback);
        if (!savedCreds) {
            throw new Error("Failed to capture credentials during QR login");
        }
        return { api: this.api, credentials: savedCreds };
    }
    // ========== Sync Control ==========
    /**
     * Start realtime message synchronization
     * Listens for all messages (personal + group) in realtime
     */
    async startSync() {
        if (!this.api)
            throw new Error("Not logged in. Call loginWithCredentials() or loginWithQR() first.");
        if (this.isListening)
            throw new Error("Already syncing");
        const listener = this.api.listener;
        this.startTime = Date.now();
        // Wire up all events
        listener.on("connected", () => {
            this.emit("connected");
        });
        listener.on("message", (message) => {
            this.emit("message", message);
            if (message.type === ThreadType.User) {
                this.emit("user_message", message);
            }
            else {
                this.emit("group_message", message);
            }
        });
        listener.on("old_messages", (messages, type) => {
            this.emit("old_messages", messages, type);
        });
        listener.on("reaction", (reaction) => this.emit("reaction", reaction));
        listener.on("typing", (typing) => this.emit("typing", typing));
        listener.on("undo", (data) => this.emit("undo", data));
        listener.on("seen_messages", (msgs) => this.emit("seen_messages", msgs));
        listener.on("delivered_messages", (msgs) => this.emit("delivered_messages", msgs));
        listener.on("friend_event", (data) => this.emit("friend_event", data));
        listener.on("group_event", (data) => this.emit("group_event", data));
        listener.on("disconnected", (code, reason) => {
            this.emit("disconnected", code, reason);
        });
        listener.on("reconnecting", (attempt, delay) => {
            this.emit("reconnecting", attempt, delay);
        });
        listener.on("reconnected", async () => {
            this.emit("reconnected");
            // Fetch missed messages after reconnect
            if (this.options.fetchMissedOnReconnect) {
                try {
                    await this.fetchMissedMessages();
                }
                catch (error) {
                    this.emit("error", error);
                }
            }
        });
        listener.on("closed", (code, reason) => {
            this.isListening = false;
            this.emit("closed", code, reason);
            this.emit("sync_stopped");
        });
        listener.on("error", (error) => {
            this.emit("error", error);
        });
        // Start listening with auto-retry
        listener.start({ retryOnClose: true });
        this.isListening = true;
        this.emit("sync_started");
    }
    /**
     * Stop realtime synchronization
     */
    stopSync() {
        if (this.api && this.isListening) {
            this.api.listener.stop();
            this.isListening = false;
            this.emit("sync_stopped");
        }
    }
    // ========== Chat History Crawling ==========
    /**
     * Crawl personal (DM) chat history with automatic pagination
     *
     * @param userId User ID to get chat history with
     * @param options Crawl options
     */
    async crawlUserChatHistory(userId, options = {}) {
        var _a, _b, _c, _d, _e;
        if (!this.api)
            throw new Error("Not logged in");
        const maxMessages = (_a = options.maxMessages) !== null && _a !== void 0 ? _a : 100;
        const delay = (_c = (_b = options.delay) !== null && _b !== void 0 ? _b : this.options.crawlDelay) !== null && _c !== void 0 ? _c : 500;
        let lastMsgId = options.startFromMsgId;
        let allMessages = [];
        let hasMore = true;
        try {
            // Try via HTTP API first
            while (allMessages.length < maxMessages && hasMore) {
                const batchSize = Math.min(50, maxMessages - allMessages.length);
                const result = await this.api.getUserChatHistory(userId, batchSize, lastMsgId);
                if (!result || !result.msgs || result.msgs.length === 0) {
                    hasMore = false;
                    break;
                }
                allMessages = allMessages.concat(result.msgs);
                hasMore = result.more === 1;
                if (hasMore && result.msgs.length > 0) {
                    const lastMsg = result.msgs[result.msgs.length - 1];
                    lastMsgId = ((_d = lastMsg.data) === null || _d === void 0 ? void 0 : _d.msgId) || lastMsgId;
                }
                // Rate limiting delay
                if (hasMore && allMessages.length < maxMessages) {
                    await this.sleep(delay);
                }
            }
        }
        catch (httpError) {
            // Fallback to WebSocket-based catchup if HTTP returns 404 or fails
            if (this.isListening) {
                let consecutiveEmptyBatches = 0;
                while (allMessages.length < maxMessages && hasMore) {
                    const wsMsgs = await this.api.listener.requestOldMessagesAsync(ThreadType.User, lastMsgId, 15000);
                    if (!wsMsgs || wsMsgs.length === 0) {
                        hasMore = false;
                        break;
                    }
                    // Filter messages belonging to this user thread
                    const batch = wsMsgs.filter(msg => msg.threadId === userId);
                    if (batch.length === 0) {
                        consecutiveEmptyBatches++;
                        if (consecutiveEmptyBatches >= 3) {
                            hasMore = false;
                            break;
                        }
                    }
                    else {
                        consecutiveEmptyBatches = 0;
                        allMessages = allMessages.concat(batch);
                    }
                    const lastGlobalMsg = wsMsgs[wsMsgs.length - 1];
                    lastMsgId = ((_e = lastGlobalMsg.data) === null || _e === void 0 ? void 0 : _e.msgId) || lastMsgId;
                    if (hasMore && allMessages.length < maxMessages) {
                        await this.sleep(delay);
                    }
                }
            }
            else {
                throw new Error(`Failed to crawl history via HTTP (${httpError.message}) and WebSocket listener is not active to attempt fallback. Please call startSync() first.`);
            }
        }
        return {
            messages: allMessages,
            totalFetched: allMessages.length,
            hasMore,
            lastMsgId,
        };
    }
    /**
     * Crawl group chat history with automatic pagination
     *
     * @param groupId Group ID to get chat history from
     * @param options Crawl options
     */
    async crawlGroupChatHistory(groupId, options = {}) {
        var _a, _b, _c, _d;
        if (!this.api)
            throw new Error("Not logged in");
        const maxMessages = (_a = options.maxMessages) !== null && _a !== void 0 ? _a : 100;
        const delay = (_c = (_b = options.delay) !== null && _b !== void 0 ? _b : this.options.crawlDelay) !== null && _c !== void 0 ? _c : 500;
        let lastMsgId = options.startFromMsgId;
        let allMessages = [];
        let hasMore = true;
        while (allMessages.length < maxMessages && hasMore) {
            const batchSize = Math.min(50, maxMessages - allMessages.length);
            const result = await this.api.getGroupChatHistory(groupId, batchSize);
            if (!result || !result.groupMsgs || result.groupMsgs.length === 0) {
                hasMore = false;
                break;
            }
            allMessages = allMessages.concat(result.groupMsgs);
            hasMore = result.more === 1;
            if (hasMore && result.groupMsgs.length > 0) {
                const lastMsg = result.groupMsgs[result.groupMsgs.length - 1];
                lastMsgId = ((_d = lastMsg.data) === null || _d === void 0 ? void 0 : _d.msgId) || lastMsgId;
            }
            // Rate limiting delay
            if (hasMore && allMessages.length < maxMessages) {
                await this.sleep(delay);
            }
        }
        return {
            messages: allMessages,
            totalFetched: allMessages.length,
            hasMore,
            lastMsgId,
        };
    }
    /**
     * Crawl old messages via WebSocket (Promise-based)
     * Works for both personal and group messages
     */
    async crawlOldMessagesViaWs(threadType, lastMsgId = null, timeoutMs = 10000) {
        if (!this.api)
            throw new Error("Not logged in");
        if (!this.isListening)
            throw new Error("Listener not started. Call startSync() first.");
        return this.api.listener.requestOldMessagesAsync(threadType, lastMsgId, timeoutMs);
    }
    // ========== Utility Methods ==========
    /**
     * Get all groups the user belongs to
     */
    async getAllGroups() {
        if (!this.api)
            throw new Error("Not logged in");
        return this.api.getAllGroups();
    }
    /**
     * Get all friends
     */
    async getAllFriends() {
        if (!this.api)
            throw new Error("Not logged in");
        return this.api.getAllFriends();
    }
    /**
     * Get group info
     */
    async getGroupInfo(groupId) {
        if (!this.api)
            throw new Error("Not logged in");
        return this.api.getGroupInfo(groupId);
    }
    /**
     * Send a message (personal or group)
     */
    async sendMessage(content, threadId, type = ThreadType.User) {
        if (!this.api)
            throw new Error("Not logged in");
        return this.api.sendMessage(content, threadId, type);
    }
    /**
     * Get current sync status
     */
    getStatus() {
        var _a, _b, _c, _d;
        const lastIds = (_b = (_a = this.api) === null || _a === void 0 ? void 0 : _a.listener.getLastMessageIds()) !== null && _b !== void 0 ? _b : { user: null, group: null };
        return {
            isConnected: (_d = (_c = this.api) === null || _c === void 0 ? void 0 : _c.listener.isConnected()) !== null && _d !== void 0 ? _d : false,
            isListening: this.isListening,
            reconnectAttempts: 0,
            lastUserMsgId: lastIds.user,
            lastGroupMsgId: lastIds.group,
            uptime: this.startTime > 0 ? Date.now() - this.startTime : 0,
        };
    }
    /**
     * Get the underlying API instance for advanced usage
     */
    getAPI() {
        return this.api;
    }
    /**
     * Get saved credentials (for persistence)
     */
    getSavedCredentials() {
        return this.credentials;
    }
    /**
     * Keep the connection alive (call periodically)
     */
    async keepAlive() {
        if (!this.api)
            throw new Error("Not logged in");
        return this.api.keepAlive();
    }
    // ========== Private Methods ==========
    /**
     * Fetch messages that might have been missed during a disconnection
     */
    async fetchMissedMessages() {
        if (!this.api || !this.isListening)
            return;
        try {
            // Fetch missed user messages
            const userMsgs = await this.api.listener.requestOldMessagesAsync(ThreadType.User, null, 15000);
            if (userMsgs.length > 0) {
                this.emit("missed_messages", userMsgs, ThreadType.User);
            }
        }
        catch (_a) {
            // Timeout or error fetching user messages — non-fatal
        }
        try {
            // Fetch missed group messages
            const groupMsgs = await this.api.listener.requestOldMessagesAsync(ThreadType.Group, null, 15000);
            if (groupMsgs.length > 0) {
                this.emit("missed_messages", groupMsgs, ThreadType.Group);
            }
        }
        catch (_b) {
            // Timeout or error fetching group messages — non-fatal
        }
    }
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
