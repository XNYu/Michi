export const MICHI_INTERNAL_MCP_NAME = '__michi_internal__';

/**
 * Build the inline --mcp-config JSON string for a claude subprocess.
 * The slotId is embedded in the URL so the MCP endpoint can route the
 * call back to the owning session's callbacks.
 *
 * claude exposes tools from this server as mcp____michi_internal____<tool>
 * e.g. mcp____michi_internal____approve
 */
export function buildClaudeMcpConfig(slotId: string, port: number): string {
  return JSON.stringify({
    mcpServers: {
      [MICHI_INTERNAL_MCP_NAME]: {
        type: 'http',
        url: `http://127.0.0.1:${port}/api/mcp/${slotId}`,
      },
    },
  });
}
