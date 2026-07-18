import { MICHI_INTERNAL_MCP_NAME } from './claudeMcpConfig';
import type { FollowUpsExperimentMode } from '../followUpsExperiment';
import { resolveFollowUpsExperimentMode } from '../followUpsExperiment';

export const CLAUDE_FOLLOW_UPS_HOOK_POC_ENV = 'MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC';

const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function isClaudeFollowUpsHookPocEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return ENABLED_VALUES.has((env[CLAUDE_FOLLOW_UPS_HOOK_POC_ENV] ?? '').trim().toLowerCase());
}

/** Build the mode-specific metadata contract appended after the stable prompt. */
export function buildClaudeFollowUpsHookPocInstruction(
  mode: FollowUpsExperimentMode = resolveFollowUpsExperimentMode(),
): string {
  const followUpsInstruction = mode === 'hook-tool'
    ? `- Before ending every real user turn, call the MCP tool mcp____michi_internal____set_follow_ups exactly once.
- Pass {"follow_ups":["...","...","..."]}: exactly three concise questions written in the user's voice and language.
- The structured tool call is canonical. Do not duplicate the follow-ups as textual fallback metadata.`
    : `- Do not call set_follow_ups. Follow-ups are delivered only through the three [FOLLOW-UP n/3: ...] sentinel lines.
- A strict sentinel reminder is appended to every real user turn.
- Emit all three follow-up sentinel lines before calling set_branch_overview.`;

  const overviewFallbackInstruction = mode === 'hook-tool'
    ? '- The structured overview tool call is canonical. Do not duplicate the overview as textual fallback metadata.'
    : `- Never emit a [BRANCH-OVERVIEW: ...] sentinel or put the overview in visible answer text.
- Call set_branch_overview only after [FOLLOW-UP 3/3: ...] has been emitted and closed.
- After the set_branch_overview tool result, emit no more visible text. The overview tail is background metadata work.`;

  return `

Claude Stop-hook POC — structured turn metadata:
- Before ending every real user turn, call the MCP tool mcp____michi_internal____set_branch_overview exactly once.
- Pass {"overview":"..."}: 1-3 concise sentences describing what this turn did — what was explored, decided, or discovered — matching the user's language. Entries accumulate into the branch's journal; do not restate earlier turns.
${overviewFallbackInstruction}
${followUpsInstruction}
- Do not call validate_turn_metadata or validate_follow_ups yourself; Claude Code invokes validation automatically from the Stop hook.`;
}

/** Backward-compatible export for tests/callers that want the experiment
 * default (sentinel) instruction. */
export const CLAUDE_FOLLOW_UPS_HOOK_POC_INSTRUCTION =
  buildClaudeFollowUpsHookPocInstruction('sentinel');

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
