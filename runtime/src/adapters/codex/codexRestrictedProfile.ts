import { CODEX_HOST_MCP_SERVER } from './codexProtocol';

/**
 * How a Codex session enforces the host's restricted profile
 * (SessionProfilePort.isRestricted): a restricted session may call only the
 * host's own tools. Its turns run read-only and offline, its thread starts
 * read-only with Codex's shell, plugins and other tools off and every MCP
 * server but the host's disabled, and every approval or elicitation is
 * declined. The thread config and MCP check below are Michi's assistant
 * lockdown (assistant/policy.ts re-exports them).
 */

export interface CodexTurnPolicy {
  approvalPolicy: string;
  sandboxPolicy: Record<string, unknown>;
}

/** turn/start policy of a restricted session: read-only, offline; approvals are declined. */
export const CODEX_RESTRICTED_TURN_POLICY: CodexTurnPolicy = Object.freeze({
  approvalPolicy: 'on-request',
  sandboxPolicy: Object.freeze({ type: 'readOnly', networkAccess: false }),
}) as CodexTurnPolicy;

/** thread/start and thread/resume `sandbox` of a session, from the host's restricted verdict. */
export function codexThreadSandbox(restricted: boolean): 'read-only' | 'workspace-write' {
  return restricted ? 'read-only' : 'workspace-write';
}

/**
 * Codex feature flags an assistant thread runs with off (keys as codex
 * 0.156.1 lists them in `codex features list`): the shell and exec tools,
 * the JavaScript REPL and code mode (code execution a user may have turned
 * on), the node REPL host, freeform apply_patch, plugins and apps (which
 * bring their own MCP servers), browser / computer use, sub-agents and tool
 * suggestions. image_generation is set off too, though 0.156.1 still offers
 * its image tool (which neither edits files nor runs commands).
 */
export const CODEX_RESTRICTED_FEATURES_OFF: Readonly<Record<string, false>> = Object.freeze({
  shell_tool: false,
  unified_exec: false,
  js_repl: false,
  js_repl_tools_only: false,
  code_mode: false,
  code_mode_only: false,
  code_mode_host: false,
  apply_patch_freeform: false,
  plugins: false,
  apps: false,
  browser_use: false,
  browser_use_external: false,
  computer_use: false,
  in_app_browser: false,
  image_generation: false,
  multi_agent: false,
  multi_agent_v2: false,
  tool_suggest: false,
  skill_mcp_dependency_install: false,
});

/**
 * An assistant thread's config: `base` (Michi's MCP slot and hooks) with the
 * features above off, web search off, and the named MCP servers (the user's,
 * from config/read) disabled. Michi's own server is never disabled. Only a
 * server the effective config defines can be named: an entry without a
 * transport fails the whole config.
 */
export function codexRestrictedThreadConfig(
  base: Record<string, unknown>,
  configuredMcpServers: readonly string[],
): Record<string, unknown> {
  const baseServers = isPlainObject(base.mcp_servers) ? base.mcp_servers : {};
  const disabled = Object.fromEntries(configuredMcpServers
    .filter((name) => name !== CODEX_HOST_MCP_SERVER)
    .map((name) => [name, { enabled: false }]));
  const baseFeatures = isPlainObject(base.features) ? base.features : {};
  return {
    ...base,
    features: { ...baseFeatures, ...CODEX_RESTRICTED_FEATURES_OFF },
    web_search: 'disabled',
    mcp_servers: { ...disabled, ...baseServers },
  };
}

export type CodexRestrictedMcpCheck =
  | { ok: true }
  /** `open`: servers still enabled. `fatal`: no retry can help (no list, or Michi's server missing). */
  | { ok: false; open: string[]; fatal: boolean; reason: string };

/**
 * Whether an assistant thread is locked down, from its mcpServerStatus/list
 * (null when Codex answered without a list): Michi's server must be listed
 * and every other server disabled. Fails closed on anything else.
 */
export function codexRestrictedMcpCheck(
  statuses: ReadonlyArray<{ name?: unknown; runtimeStatus?: unknown }> | null,
): CodexRestrictedMcpCheck {
  if (!statuses) return { ok: false, open: [], fatal: true, reason: 'Codex did not list the thread\'s MCP servers' };
  if (!statuses.some((status) => status.name === CODEX_HOST_MCP_SERVER)) {
    return { ok: false, open: [], fatal: true, reason: 'Michi\'s own MCP server is missing from the thread' };
  }
  const open = statuses
    .filter((status) => status.name !== CODEX_HOST_MCP_SERVER && status.runtimeStatus !== 'disabled')
    .map((status) => String(status.name ?? '(unnamed)'));
  if (open.length === 0) return { ok: true };
  return { ok: false, open, fatal: false, reason: `MCP servers Michi could not turn off: ${open.join(', ')}` };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
