/** Explicit review decisions, not a claim that every official feature is implemented. */
export interface DispositionGroup {
  names: string[];
  disposition: 'handled' | 'partial' | 'compatibility' | 'ignored' | 'unsupported' | 'deferred';
  reason: string;
  test?: string;
}

// Both generators were run from the same binary with --experimental. Preserve
// the mismatch instead of editing either official artifact to make them agree.
export const tsOnlyNotifications: Record<string, string[]> = {
  '0.156.1': ['rawResponse/completed', 'rawResponseItem/completed'],
};

export const notifications: DispositionGroup[] = [
  { names: ['item/agentMessage/delta', 'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta',
    'item/commandExecution/outputDelta', 'item/mcpToolCall/progress'],
    disposition: 'handled', reason: 'Translate text, thought and tool activity deltas.', test: 'translator notifications' },
  { names: ['item/started', 'item/completed'], disposition: 'partial',
    reason: 'Per-item coverage below; authoritative text/diff/media reconciliation is deferred.', test: 'compact lifecycle' },
  { names: ['turn/started', 'turn/completed', 'error'], disposition: 'partial',
    reason: 'Active-turn lifecycle and terminal status; independent idle turns and retry UX are deferred.', test: 'terminal lifecycle' },
  { names: ['thread/tokenUsage/updated'], disposition: 'partial',
    reason: 'Active context uses last, not total; cache-write tokens and durable usage history are deferred.', test: 'translator notifications' },
  { names: ['thread/started', 'thread/status/changed', 'thread/closed'], disposition: 'partial',
    reason: 'Session discovers children; child reactivation and external parent lifecycle are deferred.' },
  { names: ['mcpServer/startupStatus/updated'], disposition: 'partial',
    reason: 'Active thread failures only; global/idle startup errors remain deferred.', test: 'translator notifications' },
  { names: ['serverRequest/resolved'], disposition: 'partial',
    reason: 'Suppress late replies and cancel local waits; permission-banner UI resolution remains deferred.', test: 'request identity' },
  { names: ['thread/compacted'], disposition: 'compatibility',
    reason: 'Deprecated end notification; prefer contextCompaction items.', test: 'compact lifecycle' },
  { names: ['item/fileChange/outputDelta'], disposition: 'compatibility',
    reason: 'Legacy apply_patch output; does not replace final changes/diff handling.', test: 'translator notifications' },
  { names: ['item/reasoning/summaryPartAdded'], disposition: 'ignored',
    reason: 'Summary boundaries are recovered from subsequent delta itemId and summaryIndex.' },
  { names: ['turn/plan/updated', 'item/plan/delta', 'turn/diff/updated', 'item/fileChange/patchUpdated',
    'item/commandExecution/terminalInteraction', 'hook/started', 'hook/completed'], disposition: 'deferred',
    reason: 'Audited gap: plan, patch and auxiliary activity still lack adapter mappings.' },
  { names: ['model/rerouted', 'model/verification', 'modelProvider/authRecoveryStarted',
    'modelProvider/authRecoveryCompleted', 'model/safetyBuffering/updated', 'warning', 'guardianWarning',
    'deprecationNotice', 'configWarning'], disposition: 'deferred',
    reason: 'Audited gap: model/auth/warning observability needs a scoped non-turn event path.' },
  { names: ['thread/name/updated', 'thread/settings/updated'], disposition: 'ignored',
    reason: 'Michi owns title/settings changes; external native changes are not synchronized.' },
  { names: ['thread/archived', 'thread/deleted', 'thread/unarchived', 'thread/reverted',
    'thread/attachment/updated', 'thread/goal/updated', 'thread/goal/cleared', 'thread/queue/changed',
    'project/changed', 'thread/project/updated', 'thread/environment/connected', 'thread/environment/disconnected'],
    disposition: 'ignored', reason: 'Native project, archive, goal, queue and environment APIs are not used.' },
  { names: ['item/autoApprovalReview/started', 'item/autoApprovalReview/completed', 'autoApprovalReview/strictReviewRequired'],
    disposition: 'ignored', reason: 'Runtime requests approvalsReviewer=user, not guardian review.' },
  { names: ['rawResponseItem/completed', 'rawResponse/completed'], disposition: 'ignored',
    reason: 'Raw-response subscription is not enabled; ResponseItem is not ThreadItem.' },
  { names: ['command/exec/outputDelta', 'process/outputDelta', 'process/exited', 'fs/changed'],
    disposition: 'ignored', reason: 'Standalone exec/process/fs APIs are not used.' },
  { names: ['mcpServer/oauthLogin/completed', 'mcpServer/event/stream/notification', 'account/updated',
    'account/rateLimits/updated', 'account/login/completed', 'app/list/updated', 'skills/changed',
    'remoteControl/status/changed', 'externalAgentConfig/import/progress', 'externalAgentConfig/import/completed',
    'turn/moderationMetadata'], disposition: 'ignored',
    reason: 'Native account/catalog/OAuth/import/remote-control/metadata UIs are outside this adapter.' },
  { names: ['fuzzyFileSearch/sessionUpdated', 'fuzzyFileSearch/sessionCompleted'], disposition: 'ignored',
    reason: 'Native fuzzy-search API is not used.' },
  { names: ['thread/realtime/started', 'thread/realtime/itemAdded', 'thread/realtime/item/started',
    'thread/realtime/item/transcript/delta', 'thread/realtime/item/completed', 'thread/realtime/transcript/delta',
    'thread/realtime/transcript/done', 'thread/realtime/outputAudio/delta', 'thread/realtime/sdp',
    'thread/realtime/error', 'thread/realtime/closed'], disposition: 'ignored', reason: 'Realtime API is not used.' },
  { names: ['windows/worldWritableWarning', 'windowsSandbox/setupCompleted'], disposition: 'deferred',
    reason: 'Windows-native sandbox status requires separate platform coverage.' },
];

