import type { AssistantBlock, ToolCallState } from '../../state/chatTypes';

/** Durable activity window of a group of assistant blocks (backend clock, ms). */
export interface ActivityWindow {
  startedAt?: number;
  endedAt?: number;
}

function blockStartedAt(block: AssistantBlock, toolsById: ReadonlyMap<string, ToolCallState>): number | undefined {
  if (block.kind === 'answer' || block.kind === 'thinking') return block.startedAt;
  if (block.kind === 'tool') return toolsById.get(block.toolCallId)?.startedAt;
  return undefined;
}

function blockEndedAt(block: AssistantBlock, toolsById: ReadonlyMap<string, ToolCallState>): number | undefined {
  if (block.kind === 'answer' || block.kind === 'thinking') return block.endedAt;
  if (block.kind === 'tool') return toolsById.get(block.toolCallId)?.endedAt;
  return undefined;
}

/**
 * Earliest known start to latest known end across `blocks`, from the durable
 * timestamps on text blocks and their tools. `nextBlock` is the block rendered
 * right after the group: the group kept working until it opened, even when its
 * own last tool finished earlier. Only that immediate neighbour counts; a later
 * one may follow a wait the group took no part in (e.g. an unanswered question).
 * Either bound is undefined when no block carries it (legacy turns).
 */
export function activityWindow(
  blocks: readonly AssistantBlock[],
  toolsById: ReadonlyMap<string, ToolCallState>,
  nextBlock?: AssistantBlock,
): ActivityWindow {
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  for (const block of blocks) {
    const start = blockStartedAt(block, toolsById);
    if (start !== undefined) startedAt = startedAt === undefined ? start : Math.min(startedAt, start);
    const end = blockEndedAt(block, toolsById);
    if (end !== undefined) endedAt = endedAt === undefined ? end : Math.max(endedAt, end);
  }
  const nextStart = nextBlock ? blockStartedAt(nextBlock, toolsById) : undefined;
  if (nextStart !== undefined) endedAt = endedAt === undefined ? nextStart : Math.max(endedAt, nextStart);
  return { startedAt, endedAt };
}

/** endedAt − startedAt when both are known and ordered; otherwise undefined. */
export function activityWindowMs(startedAt: number | undefined, endedAt: number | undefined): number | undefined {
  if (startedAt === undefined || endedAt === undefined || endedAt < startedAt) return undefined;
  return endedAt - startedAt;
}
