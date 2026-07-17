import { useMemo } from 'react';
import { smoothingProfileForRuntime, useSmooth } from '../hooks/useSmooth';
import { findNextSafeBoundaryOrNull } from '../lib/markdownBoundary';
import { deriveVisibleMessage, stripSentinelsStreamingSafe } from './assistantParsing';
import { assistantAnswerRawText, hasAssistantBlocks } from './assistantBlocks';
import type { AssistantBlock, ChatMessage, ToolCallState } from './chatTypes';

export type Segment =
  | { kind: 'text'; text: string; revealTailChars?: number }
  | { kind: 'tool-group'; tools: ToolCallState[] }
  | { kind: 'user-input'; requestId: number };

export type AssistantRunKind = 'answer' | 'thinking' | 'image';

export interface SentinelCarry {
  pendingRawTail?: string;
}

export interface AssistantRun {
  id: string;
  kind: AssistantRunKind;
  blocks: AssistantBlock[];
  incomingCarry?: SentinelCarry;
  outgoingCarry?: SentinelCarry;
}

export interface AnswerProjection {
  rawText: string;
  visibleText: string;
  remapOffset: (runRawOff: number) => number;
  outgoingCarry?: SentinelCarry;
}

export interface WeaveOptions {
  forceFinal: boolean;
  revealFrom?: number;
}

const STREAM_REVEAL_TAIL_CHARS = 1;

function streamingRevealFrom(text: string, active: boolean): number | undefined {
  if (!active || text.length === 0) return undefined;
  return Math.max(0, text.length - STREAM_REVEAL_TAIL_CHARS);
}

function revealTailCharsForSlice(start: number, end: number, revealFrom: number | undefined): number | undefined {
  if (revealFrom === undefined || end <= revealFrom) return undefined;
  return end - Math.max(start, revealFrom);
}

function emptyCarry(carry: SentinelCarry | undefined): string {
  return carry?.pendingRawTail ?? '';
}

function textBlockKind(block: AssistantBlock): AssistantRunKind | null {
  if (block.kind === 'answer') return 'answer';
  if (block.kind === 'thinking') return 'thinking';
  return null;
}

function toolSection(block: AssistantBlock): AssistantRunKind | null {
  if (block.kind === 'tool') return block.section;
  if (block.kind === 'user-input') return block.section;
  return null;
}

function runKindForBlock(block: AssistantBlock): AssistantRunKind {
  if (block.kind === 'image') return 'image';
  return textBlockKind(block) ?? toolSection(block) ?? 'answer';
}

export function splitAssistantRuns(blocks: readonly AssistantBlock[] | undefined): AssistantRun[] {
  if (!blocks || blocks.length === 0) return [];
  const rawRuns: Array<{ id: string; kind: AssistantRunKind; blocks: AssistantBlock[] }> = [];
  for (const block of blocks) {
    const kind = runKindForBlock(block);
    const last = rawRuns[rawRuns.length - 1];
    if (last && last.kind === kind) {
      last.blocks.push(block);
    } else {
      rawRuns.push({ id: block.id, kind, blocks: [block] });
    }
  }

  let carry: SentinelCarry | undefined;
  return rawRuns.map((run) => {
    const incomingCarry = run.kind === 'answer' ? carry : undefined;
    let outgoingCarry: SentinelCarry | undefined;
    if (run.kind === 'answer') {
      outgoingCarry = getRunProjection(run.blocks, incomingCarry).outgoingCarry;
      carry = outgoingCarry;
    }
    return { ...run, incomingCarry, outgoingCarry };
  });
}

export function answerRunRawText(blocks: readonly AssistantBlock[]): string {
  return blocks.map((b) => (b.kind === 'answer' ? b.rawText : '')).join('');
}

export function thinkingRunRawText(blocks: readonly AssistantBlock[]): string {
  return blocks.map((b) => (b.kind === 'thinking' ? b.rawText : '')).join('');
}

export function projectAnswerRun(
  blocks: readonly AssistantBlock[],
  incomingCarry?: SentinelCarry,
): AnswerProjection {
  const carryRaw = emptyCarry(incomingCarry);
  const rawText = answerRunRawText(blocks);
  const combined = carryRaw + rawText;
  const projection = stripSentinelsStreamingSafe(combined);
  const carryLen = carryRaw.length;
  return {
    rawText,
    visibleText: projection.visibleText,
    remapOffset: (runRawOff: number) => projection.remapOffset(carryLen + runRawOff),
    outgoingCarry: projection.pendingRawTail ? { pendingRawTail: projection.pendingRawTail } : undefined,
  };
}

