const CODEX_MICHI_MCP_SERVER = '__michi_internal__';
function isPlainObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
export const CODEX_META_AGENT_UNREMOVABLE_TOOLS: readonly string[] = Object.freeze([
  'image_generation', 'view_image', 'goals', 'request_user_input',
]);

export function codexMetaAgentCatalog(
  statuses: ReadonlyArray<{ name?: unknown; runtimeStatus?: unknown; tools?: unknown }>,
): string[] {
  const prefix = `mcp__${CODEX_MICHI_MCP_SERVER}__`;
  const bare = (key: string, tool: unknown) => {
    const name = tool && typeof tool === 'object' && typeof (tool as { name?: unknown }).name === 'string'
      ? (tool as { name: string }).name : key;
    return name.startsWith(prefix) ? name.slice(prefix.length) : name;
  };
  const observed: string[] = [];
  for (const status of statuses) {
    if (status.name === CODEX_MICHI_MCP_SERVER) {
      const tools = status.tools;
      if (Array.isArray(tools)) observed.push(...tools.map((tool) => bare(String(tool), tool)));
      else if (isPlainObject(tools)) observed.push(...Object.entries(tools).map(([key, tool]) => bare(key, tool)));
    } else if (status.runtimeStatus !== 'disabled') {
      observed.push(`mcp_server:${String(status.name ?? '(unnamed)')}`);
    }
  }
  return observed;
}
