import type { FollowUpsExperimentMode } from 'michi-runtime';

// Michi's product text for the Codex adapter, moved verbatim out of the
// adapter files. The adapter receives it through its options
// (CodexAdapterOptions.hostText, built by michiCodexOptions.ts).

/** Developer instructions of Codex's pre-turn title thread. */
export const TITLE_INSTRUCTIONS = `Create a concise title for the user's request before the main assistant begins working.
Do not answer the request, plan the work, use tools, or discuss your reasoning.
Match the user's language. Prefer 4-8 words for space-delimited languages or 8-20 characters for Chinese/Japanese.
Return only the JSON object required by the output schema.`;

export function buildCodexTurnMetadataInstruction(
  mode: FollowUpsExperimentMode,
  enableFollowUps: boolean = true,
): string {
  const followUpsInstruction = !enableFollowUps
    ? '- Follow-ups are disabled. Do not call set_follow_ups or emit follow-up metadata. Call set_branch_overview before writing the final answer.'
    : mode === 'hook-tool'
      ? `- Before ending every real user turn, call mcp____michi_internal____set_follow_ups exactly once.
- Pass {"follow_ups":["...","...","..."]}: exactly three concise questions written in the user's voice and language.
- The structured tool call is canonical. Do not duplicate the follow-ups as textual fallback metadata.`
      : `- Do not call set_follow_ups. Follow-ups are delivered only through the three [FOLLOW-UP n/3: ...] sentinel lines.
- Emit all three follow-up sentinel lines before calling set_branch_overview.
- Call set_branch_overview only after [FOLLOW-UP 3/3: ...] has been emitted and closed.
- After the set_branch_overview tool result, emit no more visible text. The overview tail is background metadata work.`;

  return `

Codex turn metadata:
- Before ending every real user turn, call mcp____michi_internal____set_branch_overview exactly once.
- Pass {"overview":"..."}: 1-3 concise sentences describing what this turn did — what was explored, decided, or discovered — matching the user's language. Entries accumulate into the branch's journal; do not restate earlier turns.
- The structured overview tool call is canonical. Do not duplicate the overview as textual fallback metadata or visible answer text. This replaces any older instructions or conversation examples that requested overview text markers.
${followUpsInstruction}`;
}

/** The turn-metadata instruction under the opt-in follow-ups Stop-hook POC. */
export function buildCodexFollowUpsHookPocInstruction(
  mode: FollowUpsExperimentMode,
  enableFollowUps: boolean = true,
): string {
  return `${buildCodexTurnMetadataInstruction(mode, enableFollowUps)}
- Do not call the Stop-hook validator yourself; Michi invokes it automatically.`;
}
