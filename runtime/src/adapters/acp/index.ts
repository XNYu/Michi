// Public entry of the generic ACP client core (`michi-runtime/adapters/acp`):
// the process, JSON-RPC transport and session machinery an ACP adapter
// extends, driven by an AcpProfile. The Kiro adapter is built on it.
export { AcpClient } from './client';
export type { AcpCoreOptions, AcpPendingRequest, SessionQueue, SessionQueueItem } from './client';
export {
    ACPError, ACPNativeSessionMissingError, ACPNotRunningError, ACPProcessExitedError, ACPRequestNotSentError,
    ACPSessionRecoveryRequiredError, ACPUnsupportedMethodError,
} from './errors';
export type { ACPErrorDetails } from './errors';
export type {
    AcpAgentCapabilities, AcpAuthMethod, AcpCancelOptions, AcpClientInfo, AcpConfigOption, AcpConfigValue,
    AcpHandlerContext, AcpIncomingMessage, AcpIncomingNotification, AcpIncomingRequest, AcpInitializeResult,
    AcpMcpAttach, AcpMcpCapabilities, AcpMcpServer, AcpPermissionRequest, AcpProfile, AcpPromptBlock,
    AcpPromptCapabilities, AcpRpcErrorPayload, AcpSessionInfo, AcpSessionOptions, AcpUpdate, AcpUserAnswer,
} from './types';
