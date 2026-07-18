import type { ChatStreamEvent, PlanEntry, ToolCallStreamPayload } from './chatStreamEvents';

export interface DurableToolCall {
  id: string;
  title: string;
  status: string;
  kind?: string;
  detail?: string;
  inputJson?: string;
  output?: string;
  textOffset?: number;
}

export type DurableAssistantBlock =
  | { id: string; kind: 'answer'; rawText: string; streaming?: boolean }
  | { id: string; kind: 'thinking'; rawText: string; streaming?: boolean }
  | { id: string; kind: 'tool'; toolCallId: string; section: 'answer' | 'thinking'; rawOffset: number }
  | { id: string; kind: 'image'; workspaceId: string; path: string; caption?: string; mimeType: string; size: number };

export interface DurableMessageMetadata {
  quotedText?: string;
  attachments?: Array<{ name: string; absPath: string }>;
  comments?: Array<Record<string, unknown>>;
}

export interface DurableMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  blocks: DurableAssistantBlock[];
  toolCalls: DurableToolCall[];
  plan?: PlanEntry[];
  metadata?: DurableMessageMetadata;
  createdAt: number;
}

export interface DurableTurnSnapshot {
  version: 1;
  turnId: string;
  nodeId: string;
  workspaceId: string;
  assistantId: string;
  userMessage: DurableMessage | null;
  assistantMessage: DurableMessage;
  nodeMetadata: {
    title?: string;
    followUps?: string[];
    branchOverview?: string;
  };
  status: 'active' | 'completed' | 'cancelled' | 'error';
  stopReason?: string;
  error?: string;
  lastAppliedSeq: number;
  startedAt: number;
  completedAt?: number;
}

export interface CreateDurableTurnInput {
  turnId: string;
  assistantId: string;
  nodeId: string;
  workspaceId: string;
  displayUserText: string;
  userMetadata?: DurableMessageMetadata;
  selfInitiated?: boolean;
  startedAt: number;
}