// Cache the per-run sentinel projection keyed on the run's LAST block object.
// After cloneBlocks preserves identity (Task 1), only the actively-growing
// run's last block changes identity per frame, so frozen runs hit the cache
// and skip the O(L) stripSentinelsStreamingSafe re-scan. WeakMap → entries are
// GC'd with their block objects (no leak).
const runProjectionCache = new WeakMap<
  AssistantBlock,
  { incomingCarry: SentinelCarry | undefined; projection: AnswerProjection }
>();

export function getRunProjection(
  blocks: readonly AssistantBlock[],
  incomingCarry: SentinelCarry | undefined,
): AnswerProjection {
  const lastBlock = blocks[blocks.length - 1];
  if (!lastBlock) return projectAnswerRun(blocks, incomingCarry);
  const cached = runProjectionCache.get(lastBlock);
  if (cached && carryEqual(cached.incomingCarry, incomingCarry)) return cached.projection;
  const projection = projectAnswerRun(blocks, incomingCarry);
  // One entry per last-block key is enough: splitAssistantRuns propagates carry
  // left-to-right in a single pass, so a given last-block always has the same
  // incomingCarry unless a preceding run changed — in which case its key changes too.
  runProjectionCache.set(lastBlock, { incomingCarry, projection });
  return projection;
}

