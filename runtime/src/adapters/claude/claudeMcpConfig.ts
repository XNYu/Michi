import type { McpHttpEndpoint } from '../../contract/mcp';

export const MICHI_INTERNAL_MCP_NAME = '__michi_internal__';

/** How Claude names a tool of Michi's MCP server: mcp____michi_internal____<tool>. */
export const MICHI_MCP_TOOL_PREFIX = `mcp__${MICHI_INTERNAL_MCP_NAME}__`;

/** The bare Michi tool name of a Claude tool call, or null when the tool is not Michi's. */
export function michiMcpToolName(toolName: string): string | null {
  if (!toolName.startsWith(MICHI_MCP_TOOL_PREFIX)) return null;
  const bare = toolName.slice(MICHI_MCP_TOOL_PREFIX.length);
  return bare || null;
}

/**
 * MCP servers a Claude system/init envelope lists besides Michi's own, which
 * a session restricted to Michi's server may not have. A missing list counts
 * as one, so a caller that refuses on any fails closed.
 */
export function unexpectedClaudeInitServers(servers: unknown): string[] {
  if (!Array.isArray(servers)) return ['(no MCP server list)'];
  return servers
    .map((server) => (server && typeof server === 'object' ? (server as { name?: unknown }).name : server))
    .filter((name) => name !== MICHI_INTERNAL_MCP_NAME)
    .map((name) => `MCP server ${typeof name === 'string' ? name : String(name)}`);
}

/**
 * Everything a Claude system/init envelope reports, in Meta agent catalog
 * terms: Michi's tools by bare name, any other tool as `native:<name>`,
 * other MCP servers, and a permission mode other than default. A missing
 * list or mode stays an entry, so a check against an allow-list fails
 * closed. Other fields (plugins, skills, agent types, slash commands) name
 * nothing the session can call without a tool.
 */
export function claudeInitCatalog(envelope: Record<string, unknown>): string[] {
  const tools = envelope['tools'];
  return [
    ...(Array.isArray(tools)
      ? tools.map((tool) => { const name = String(tool); return michiMcpToolName(name) ?? `native:${name}`; })
      : ['(no tool list)']),
    ...unexpectedClaudeInitServers(envelope['mcp_servers']),
    ...(envelope['permissionMode'] === 'default' ? [] : [`permission mode ${String(envelope['permissionMode'])}`]),
  ];
}

/** Commander's answer to a flag the installed Claude Code does not have. */
export function claudeLacksToolsFlag(stderr: string): boolean {
  return /unknown option ['"`]?--tools\b/i.test(stderr);
}

/** The same for --restricted (see ClaudeSpawnPolicy.restrictedMode). */
export function claudeLacksRestrictedFlag(stderr: string): boolean {
  return /unknown option ['"`]?--restricted(?![\w-])/i.test(stderr);
}

/**
 * Build the inline --mcp-config JSON string for a claude subprocess from the
 * slot's endpoint (McpSlotProvider.endpoint): its URL routes the call back to
 * the owning session's callbacks. Claude's entry carries the URL only, no
 * headers.
 *
 * claude exposes tools from this server as mcp____michi_internal____<tool>
 * e.g. mcp____michi_internal____approve
 * `alwaysLoad` is scoped to Michi's metadata Hook modes so the hidden overview
 * tool is available without a ToolSearch round-trip while unrelated MCP
 * servers stay eligible for Claude Code's deferred loading.
 */
export function buildClaudeMcpConfig(
  endpoint: Pick<McpHttpEndpoint, 'url'>,
  options: { alwaysLoad?: boolean } = {},
): string {
  return JSON.stringify({
    mcpServers: {
      [MICHI_INTERNAL_MCP_NAME]: {
        type: 'http',
        url: endpoint.url,
        ...(options.alwaysLoad ? { alwaysLoad: true } : {}),
      },
    },
  });
}
