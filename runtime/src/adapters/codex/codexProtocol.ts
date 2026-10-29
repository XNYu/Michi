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

/**
 * Codex features every Michi thread runs with off. `goals` lets the model
 * (create_goal) or a client (thread/goal/set) give a thread an objective that
 * app-server then pursues in turns it starts itself, with the thread's last
 * approval and sandbox policy. Michi does not consume self-started Codex
 * turns (topology.backgroundTurns false), so they would run unseen; codex
 * 0.165 drops the goal tools and the continuation when this is off.
 */
export const CODEX_THREAD_FEATURES_OFF: Readonly<Record<string, false>> = Object.freeze({ goals: false });

/**
 * The MCP server names a `config/read` answer defines (the user's, project
 * and managed layers merged for that cwd). app-server is spawned with
 * `-c mcp_servers={}`, but codex 0.165 merges that empty table instead of
 * replacing it, so these servers still start unless a thread disables them.
 */
export function codexConfiguredMcpServers(read: unknown): string[] {
  const servers = (read as { config?: { mcp_servers?: unknown } } | null | undefined)?.config?.mcp_servers;
  return servers && typeof servers === 'object' && !Array.isArray(servers) ? Object.keys(servers) : [];
}

/**
 * `base` (a thread config) with each named server disabled, the host's own
 * server kept as `base` defines it. Only servers the effective config
 * defines can be named: an entry without a transport fails the whole config,
 * so a plugin's server (which config/read does not list) cannot be.
 */
export function codexDisableMcpServers(base: Record<string, unknown>, names: readonly string[]): Record<string, unknown> {
  const baseServers = base.mcp_servers && typeof base.mcp_servers === 'object' && !Array.isArray(base.mcp_servers)
    ? base.mcp_servers as Record<string, unknown> : {};
  const disabled = Object.fromEntries(names
    .filter((name) => name !== CODEX_HOST_MCP_SERVER)
    .map((name) => [name, { enabled: false }]));
  if (Object.keys(disabled).length === 0) return base;
  return { ...base, mcp_servers: { ...disabled, ...baseServers } };
}

/** Servers other than the host's that a thread's `mcpServerStatus/list` reports as not disabled. */
export function codexOpenUserMcpServers(statuses: ReadonlyArray<{ name?: unknown; runtimeStatus?: unknown }>): string[] {
  return statuses
    .filter((status) => status.name !== CODEX_HOST_MCP_SERVER && status.runtimeStatus !== 'disabled')
    .map((status) => String(status.name ?? '(unnamed)'));
}

/** `collaborationMode/list` (experimental API) and the mode kinds turn/start accepts. */
export const CODEX_COLLABORATION_MODE_LIST = 'collaborationMode/list';
export type CodexModeKind = 'plan' | 'default';
export const CODEX_MODE_KINDS: readonly CodexModeKind[] = Object.freeze(['default', 'plan']);

export function isCodexModeKind(value: unknown): value is CodexModeKind {
  return value === 'plan' || value === 'default';
}

/** One entry of `collaborationMode/list` (CollaborationModeMask). */
export interface CodexCollaborationModeMask {
  name: string;
  mode: CodexModeKind | null;
  model: string | null;
  reasoning_effort: string | null;
}

/**
 * turn/start `collaborationMode`. Codex keeps the last mode a thread was
 * given, so a session that has chosen one sends it on every turn.
 * `developer_instructions: null` selects the mode's built-in instructions;
 * the thread's own developer instructions still apply.
 */
export function buildCodexCollaborationMode(mode: CodexModeKind, model: string, effort: string | null) {
  return { mode, settings: { model, reasoning_effort: effort, developer_instructions: null } };
}

/**
 * Whether `account/read` (GetAccountResponse) says the configured provider
 * needs an OpenAI login that is missing. Providers with their own
 * credentials (Amazon Bedrock, API-key env auth) report
 * `requiresOpenaiAuth: false` or an account; anything unrecognized passes.
 */
export function codexAccountLoginMissing(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const read = result as { requiresOpenaiAuth?: unknown; account?: unknown };
  return read.requiresOpenaiAuth === true && (read.account === null || read.account === undefined);
}

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
