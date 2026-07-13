import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { apiFactory } from "../utils.js";
import { UserMessage } from "../models/index.js";
export const getUserChatHistoryFactory = apiFactory()((api, ctx, utils) => {
    const serviceURL = utils.makeURL(`${api.zpwServiceMap.chat[0]}/api/message/history`);
    /**
     * Get user (personal/DM) chat history
     *
     * @param userId user id to get chat history with
     * @param count count of messages to return (default: 50)
     * @param globalMsgId last message global id for pagination (optional)
     *
     * @throws {ZaloApiError}
     */
    return async function getUserChatHistory(userId, count = 50, globalMsgId) {
        const params = {
            toid: userId,
            count: count,
            imei: ctx.imei,
        };
        if (globalMsgId) {
            params.globalmsgid = globalMsgId;
        }
        const encryptedParams = utils.encodeAES(JSON.stringify(params));
        if (!encryptedParams)
            throw new ZaloApiError("Failed to encrypt params");
        const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), {
            method: "GET",
        });
        return utils.resolve(response, (result) => {
            let data = result.data;
            if (typeof data === "string") {
                data = JSON.parse(data);
            }
            for (let i = 0; i < data.msgs.length; i++) {
                data.msgs[i] = new UserMessage(ctx.uid, data.msgs[i]);
            }
            return data;
        });
    };
});
