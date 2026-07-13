import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { apiFactory } from "../utils.js";
export const getCMOldFactory = apiFactory()((api, ctx, utils) => {
    /**
     * Get older messages for a specific conversation from CM API.
     * This endpoint is currently disabled/unreversed.
     * Returns a structured disabled response to trigger fallback modes cleanly.
     *
     * @param threadId The conversation thread ID (group ID or user ID)
     * @param globalMsgId The cursor message ID — fetch messages older than this
     * @param count Number of messages to fetch (default: 50)
     * @param isGroup Whether this is a group conversation
     */
    return async function getCMOld(threadId, globalMsgId = 0, count = 50, isGroup = true, isOA) {
        return {
            msgs: [],
            groupMsgs: [],
            hasMore: false,
            disabled: true,
            reason: "CM_OLD_NOT_REVERSED",
        };
    };
});
