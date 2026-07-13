import { UserMessage } from "../models/index.js";
export type GetUserChatHistoryResponse = {
    lastActionId: string;
    lastActionIdOther: string;
    more: number;
    msgs: UserMessage[];
};
export declare const getUserChatHistoryFactory: (ctx: import("../context.js").ContextBase, api: import("../apis.js").API) => (userId: string, count?: number, globalMsgId?: string) => Promise<GetUserChatHistoryResponse>;
