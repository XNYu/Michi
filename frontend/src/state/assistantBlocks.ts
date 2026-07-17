import { stripSentinelsStreamingSafe } from './assistantParsing';
import type { AssistantBlock, ChatMessage, ToolCallState } from './chatTypes';
import {
  applyTurnEvent,
  extractTurnMetadata,
  finalizeTurnContent,
  type ChatStreamEvent,
  type DurableAssistantBlock,
  type DurableToolCall,
  type DurableTurnSnapshot,
} from 'michi-shared';

export type AssistantSection = 'answer' | 'thinking';

function stableBlockId(message: ChatMessage, index: number): string {
  return `${message.id}-b-${index}`;
}

function nextBlockId(message: ChatMessage, blocks: readonly AssistantBlock[]): string {
  return stableBlockId(message, blocks.length);
}

function isTextBlock(block: AssistantBlock): block is Extract<AssistantBlock, { kind: 'answer' | 'thinking' }> {
  return block.kind === 'answer' || block.kind === 'thinking';
}

// Shallow array copy. Append helpers only REPLACE the tail element (`blocks[i] = {...}`)
// or PUSH a new block, then return `{...message, blocks}` — they never mutate a block
// object in place (verified). Preserving element identity lets `sameBlockRefs`
// short-circuit React.memo for unchanged runs during streaming.
function cloneBlocks(blocks: readonly AssistantBlock[] | undefined): AssistantBlock[] {
  return (blocks ?? []).slice();
}

export function isValidAssistantBlocks(value: unknown): value is AssistantBlock[] {
  if (!Array.isArray(value)) return false;
  return value.every((item) => {
    if (!item || typeof item !== 'object') return false;
    const b = item as Record<string, unknown>;
    if (typeof b.id !== 'string' || b.id.length === 0) return false;
    if (b.kind === 'answer' || b.kind === 'thinking') return typeof b.rawText === 'string';
    if (b.kind === 'image') return typeof (b as { path?: unknown }).path === 'string';
    return (
      b.kind === 'tool' &&
      typeof b.toolCallId === 'string' &&
      (b.section === 'answer' || b.section === 'thinking') &&
      typeof b.rawOffset === 'number' &&
      Number.isFinite(b.rawOffset)
    );
  });
}

export function parseAssistantBlocks(raw: unknown): AssistantBlock[] | undefined {
  let value = raw;
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return isValidAssistantBlocks(value) ? cloneBlocks(value) : undefined;
}

export function assistantBlocksJson(m: ChatMessage): string | null {
  if (m.role !== 'assistant') return null;
  const blocks = migrateAssistantToBlocks(m).blocks;
  return blocks && blocks.length > 0 ? JSON.stringify(blocks) : null;
}

export function assistantAnswerRawText(m: ChatMessage): string {
  if (m.role !== 'assistant') return m.text;
  const blocks = m.blocks;
  if (!blocks || blocks.length === 0) return m.text ?? '';
  return blocks.map((b) => (b.kind === 'answer' ? b.rawText : '')).join('');
}

export function assistantAnswerVisibleText(m: ChatMessage): string {
  return stripSentinelsStreamingSafe(assistantAnswerRawText(m)).visibleText;
}

export function assistantThinkingText(m: ChatMessage): string {
  if (m.role !== 'assistant') return '';
  const blocks = m.blocks;
  if (!blocks || blocks.length === 0) return m.thought ?? '';
  return blocks.map((b) => (b.kind === 'thinking' ? b.rawText : '')).join('');
}

export function assistantPersistenceContent(m: ChatMessage): string {
  return m.role === 'assistant' ? finalizeTurnContent(assistantAnswerRawText(m)) : m.text;
}

export function assistantMetadata(m: ChatMessage): { title: string | null; branchOverview: string | null; followUps: string[] } {
  const metadata = extractTurnMetadata(assistantAnswerRawText(m));
  return {
    title: metadata.title ?? null,
    branchOverview: metadata.branchOverview ?? null,
    followUps: metadata.followUps ?? [],
  };
}

