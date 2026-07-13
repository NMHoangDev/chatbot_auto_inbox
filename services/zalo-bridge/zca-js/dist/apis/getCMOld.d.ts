export type CMOldMessage = {
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
    at: number;
    cmd: number;
    st: number;
    fromD: string;
    toD: string;
    quote?: Record<string, unknown>;
};
export type GetCMOldResponse = {
    msgs?: CMOldMessage[];
    groupMsgs?: CMOldMessage[];
    hasMore: boolean;
    disabled?: boolean;
    reason?: string;
};
export declare const getCMOldFactory: (ctx: import("../context.js").ContextBase, api: import("../apis.js").API) => (threadId: string, globalMsgId?: string | number, count?: number, isGroup?: boolean, isOA?: boolean) => Promise<{
    msgs: never[];
    groupMsgs: never[];
    hasMore: boolean;
    disabled: boolean;
    reason: string;
}>;
