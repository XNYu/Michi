import { MICHI_INTERNAL_MCP_NAME } from './claudeMcpConfig';

/** Inline --settings payload. The Stop hook asks Michi's already-connected MCP
 * slot whether all required metadata tools ran during the current real user turn. */
export function buildClaudeFollowUpsHookPocSettings(): string {
  return JSON.stringify({
    hooks: {
      Stop: [{
        hooks: [{
          type: 'mcp_tool',
          server: MICHI_INTERNAL_MCP_NAME,
          tool: 'validate_turn_metadata',
          input: {},
        }],
      }],
    },
  });
}