export function visibleMessageText(m: ChatMessage): string {
  return m.role === 'assistant' ? assistantAnswerVisibleText(m) : m.text;
}

/**
 * Frontend adapter around the shared durable projector. Durable stream event
 * placement lives in shared; this layer preserves UI-only ChatMessage fields.
 */
export function projectAssistantStreamEvent(
  message: ChatMessage,
  workspaceId: string,
  event: ChatStreamEvent,
): ChatMessage {
  if (message.role !== 'assistant') return message;
  const startedAt = message.createdAt ?? 0;
  const snapshot: DurableTurnSnapshot = {
    version: 1,
    turnId: event.data.turnId ?? `frontend-${message.id}`,
    nodeId: '',
    workspaceId,
    assistantId: message.id,
    userMessage: null,
    assistantMessage: {
      id: message.id,
      role: 'assistant',
      // Placeholder: `applyTurnEvent` recomputes content from blocks where it
      // matters (chunk/done/error) and never reads this input, and our return
      // below discards `projected.assistantMessage.content` entirely. Computing
      // the real value here would run finalizeTurnContent's full-string scan on
      // every chunk (O(L²) over a streaming turn) just to throw it away.
      // Persistence/fingerprints derive content lazily via assistantPersistenceContent.
      content: '',
      blocks: (message.blocks ?? []) as DurableAssistantBlock[],
      toolCalls: message.toolCalls as DurableToolCall[],
      plan: message.plan,
      createdAt: startedAt,
    },
    nodeMetadata: {},
    status: 'active',
    lastAppliedSeq: -1,
    startedAt,
  };
  const projected = applyTurnEvent(snapshot, event);
  return {
    ...message,
    blocks: projected.assistantMessage.blocks as AssistantBlock[],
    toolCalls: projected.assistantMessage.toolCalls as ToolCallState[],
    plan: projected.assistantMessage.plan,
    streaming: projected.status === 'active' ? message.streaming : false,
  };
}

function currentSection(blocks: readonly AssistantBlock[]): AssistantSection {
  // Tool blocks preserve the current semantic section. Consecutive tools after
  // a thought must remain inside that thinking run instead of the second tool
  // falling back to the answer section.
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.kind === 'answer' || block.kind === 'thinking') return block.kind;
    if (block.kind === 'tool') return block.section;
  }
  return 'answer';
}

function currentRunRawLength(blocks: readonly AssistantBlock[], section: AssistantSection): number {
  let total = 0;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const b = blocks[i];
    if (section === 'answer') {
      if (b.kind === 'thinking') break;
      if (b.kind === 'answer') total += b.rawText.length;
    } else {
      if (b.kind === 'answer') break;
      if (b.kind === 'thinking') total += b.rawText.length;
    }
  }
  return total;
}

export function nextToolBlockPlacement(message: ChatMessage): { section: AssistantSection; rawOffset: number } {
  const blocks = cloneBlocks(message.blocks);
  const section = currentSection(blocks);
  return { section, rawOffset: currentRunRawLength(blocks, section) };
}

export function appendAnswerBlockText(message: ChatMessage, text: string): ChatMessage {
  const blocks = cloneBlocks(message.blocks);
  const last = blocks[blocks.length - 1];
  if (last?.kind === 'answer') {
    blocks[blocks.length - 1] = { ...last, rawText: last.rawText + text, streaming: message.streaming };
  } else {
    blocks.push({ id: nextBlockId(message, blocks), kind: 'answer', rawText: text, streaming: message.streaming });
  }
  return { ...message, blocks };
}

export function appendThinkingBlockText(message: ChatMessage, text: string): ChatMessage {
  const blocks = cloneBlocks(message.blocks);
  const last = blocks[blocks.length - 1];
  if (last?.kind === 'thinking') {
    blocks[blocks.length - 1] = { ...last, rawText: last.rawText + text, streaming: message.streaming };
  } else {
    blocks.push({ id: nextBlockId(message, blocks), kind: 'thinking', rawText: text, streaming: message.streaming });
  }
  return { ...message, blocks };
}

