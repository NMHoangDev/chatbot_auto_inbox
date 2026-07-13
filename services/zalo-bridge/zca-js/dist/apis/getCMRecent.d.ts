export type CMRecentMessage = {
    globalMsgId: string;
    cliMsgId: string;
    msgId: string;
    uidFrom: string;
    idTo: string;
    dName: string;
    ts: number;
    status: number;
    msgType: string;
    content: string | Record<string, unknown>;
    notify: string;
    ttl: number;
    userId: string;
    uin: string;
    topOut: number;
    seq: number;
    at: number;
    cmd: number;
    st: number;
    fromD: string;
    toD: string;
};
export type CMRecentConversation = {
    threadId: string;
    type: number;
    lastMsgs: CMRecentMessage[];
    updateTime: number;
    [key: string]: unknown;
};
export type GetCMRecentResponse = {
    conversations: CMRecentConversation[];
    hasMore: boolean;
    lastTime?: number;
};
export declare const getCMRecentFactory: (ctx: import("../context.js").ContextBase, api: import("../apis.js").API) => (count?: number, lastTime?: number) => Promise<GetCMRecentResponse>;
