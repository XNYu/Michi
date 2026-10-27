/**
 * Hand-curated wire surface of the codex app-server v2 protocol — the ONLY
 * protocol import for runtime code. Contract baseline: test/contracts/codex.
 */

import type { McpHttpEndpoint } from '../../contract/mcp';

export const CODEX_SERVER_REQUESTS = {
  commandApproval: 'item/commandExecution/requestApproval',
  fileChangeApproval: 'item/fileChange/requestApproval',
  permissionsApproval: 'item/permissions/requestApproval',
  requestUserInput: 'item/tool/requestUserInput',
  mcpElicitation: 'mcpServer/elicitation/request',
  currentTime: 'currentTime/read',
} as const;

export type CodexRpcId = string | number;

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

/** Name of the host's MCP server in a session's Codex config (a frozen external name). */
export const CODEX_HOST_MCP_SERVER = '__michi_internal__';

/** Thread config entry for the session's MCP slot; `endpoint` is the host's (McpSlotProvider.endpoint). */
export function buildCodexMcpConfig(
  endpoint: McpHttpEndpoint,
): Record<string, unknown> {
  return {
    mcp_servers: {
      [CODEX_HOST_MCP_SERVER]: {
        url: endpoint.url,
        // Codex 0.144+ rejects the legacy `auth: "none"` value. An
        // unauthenticated local HTTP MCP omits auth and still requires the
        // headers array to be present, even when empty.
        headers: [],
        // This server is implemented and scoped by Michi itself. Its tools
        // still enforce workspace/user boundaries internally, so Codex should
        // not add a second approval prompt in front of every invocation.
        default_tools_approval_mode: 'approve',
      },
    },
  };
}