function toolRefEqual(a: readonly ToolCallState[], b: readonly ToolCallState[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function sameToolRefs(a: readonly ToolCallState[], b: readonly ToolCallState[]): boolean {
  return toolRefEqual(a, b);
}

export function sameBlockRefs(a: readonly AssistantBlock[], b: readonly AssistantBlock[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function carryEqual(a: SentinelCarry | undefined, b: SentinelCarry | undefined): boolean {
  return (a?.pendingRawTail ?? '') === (b?.pendingRawTail ?? '');
}

export function weaveToolCalls(
  smoothText: string,
  rawTextLen: number,
  toolCalls: ToolCallState[],
  remapOffset: (rawOff: number) => number,
  opts: WeaveOptions,
): Segment[] {
  type Resolved = { tool: ToolCallState; at: number; order: number };
  const resolved: Resolved[] = [];
  const trailingFinal: Resolved[] = [];

  toolCalls.forEach((t, order) => {
    if (typeof t.textOffset !== 'number' || !Number.isFinite(t.textOffset)) {
      if (opts.forceFinal) trailingFinal.push({ tool: t, at: smoothText.length, order });
      return;
    }
    if (t.textOffset > rawTextLen) return;
    const visibleOff = remapOffset(t.textOffset);
    if (visibleOff > smoothText.length) return;
    const boundary = findNextSafeBoundaryOrNull(smoothText, visibleOff);
    if (boundary !== null) {
      resolved.push({ tool: t, at: boundary, order });
    } else if (opts.forceFinal) {
      resolved.push({ tool: t, at: smoothText.length, order });
    }
  });

  resolved.sort((a, b) => (a.at - b.at) || (a.order - b.order));
  resolved.push(...trailingFinal);

  const out: Segment[] = [];
  let cursor = 0;
  let currentGroup: ToolCallState[] | null = null;

  const flushGroup = () => {
    if (currentGroup && currentGroup.length > 0) out.push({ kind: 'tool-group', tools: currentGroup });
    currentGroup = null;
  };
  const pushText = (text: string, start: number) => {
    if (!text) return;
    flushGroup();
    const revealTailChars = revealTailCharsForSlice(start, start + text.length, opts.revealFrom);
    out.push(revealTailChars ? { kind: 'text', text, revealTailChars } : { kind: 'text', text });
  };

  for (const { tool, at } of resolved) {
    const clamped = Math.max(cursor, Math.min(at, smoothText.length));
    if (clamped > cursor) {
      pushText(smoothText.slice(cursor, clamped), cursor);
      cursor = clamped;
    }
    if (!currentGroup) currentGroup = [];
    currentGroup.push(tool);
  }
  if (cursor < smoothText.length) pushText(smoothText.slice(cursor), cursor);
  flushGroup();
  return out;
}

export function weaveRunToolBlocks(
  smoothText: string,
  rawTextLen: number,
  blocks: readonly AssistantBlock[],
  toolsById: ReadonlyMap<string, ToolCallState>,
  remapOffset: (rawOff: number) => number,
  opts: WeaveOptions,
): Segment[] {
  type ResolvedItem =
    | { type: 'tool'; tool: ToolCallState; at: number; order: number }
    | { type: 'user-input'; requestId: number; at: number; order: number };
  const resolved: ResolvedItem[] = [];
  blocks.forEach((block, order) => {
    if (block.kind === 'tool') {
      const tool = toolsById.get(block.toolCallId);
      if (!tool) return;
      if (block.rawOffset > rawTextLen) return;
      const visibleOff = remapOffset(block.rawOffset);
      if (visibleOff > smoothText.length) return;
      resolved.push({ type: 'tool', tool, at: visibleOff, order });
    } else if (block.kind === 'user-input') {
      if (block.rawOffset > rawTextLen) return;
      const visibleOff = remapOffset(block.rawOffset);
      if (visibleOff > smoothText.length) return;
      resolved.push({ type: 'user-input', requestId: block.requestId, at: visibleOff, order });
    }
  });

  resolved.sort((a, b) => (a.at - b.at) || (a.order - b.order));
  const out: Segment[] = [];
  let cursor = 0;
  let currentGroup: ToolCallState[] | null = null;
  const flushGroup = () => {
    if (currentGroup && currentGroup.length > 0) out.push({ kind: 'tool-group', tools: currentGroup });
    currentGroup = null;
  };
  const pushText = (text: string, start: number) => {
    if (!text) return;
    flushGroup();
    const revealTailChars = revealTailCharsForSlice(start, start + text.length, opts.revealFrom);
    out.push(revealTailChars ? { kind: 'text', text, revealTailChars } : { kind: 'text', text });
  };
  for (const item of resolved) {
    const clamped = Math.max(cursor, Math.min(item.at, smoothText.length));
    if (clamped > cursor) {
      pushText(smoothText.slice(cursor, clamped), cursor);
      cursor = clamped;
    }
    if (item.type === 'tool') {
      if (!currentGroup) currentGroup = [];
      currentGroup.push(item.tool);
    } else {
      flushGroup();
      out.push({ kind: 'user-input', requestId: item.requestId });
    }
  }
  if (cursor < smoothText.length) pushText(smoothText.slice(cursor), cursor);
  flushGroup();
  return out;
}

export interface VisibleStream {
  segments: Segment[];
  isSmoothing: boolean;
}

export function useAnswerRunStream(
  blocks: readonly AssistantBlock[],
  toolsById: ReadonlyMap<string, ToolCallState>,
  incomingCarry: SentinelCarry | undefined,
  runtimeId?: string | null,
): VisibleStream {
  const projection = useMemo(
    () => projectAnswerRun(blocks, incomingCarry),
    [blocks, incomingCarry],
  );
  const streaming = blocks.some((b) => b.kind === 'answer' && b.streaming);
  const { displayed: smoothText, isSmoothing } = useSmooth(
    projection.visibleText,
    streaming,
    smoothingProfileForRuntime(runtimeId),
  );
  const forceFinal = !streaming && !isSmoothing;
  const revealFrom = streamingRevealFrom(smoothText, streaming);
  const segments = useMemo(
    () => weaveRunToolBlocks(
      smoothText,
      projection.rawText.length,
      blocks,
      toolsById,
      projection.remapOffset,
      { forceFinal, revealFrom },
    ),
    [smoothText, projection, blocks, toolsById, forceFinal, revealFrom],
  );
  return { segments, isSmoothing };
}

export function isAnswerTextStreaming(m: ChatMessage): boolean {
  if (!hasAssistantBlocks(m)) return !!m.streaming;
  return (m.blocks ?? []).some((block) => block.kind === 'answer' && block.streaming === true);
}

export function useVisibleStream(m: ChatMessage, runtimeId?: string | null): VisibleStream {
  const hasBlocks = hasAssistantBlocks(m);
  const { visibleText, remapOffset } = useMemo(() => {
    if (hasBlocks) return stripSentinelsStreamingSafe(assistantAnswerRawText(m));
    return deriveVisibleMessage(m);
  }, [hasBlocks, m]);

  const answerStreaming = isAnswerTextStreaming(m);
  const { displayed: smoothText, isSmoothing } = useSmooth(
    visibleText,
    answerStreaming,
    smoothingProfileForRuntime(runtimeId),
  );
  const rawTextLen = hasBlocks ? assistantAnswerRawText(m).length : m.text.length;
  const forceFinal = !answerStreaming && !isSmoothing;
  const revealFrom = streamingRevealFrom(smoothText, answerStreaming);

  const segments = useMemo(
    () => weaveToolCalls(smoothText, rawTextLen, m.toolCalls, remapOffset, { forceFinal, revealFrom }),
    [smoothText, rawTextLen, m.toolCalls, remapOffset, forceFinal, revealFrom],
  );

  return { segments, isSmoothing };
}
