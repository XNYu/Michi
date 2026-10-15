export interface ACPErrorDetails {
    method?: string;
    sessionId?: string;
    rpcCode?: unknown;
    rpcData?: unknown;
}

export class ACPError extends Error {
    readonly method?: string;
    readonly sessionId?: string;
    readonly rpcCode?: unknown;
    readonly rpcData?: unknown;

    constructor(message: string, details: ACPErrorDetails = {}) {
        super(message);
        this.name = new.target.name;
        this.method = details.method;
        this.sessionId = details.sessionId;
        this.rpcCode = details.rpcCode;
        this.rpcData = details.rpcData;
    }
}
export class ACPNotRunningError extends ACPError {}
/** Only raised before writing a request, never for a pending request. */
export class ACPRequestNotSentError extends ACPNotRunningError {}
export class ACPProcessExitedError extends ACPError {}
export class ACPSessionRecoveryRequiredError extends ACPError {}
export class ACPNativeSessionMissingError extends ACPError {}
export class ACPUnsupportedMethodError extends ACPError {}
