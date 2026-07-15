/**
 * Hand-curated wire surface of the codex app-server v2 protocol — the ONLY
 * protocol import for runtime code. Strings pinned against codex-cli 0.138.0-alpha.7.
 */

export const CODEX_NOTIFICATIONS = {
  threadStarted: 'thread/started',
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  agentMessageDelta: 'item/agentMessage/delta',
  reasoningTextDelta: 'item/reasoning/textDelta',
  reasoningSummaryTextDelta: 'item/reasoning/summaryTextDelta',
  commandOutputDelta: 'item/commandExecution/outputDelta',
  fileChangeOutputDelta: 'item/fileChange/outputDelta',
  planDelta: 'item/plan/delta',
  turnPlanUpdated: 'turn/plan/updated',
  tokenUsageUpdated: 'thread/tokenUsage/updated',
  mcpStartupStatus: 'mcpServer/startupStatus/updated',
  error: 'error',
} as const;

export const CODEX_SERVER_REQUESTS = {
  commandApproval: 'item/commandExecution/requestApproval',
  fileChangeApproval: 'item/fileChange/requestApproval',
  permissionsApproval: 'item/permissions/requestApproval',
} as const;

export type CodexApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export const CODEX_TOOL_ITEM_TYPES = new Set([
  'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch',
]);
export const CODEX_STREAMED_ITEM_TYPES = new Set(['agentMessage', 'reasoning']);

export type CodexRpcId = string | number;

export interface CodexRpcRequest {
  jsonrpc: '2.0';
  id: CodexRpcId;
  method: string;
  params?: unknown;
}
export interface CodexRpcResponse {
  id: CodexRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}
export interface CodexRpcNotification {
  method: string;
  params?: Record<string, unknown>;
}
export type CodexIncoming = Partial<CodexRpcResponse & CodexRpcNotification> & Record<string, unknown>;

export interface CodexModel {
  id: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  defaultReasoningEffort: string;
}

export function buildCodexMcpConfig(
  slotId: string,
  port: number,
  options: { enableFollowUpsTool?: boolean } = {},
): Record<string, unknown> {
  return {
    mcp_servers: {
      __michi_internal__: {
        url: `http://127.0.0.1:${port}/api/mcp/${slotId}`,
        // Codex 0.144+ rejects the legacy `auth: "none"` value. An
        // unauthenticated local HTTP MCP omits auth and still requires the
        // headers array to be present, even when empty.
        headers: [],
        // Structured metadata is an internal, non-destructive callback. If
        // Codex prompts for it, a Stop-hook repair cannot complete headlessly.
        // Keep the exemption tool-specific; all other MCP tools retain Codex's
        // normal approval behavior.
        tools: {
          set_branch_overview: { approval_mode: 'approve' },
          ...(options.enableFollowUpsTool
            ? { set_follow_ups: { approval_mode: 'approve' } }
            : {}),
        },
      },
    },
  };
}