const SENTINEL_PREFIXES = ['[TITLE:', '[BRANCH-OVERVIEW:', '[FOLLOW-UP'] as const;
const INLINE_TITLE_RE = /\[TITLE:\s*([^\]]+)\]/i;
const PROSE_TITLE_RE = /^\s*(?:#+\s*)?\**\s*title\s*[:：]\s*\**\s*(.+?)\s*\**\s*$/im;
const INLINE_BRANCH_OVERVIEW_RE = /\[BRANCH-OVERVIEW:\s*([^\]\n\r]+)\]/i;
const INLINE_BRANCH_OVERVIEW_RE_G = /\[BRANCH-OVERVIEW:\s*[^\]\n\r]+\]/gi;
const INLINE_FOLLOW_UP_RE = /\[FOLLOW-UP\s+([1-3])\s*(?:\/\s*3)?\s*:\s*([^\]\n\r]*?)(?:\]|(?=\s*\[FOLLOW-UP\s+[1-3])|(?=[\n\r])|$)/gi;
const INLINE_FOLLOW_UPS_RE = /\[FOLLOW-UPS:\s*([^\]]+)\]/gi;
const PROSE_FOLLOW_UP_RE = /(?:^|\n)[\s#*>_`-]*follow[-\s]?up\s+questions?\s*[:：][\s*_`]*/i;

export interface ExtractedTurnMetadata {
  title?: string;
  followUps?: string[];
  branchOverview?: string;
}

function titleMatch(raw: string): { start: number; end: number; title: string } | null {
  const inline = raw.match(INLINE_TITLE_RE);
  if (inline?.index !== undefined) {
    return { start: inline.index, end: inline.index + inline[0].length, title: inline[1].trim() };
  }
  const prose = raw.match(PROSE_TITLE_RE);
  if (prose?.index !== undefined) {
    return { start: prose.index, end: prose.index + prose[0].length, title: prose[1].trim() };
  }
  return null;
}

function followUpsMatch(raw: string): { followUps: string[]; cutStart: number } | null {
  INLINE_FOLLOW_UP_RE.lastIndex = 0;
  const items = [...raw.matchAll(INLINE_FOLLOW_UP_RE)].flatMap((match) => {
    if (match.index === undefined) return [];
    const index = Number(match[1]) - 1;
    const followUp = match[2].trim();
    if (!Number.isInteger(index) || index < 0 || index > 2 || !followUp) return [];
    return [{ index, followUp, start: match.index, end: match.index + match[0].length }];
  });
  if (items.length > 0) {
    const tail = [items[items.length - 1]];
    for (let index = items.length - 2; index >= 0; index -= 1) {
      const previous = items[index];
      if (!/^\s*$/.test(raw.slice(previous.end, tail[0].start))) break;
      tail.unshift(previous);
    }
    const slots: string[] = [];
    for (const item of tail) slots[item.index] = item.followUp;
    const followUps = slots.filter(Boolean).slice(0, 3);
    if (followUps.length > 0) return { followUps, cutStart: tail[0].start };
  }

  INLINE_FOLLOW_UPS_RE.lastIndex = 0;
  const blocks = [...raw.matchAll(INLINE_FOLLOW_UPS_RE)];
  const block = blocks[blocks.length - 1];
  if (block?.index !== undefined) {
    const followUps = block[1].split('|').map((value: string) => value.trim()).filter(Boolean).slice(0, 3);
    if (followUps.length > 0) return { followUps, cutStart: block.index };
  }

  const prose = raw.match(PROSE_FOLLOW_UP_RE);
  if (prose?.index !== undefined) {
    const tail = raw.slice(prose.index + prose[0].length);
    const followUps = tail
      .split('\n')
      .map((line) => line
        .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
        .replace(/^[\s>*_`#]+/, '')
        .replace(/[\s*_`]+$/, '')
        .trim())
      .filter((line) => line.length > 0 && /[?？]/.test(line))
      .slice(0, 3);
    return { followUps, cutStart: prose.index };
  }
  return null;
}

/** Parse the text fallback used by runtimes that cannot emit metadata events. */
export function extractTurnMetadata(raw: string): ExtractedTurnMetadata {
  const title = titleMatch(raw)?.title;
  const branchOverview = raw.match(INLINE_BRANCH_OVERVIEW_RE)?.[1]?.trim();
  const followUps = followUpsMatch(raw)?.followUps;
  return {
    ...(title ? { title } : {}),
    ...(followUps && followUps.length > 0 ? { followUps } : {}),
    ...(branchOverview ? { branchOverview } : {}),
  };
}

/** Produce the terminal visible assistant content used by persistence/fingerprints. */
export function finalizeTurnContent(raw: string): string {
  const title = titleMatch(raw);
  let withoutTitle = raw;
  if (title) {
    let end = title.end;
    while (end < raw.length && raw[end] === '\n') end += 1;
    withoutTitle = raw.slice(0, title.start) + raw.slice(end);
  }
  const followUps = followUpsMatch(withoutTitle);
  const answer = followUps ? withoutTitle.slice(0, followUps.cutStart) : withoutTitle;
  return stripTurnMetadataSentinels(answer)
    .replace(INLINE_BRANCH_OVERVIEW_RE_G, '')
    .replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n')
    .trim();
}

function couldStillBeSentinel(value: string): boolean {
  const upper = value.toUpperCase();
  return SENTINEL_PREFIXES.some((prefix) =>
    upper.length <= prefix.length ? prefix.startsWith(upper) : upper.startsWith(prefix),
  );
}

/** Strip completed or partial Michi metadata sentinels from visible content. */
export function stripTurnMetadataSentinels(raw: string): string {
  const cuts: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  let holdStart = -1;
  while (cursor < raw.length) {
    const ch = raw[cursor];
    if (holdStart < 0 && ch !== '[') {
      cursor += 1;
      continue;
    }
    if (holdStart < 0) {
      holdStart = cursor;
      cursor += 1;
      continue;
    }
    const candidate = raw.slice(holdStart, cursor + 1);
    if (ch === ']') {
      const upper = candidate.toUpperCase();
      if (SENTINEL_PREFIXES.some((prefix) => upper.startsWith(prefix))) {
        let end = cursor + 1;
        while (end < raw.length && /\s/.test(raw[end])) end += 1;
        cuts.push({ start: holdStart, end });
        cursor = end;
      } else {
        cursor += 1;
      }
      holdStart = -1;
      continue;
    }
    if (!couldStillBeSentinel(candidate)) holdStart = -1;
    cursor += 1;
  }
  if (holdStart >= 0) cuts.push({ start: holdStart, end: raw.length });

  let visible = '';
  cursor = 0;
  for (const cut of cuts) {
    if (cut.start > cursor) visible += raw.slice(cursor, cut.start);
    cursor = cut.end;
  }
  if (cursor < raw.length) visible += raw.slice(cursor);
  return visible;
}

export function createDurableTurn(input: CreateDurableTurnInput): DurableTurnSnapshot {
  return {
    version: 1,
    turnId: input.turnId,
    nodeId: input.nodeId,
    workspaceId: input.workspaceId,
    assistantId: input.assistantId,
    userMessage: input.selfInitiated
      ? null
      : {
          id: `u-${input.assistantId}`,
          role: 'user',
          content: input.displayUserText,
          blocks: [],
          toolCalls: [],
          metadata: input.userMetadata,
          createdAt: input.startedAt,
        },
    assistantMessage: {
      id: input.assistantId,
      role: 'assistant',
      content: '',
      blocks: [],
      toolCalls: [],
      createdAt: input.startedAt,
    },
    nodeMetadata: {},
    status: 'active',
    lastAppliedSeq: -1,
    startedAt: input.startedAt,
  };
}

function nextBlockId(snapshot: DurableTurnSnapshot, blocks: DurableAssistantBlock[]): string {
  return `${snapshot.assistantId}-b-${blocks.length}`;
}

function currentSection(blocks: DurableAssistantBlock[]): 'answer' | 'thinking' {
  // Tool blocks do not start a new semantic section. Consecutive tools must
  // inherit the section established by the preceding text/tool block, or the
  // second tool after a thought would incorrectly jump back to the answer.
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.kind === 'answer' || block.kind === 'thinking') return block.kind;
    if (block.kind === 'tool') return block.section;
  }
  return 'answer';
}