export const requests: DispositionGroup[] = [
  { names: ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'], disposition: 'partial',
    reason: 'Basic approval decisions; availableDecisions and additional scope presentation remain deferred.', test: 'wire approvals' },
  { names: ['item/tool/requestUserInput'], disposition: 'partial',
    reason: 'ID-keyed answers, skip and duplicate labels; secrets fail closed, nonblocking/timeout UX deferred.', test: 'wire input' },
  { names: ['item/permissions/requestApproval'], disposition: 'unsupported',
    reason: 'Grant an empty subset until permission-profile UI and subset validation are implemented.', test: 'wire fallback' },
  { names: ['mcpServer/elicitation/request'], disposition: 'unsupported',
    reason: 'Decline forms and URL flows until actual input/verification is supported.', test: 'wire fallback' },
  { names: ['currentTime/read'], disposition: 'handled', reason: 'Whole Unix seconds.', test: 'wire fallback' },
  { names: ['item/tool/call', 'account/chatgptAuthTokens/refresh', 'attestation/generate', 'applyPatchApproval', 'execCommandApproval'],
    disposition: 'unsupported', reason: 'Not negotiated/registered, or legacy v1; return JSON-RPC method-not-found, never a command decision.', test: 'wire fallback' },
];

export const items: DispositionGroup[] = [
  { names: ['contextCompaction'], disposition: 'handled', reason: 'Active-turn compaction start/end.', test: 'compact lifecycle' },
  { names: ['commandExecution', 'fileChange'], disposition: 'partial',
    reason: 'Lifecycle and declined status; final file changes and rich command metadata still deferred.', test: 'terminal lifecycle' },
  { names: ['mcpToolCall', 'dynamicToolCall', 'webSearch'], disposition: 'partial',
    reason: 'Generic tool lifecycle only; authoritative dynamic content/search results still deferred.' },
  { names: ['agentMessage', 'reasoning'], disposition: 'partial', reason: 'Consume deltas; final reconciliation and message metadata deferred.' },
  { names: ['userMessage', 'hookPrompt'], disposition: 'ignored', reason: 'Avoid duplicating local user messages or exposing hook injections.' },
  { names: ['functionCallOutput', 'enteredReviewMode', 'exitedReviewMode'], disposition: 'ignored',
    reason: 'Standalone tool output and native review APIs are not used.' },
  { names: ['plan', 'collabAgentToolCall', 'subAgentActivity', 'imageView', 'sleep', 'imageGeneration'],
    disposition: 'deferred', reason: 'Audited native item rendering gap; not silently counted as supported.' },
];

export const consumedEnums: Record<string, Record<string, string>> = {
  CommandExecutionStatus: { inProgress: 'in_progress', completed: 'completed', failed: 'failed', declined: 'declined' },
  PatchApplyStatus: { inProgress: 'in_progress', completed: 'completed', failed: 'failed', declined: 'declined' },
  TurnStatus: { inProgress: 'start', completed: 'completed', failed: 'runtime_error', interrupted: 'cancelled' },
};

export const responseTypes: Record<string, string> = {
  'item/commandExecution/requestApproval': 'CommandExecutionRequestApprovalResponse',
  'item/fileChange/requestApproval': 'FileChangeRequestApprovalResponse',
  'item/tool/requestUserInput': 'ToolRequestUserInputResponse',
  'mcpServer/elicitation/request': 'McpServerElicitationRequestResponse',
  'item/permissions/requestApproval': 'PermissionsRequestApprovalResponse',
  'item/tool/call': 'DynamicToolCallResponse',
  'account/chatgptAuthTokens/refresh': 'ChatgptAuthTokensRefreshResponse',
  'attestation/generate': 'AttestationGenerateResponse',
  'currentTime/read': 'CurrentTimeReadResponse',
  applyPatchApproval: 'ApplyPatchApprovalResponse',
  execCommandApproval: 'ExecCommandApprovalResponse',
};