export function appendToolBlock(message: ChatMessage, toolCallId: string): ChatMessage {
  const blocks = cloneBlocks(message.blocks);
  const { section, rawOffset } = nextToolBlockPlacement({ ...message, blocks });
  blocks.push({
    id: nextBlockId(message, blocks),
    kind: 'tool',
    toolCallId,
    section,
    rawOffset,
  });
  return { ...message, blocks };
}

export function appendImageBlock(
  message: ChatMessage,
  img: { workspaceId: string; path: string; caption?: string; mimeType: string; size: number },
): ChatMessage {
  const blocks = cloneBlocks(message.blocks);
  const block: AssistantBlock = {
    id: nextBlockId(message, blocks),
    kind: 'image',
    workspaceId: img.workspaceId,
    path: img.path,
    caption: img.caption,
    mimeType: img.mimeType,
    size: img.size,
  };
  return { ...message, blocks: [...blocks, block] };
}

export function finalizeAssistantBlocks(message: ChatMessage): ChatMessage {
  if (message.role !== 'assistant') return message;
  const blocks = cloneBlocks(message.blocks).map((b) =>
    isTextBlock(b) ? { ...b, streaming: false } : b,
  );
  return { ...message, streaming: false, blocks };
}

export function hasAssistantBlocks(m: ChatMessage): boolean {
  return m.role === 'assistant' && isValidAssistantBlocks(m.blocks);
}

export function migrateAssistantToBlocks(message: ChatMessage): ChatMessage {
  if (message.role !== 'assistant') return message;
  const existing = parseAssistantBlocks(message.blocks);
  if (existing) {
    return { ...message, blocks: existing, text: '', thought: undefined };
  }

  const blocks: AssistantBlock[] = [];
  if (message.thought) {
    blocks.push({
      id: `${message.id}-legacy-thinking-0`,
      kind: 'thinking',
      rawText: message.thought,
      streaming: false,
    });
  }

  const raw = message.text ?? '';
  const withIndex = (message.toolCalls ?? []).map((tool, index) => ({ tool, index }));
  const positioned = withIndex
    .filter(({ tool }) => typeof tool.textOffset === 'number' && Number.isFinite(tool.textOffset))
    .map(({ tool, index }) => ({
      tool,
      index,
      offset: Math.max(0, Math.min(tool.textOffset as number, raw.length)),
    }))
    .sort((a, b) => (a.offset - b.offset) || (a.index - b.index));
  const trailing = withIndex.filter(({ tool }) => typeof tool.textOffset !== 'number' || !Number.isFinite(tool.textOffset));

  let cursor = 0;
  let answerSlice = 0;
  const pushAnswer = (text: string) => {
    if (!text) return;
    blocks.push({
      id: `${message.id}-legacy-answer-${answerSlice++}`,
      kind: 'answer',
      rawText: text,
      streaming: false,
    });
  };
  for (const item of positioned) {
    pushAnswer(raw.slice(cursor, item.offset));
    blocks.push({
      id: `${message.id}-legacy-tool-${item.tool.id || item.index}`,
      kind: 'tool',
      toolCallId: item.tool.id,
      section: 'answer',
      rawOffset: item.offset,
    });
    cursor = item.offset;
  }
  pushAnswer(raw.slice(cursor));
  for (const item of trailing) {
    blocks.push({
      id: `${message.id}-legacy-tool-${item.tool.id || item.index}`,
      kind: 'tool',
      toolCallId: item.tool.id,
      section: 'answer',
      rawOffset: raw.length,
    });
  }

  return { ...message, blocks, text: '', thought: undefined, streaming: false };
}

export function messageForPersistence(m: ChatMessage): {
  content: string;
  blocks: string | null;
  toolCalls: ToolCallState[];
} {
  if (m.role !== 'assistant') {
    return { content: m.text, blocks: null, toolCalls: m.toolCalls ?? [] };
  }
  const migrated = migrateAssistantToBlocks(m);
  return {
    content: assistantPersistenceContent(migrated),
    blocks: migrated.blocks && migrated.blocks.length > 0 ? JSON.stringify(migrated.blocks) : null,
    toolCalls: migrated.toolCalls ?? [],
  };
}