function currentRunLength(blocks: DurableAssistantBlock[], section: 'answer' | 'thinking'): number {
  let total = 0;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (section === 'answer') {
      if (block.kind === 'thinking') break;
      if (block.kind === 'answer') total += block.rawText.length;
    } else {
      if (block.kind === 'answer') break;
      if (block.kind === 'thinking') total += block.rawText.length;
    }
  }
  return total;
}

function closeTrailingTextBlock(blocks: DurableAssistantBlock[]): void {
  const index = blocks.length - 1;
  const last = blocks[index];
  if ((last?.kind === 'answer' || last?.kind === 'thinking') && last.streaming !== false) {
    blocks[index] = { ...last, streaming: false };
  }
}

function appendText(
  snapshot: DurableTurnSnapshot,
  kind: 'answer' | 'thinking',
  text: string,
): DurableAssistantBlock[] {
  const blocks = snapshot.assistantMessage.blocks.slice();
  const last = blocks[blocks.length - 1];
  if (last?.kind === kind) {
    blocks[blocks.length - 1] = { ...last, rawText: last.rawText + text, streaming: true };
  } else {
    closeTrailingTextBlock(blocks);
    blocks.push({ id: nextBlockId(snapshot, blocks), kind, rawText: text, streaming: true });
  }
  return blocks;
}

function mergeTool(previous: DurableToolCall | undefined, update: ToolCallStreamPayload): DurableToolCall {
  const merged: DurableToolCall = previous
    ? { ...previous }
    : { id: update.toolCallId, title: '', status: '' };
  if (update.title) merged.title = update.title;
  if (update.status) merged.status = update.status;
  if (update.kind) merged.kind = update.kind;
  if (update.detail) merged.detail = update.detail;
  if (update.inputJson) merged.inputJson = update.inputJson;
  if (update.output) merged.output = update.output;
  return merged;
}

function applyTool(snapshot: DurableTurnSnapshot, update: ToolCallStreamPayload): DurableMessage {
  const message = snapshot.assistantMessage;
  const existingIndex = message.toolCalls.findIndex((tool) => tool.id === update.toolCallId);
  const toolCalls = message.toolCalls.slice();
  const existing = existingIndex >= 0 ? toolCalls[existingIndex] : undefined;
  const merged = mergeTool(existing, update);
  const blocks = message.blocks.slice();
  if (existingIndex >= 0) {
    toolCalls[existingIndex] = merged;
  } else {
    const section = currentSection(blocks);
    merged.textOffset = currentRunLength(blocks, section);
    toolCalls.push(merged);
    closeTrailingTextBlock(blocks);
    blocks.push({
      id: nextBlockId(snapshot, blocks),
      kind: 'tool',
      toolCallId: merged.id,
      section,
      rawOffset: merged.textOffset,
    });
  }
  return { ...message, toolCalls, blocks };
}

function finalizeMessage(message: DurableMessage): DurableMessage {
  return {
    ...message,
    blocks: message.blocks.map((block) =>
      block.kind === 'answer' || block.kind === 'thinking'
        ? { ...block, streaming: false }
        : block,
    ),
    toolCalls: message.toolCalls.map((tool) => {
      const active = isActiveToolStatus(tool.status);
      return active ? { ...tool, status: 'completed' } : tool;
    }),
  };
}

