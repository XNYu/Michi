// Claude Code's tool names as the canonical tool names of tool profiles and
// the Agent Run permission broker. Chat grant keys are the host's
// (permissions.grantKey).

import { MICHI_MCP_TOOL_PREFIX } from './claudeMcpConfig';

export { MICHI_MCP_TOOL_PREFIX };

/** PascalCase write and execution tools. */
const WRITE_EXEC_ALIASES = new Map([
  ['Bash', 'bash'],
  ['Edit', 'edit'],
  ['Write', 'write'],
  ['MultiEdit', 'edit'],
  ['NotebookEdit', 'edit'],
]);

/**
 * Read-only tools. Unlike the write and exec tools, a chat grant for one of
 * them is stored under the SDK name (see the host's grant key).
 */
const READ_ALIASES = new Map([
  ['Read', 'read'],
  ['Glob', 'find'],
  ['Grep', 'grep'],
]);

/** The canonical name of a Claude tool: Michi's MCP prefix removed, SDK built-ins mapped onto Michi's names. */
export function canonicalClaudeToolName(toolName: string): string {
  const bare = toolName.startsWith(MICHI_MCP_TOOL_PREFIX) ? toolName.slice(MICHI_MCP_TOOL_PREFIX.length) : toolName;
  return READ_ALIASES.get(bare) ?? WRITE_EXEC_ALIASES.get(bare) ?? bare;
}
