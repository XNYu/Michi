import type { ChatNodeState, SubagentInfo } from './chatTypes';
import { foldSubagentCopies, isSubagentActive, messageSubagentRoster } from './backgroundWork';

/** End fields a copy can bring as news: the agent ended again, in this turn. */
const END_REPORT = ['outcome', 'result', 'error'] as const;

/**
 * Whether `copy` only repeats an agent that had ended before this turn:
 * the earlier copies (folded) say it ended, and this copy is still ended
 * without anything of this turn's own. Steps are the turn's own (each
 * message records only its own turn's steps), as is a launch by one of
 * this message's tool calls or an outcome, result or error the earlier
 * copies did not have.
 */
function isCarriedOver(copy: SubagentInfo, earlier: SubagentInfo | undefined, toolIds: ReadonlySet<string>): boolean {
  if (!earlier || isSubagentActive(earlier) || isSubagentActive(copy)) return false;
  if (copy.activity?.length) return false;
  if (copy.parentToolCallId && toolIds.has(copy.parentToolCallId)) return false;
  return !END_REPORT.some((key) => !!copy[key] && copy[key] !== earlier[key]);
}

/**
 * The subagents each assistant message lists as its turn's own, by message
 * id. A later turn's roster can repeat agents that ended in an earlier
 * turn: Kiro V2 republishes its session's whole roster as later turns run
 * (a finished crew's stages reappear, bare `terminated`, in later turns'
 * stored rosters), and a Codex child closed after it completed reports a
 * bare terminated state then. Those repeats are left
 * out (isCarriedOver); everything else stays, including a background
 * agent's completion, which lands in a later turn by design.
 *
 * Display only: the stored rosters keep every copy, and the conversation's
 * own view of an agent (conversationSubagents) still folds them all.
 * A roster with nothing left out is returned as it is.
 */
export function turnOwnSubagents(
  node: Pick<ChatNodeState, 'messages' | 'subagents'>,
  tailAssistantId: string | undefined,
): ReadonlyMap<string, readonly SubagentInfo[]> {
  const byMessage = new Map<string, readonly SubagentInfo[]>();
  const earlier = new Map<string, SubagentInfo>();
  for (const message of node.messages) {
    const roster = messageSubagentRoster(node, message, tailAssistantId);
    if (!roster?.length) continue;
    const toolIds = new Set(message.toolCalls.map((tool) => tool.id));
    const own = roster.filter((copy) => !isCarriedOver(copy, earlier.get(copy.sessionId), toolIds));
    byMessage.set(message.id, own.length === roster.length ? roster : own);
    for (const copy of roster) {
      const previous = earlier.get(copy.sessionId);
      earlier.set(copy.sessionId, previous ? foldSubagentCopies(previous, copy) : copy);
    }
  }
  return byMessage;
}