export function isActiveToolStatus(status: string | undefined): boolean {
  return !status || status === 'running' || status === 'pending' || status === 'in_progress';
}

function answerContent(blocks: DurableAssistantBlock[]): string {
  return stripTurnMetadataSentinels(
    blocks.map((block) => block.kind === 'answer' ? block.rawText : '').join(''),
  );
}

function rawAnswerContent(blocks: DurableAssistantBlock[]): string {
  return blocks.map((block) => block.kind === 'answer' ? block.rawText : '').join('');
}

/** Derive the partial visible answer only at a persistence checkpoint. */
export function checkpointTurnContent(snapshot: DurableTurnSnapshot): string {
  return snapshot.status === 'active'
    ? answerContent(snapshot.assistantMessage.blocks)
    : snapshot.assistantMessage.content;
}

export function applyTurnEvent(
  snapshot: DurableTurnSnapshot,
  streamEvent: ChatStreamEvent,
): DurableTurnSnapshot {
  const seq = streamEvent.data.seq;
  if (typeof seq === 'number' && seq <= snapshot.lastAppliedSeq) return snapshot;

  let next: DurableTurnSnapshot = {
    ...snapshot,
    lastAppliedSeq: typeof seq === 'number' ? seq : snapshot.lastAppliedSeq,
  };
  switch (streamEvent.event) {
    case 'chunk': {
      const blocks = appendText(next, 'answer', streamEvent.data.text);
      next = {
        ...next,
        assistantMessage: { ...next.assistantMessage, blocks },
      };
      break;
    }
    case 'thought': {
      const blocks = appendText(next, 'thinking', streamEvent.data.text);
      next = { ...next, assistantMessage: { ...next.assistantMessage, blocks } };
      break;
    }
    case 'plan':
      next = {
        ...next,
        assistantMessage: { ...next.assistantMessage, plan: streamEvent.data.entries.map((entry) => ({ ...entry })) },
      };
      break;
    case 'tool_call':
    case 'tool_call_update':
      next = { ...next, assistantMessage: applyTool(next, streamEvent.data) };
      break;
    case 'image': {
      const blocks = next.assistantMessage.blocks.slice();
      closeTrailingTextBlock(blocks);
      blocks.push({
        id: nextBlockId(next, blocks),
        kind: 'image',
        workspaceId: next.workspaceId,
        path: streamEvent.data.path,
        caption: streamEvent.data.caption,
        mimeType: streamEvent.data.mimeType,
        size: streamEvent.data.size,
      });
      next = { ...next, assistantMessage: { ...next.assistantMessage, blocks } };
      break;
    }
    case 'title':
      if (streamEvent.data.title.trim()) {
        next = { ...next, nodeMetadata: { ...next.nodeMetadata, title: streamEvent.data.title.trim() } };
      }
      break;
    case 'follow_ups':
      next = {
        ...next,
        nodeMetadata: {
          ...next.nodeMetadata,
          followUps: streamEvent.data.followUps.map((value) => value.trim()).filter(Boolean).slice(0, 3),
        },
      };
      break;
    case 'branch_overview':
      if (streamEvent.data.overview.trim()) {
        next = {
          ...next,
          nodeMetadata: { ...next.nodeMetadata, branchOverview: streamEvent.data.overview.trim() },
        };
      }
      break;
    case 'done': {
      const stopReason = streamEvent.data.stopReason;
      const status = stopReason === 'cancel' || stopReason === 'cancelled'
        ? 'cancelled'
        : stopReason === 'error'
          ? 'error'
          : 'completed';
      const assistantMessage = finalizeMessage(next.assistantMessage);
      const rawAnswer = rawAnswerContent(assistantMessage.blocks);
      next = {
        ...next,
        status,
        stopReason,
        completedAt: streamEvent.data.completedAt,
        nodeMetadata: { ...extractTurnMetadata(rawAnswer), ...next.nodeMetadata },
        assistantMessage: { ...assistantMessage, content: finalizeTurnContent(rawAnswer) },
      };
      break;
    }
    case 'error': {
      const assistantMessage = finalizeMessage(next.assistantMessage);
      const rawAnswer = rawAnswerContent(assistantMessage.blocks);
      next = {
        ...next,
        status: 'error',
        error: streamEvent.data.message,
        completedAt: streamEvent.data.completedAt,
        nodeMetadata: { ...extractTurnMetadata(rawAnswer), ...next.nodeMetadata },
        assistantMessage: { ...assistantMessage, content: finalizeTurnContent(rawAnswer) },
      };
      break;
    }
    default:
      break;
  }
  return next;
}
