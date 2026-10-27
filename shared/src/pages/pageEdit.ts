import { isRecord, parsePageBlockInput, parseBlockSource } from './blocks';
import type { BlockEdit, BlockSource, PageBlock, PageBlockInput } from './blocks';
import { blockLocation, insertionIndex, missingBlockSnapshot, snapshotBlock } from './blockTree';
import { pageBlockProblem } from './blockCatalog';
import type { BlockSnapshot } from './blockTree';
import { retainUserPageSegmentSources } from './markdownSegments';

export type PageEditOp =
  | { op: 'insert'; block: PageBlockInput; after: string | null }
  | { op: 'update'; id: string; block: PageBlockInput; expectRev?: number }
  | { op: 'delete'; id: string; expectRev?: number }
  | { op: 'move'; id: string; after: string | null; expectRev?: number }
  | { op: 'release'; id: string; expectRev?: number };

export type AgentPageEditOp = Exclude<PageEditOp, { op: 'release' }>;

export interface PageActorContext {
  actor: 'user' | 'agent';
  source?: BlockSource;
  /** Revision assigned by the enclosing page write. */
  revision: number;
  now: number;
  newId?: () => string;
}

export interface PageTargetChange {
  id: string;
  op: 'insert' | 'update' | 'delete' | 'move' | 'release';
  before: BlockSnapshot;
  after: BlockSnapshot;
}

export interface PageOpRejection {
  index: number;
  reason: 'stale' | 'missing' | 'invalid';
  message: string;
}

export interface ApplyPageOpsResult {
  blocks: PageBlock[];
  touched: PageTargetChange[];
  deleted: PageTargetChange[];
  rejected: PageOpRejection[];
}

function validExistingKeys(op: Record<string, unknown>, allowed: readonly string[], requireRev: boolean): boolean {
  if (!Object.keys(op).every((key) => allowed.includes(key))) return false;
  if (requireRev && (!Number.isSafeInteger(op.expectRev) || (op.expectRev as number) < 1)) return false;
  return op.expectRev === undefined || (Number.isSafeInteger(op.expectRev) && (op.expectRev as number) >= 1);
}

export function parseUserPageOps(value: unknown): PageEditOp[] | null {
  return parseOps(value, false) as PageEditOp[] | null;
}

export function parseAgentPageOps(value: unknown): AgentPageEditOp[] | null {
  return parseOps(value, true) as AgentPageEditOp[] | null;
}

/** Why one agent page operation is not valid, in words for the agent that sent it; '' when it is. */
export function agentPageOpProblem(value: unknown): string {
  if (parseAgentPageOps([value])) return '';
  if (!isRecord(value) || typeof value.op !== 'string') return 'An operation is an object whose op is insert, update, delete or move';
  if ((value.op === 'insert' || value.op === 'update') && 'block' in value) {
    const problem = pageBlockProblem(value.block);
    if (problem) return problem;
  }
  return `Invalid ${value.op} operation. insert takes {op, block, after}; update {op, id, block, expectRev}; delete {op, id, expectRev}; move {op, id, after, expectRev}`;
}

function parseOps(value: unknown, agent: boolean): PageEditOp[] | null {
  if (!Array.isArray(value) || value.length > 50) return null;
  const ops: PageEditOp[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.op !== 'string') return null;
    switch (candidate.op) {
      case 'insert': {
        if (!Object.keys(candidate).every((key) => ['op', 'block', 'after'].includes(key)) || !('after' in candidate)) return null;
        const block = parsePageBlockInput(candidate.block);
        if (!block || (candidate.after !== null && (typeof candidate.after !== 'string' || candidate.after.length > 200))) return null;
        ops.push({ op: 'insert', block, after: candidate.after as string | null });
        break;
      }
      case 'update': {
        if (!validExistingKeys(candidate, ['op', 'id', 'block', 'expectRev'], agent) || typeof candidate.id !== 'string' || !candidate.id || candidate.id.length > 200) return null;
        const block = parsePageBlockInput(candidate.block);
        if (!block) return null;
        ops.push({ op: 'update', id: candidate.id, block, ...(candidate.expectRev === undefined ? {} : { expectRev: candidate.expectRev as number }) });
        break;
      }
      case 'delete':
      case 'release': {
        if (candidate.op === 'release' && agent) return null;
        if (!validExistingKeys(candidate, ['op', 'id', 'expectRev'], agent) || typeof candidate.id !== 'string' || !candidate.id || candidate.id.length > 200) return null;
        ops.push({ op: candidate.op, id: candidate.id, ...(candidate.expectRev === undefined ? {} : { expectRev: candidate.expectRev as number }) } as PageEditOp);
        break;
      }
      case 'move': {
        if (!validExistingKeys(candidate, ['op', 'id', 'after', 'expectRev'], agent) || typeof candidate.id !== 'string' || !candidate.id || candidate.id.length > 200 || !('after' in candidate)) return null;
        if (candidate.after !== null && (typeof candidate.after !== 'string' || candidate.after.length > 200)) return null;
        ops.push({ op: 'move', id: candidate.id, after: candidate.after as string | null, ...(candidate.expectRev === undefined ? {} : { expectRev: candidate.expectRev as number }) });
        break;
      }
      default: return null;
    }
  }
  return ops;
}

function stableEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function addSource(sources: BlockSource[] | undefined, source: BlockSource): BlockSource[] {
  const prior = sources ?? [];
  return prior.some((item) => item.nodeId === source.nodeId && item.turnId === source.turnId && item.assistantId === source.assistantId)
    ? prior : [...prior, source];
}

function reject(index: number, reason: PageOpRejection['reason'], message: string): PageOpRejection {
  return { index, reason, message };
}

/** Pure ordered block edit. User batches are atomic failures; agents receive per-op rejections. */
export function applyPageOps(
  initialBlocks: PageBlock[],
  ops: readonly PageEditOp[],
  actor: PageActorContext,
): ApplyPageOpsResult {
  if (!Number.isSafeInteger(actor.revision) || actor.revision < 1 || !Number.isSafeInteger(actor.now) || actor.now < 0) throw new Error('Invalid page actor revision or timestamp');
  if (actor.actor === 'agent' && !actor.source) throw new Error('Agent page edits require trusted source metadata');
  if (actor.actor === 'user' && actor.source !== undefined) throw new Error('User page edits cannot supply agent source metadata');
  const source = actor.source && parseBlockSource(actor.source);
  if (actor.actor === 'agent' && !source) throw new Error('Invalid agent source metadata');
  let blocks = initialBlocks;
  const touched: PageTargetChange[] = [];
  const deleted: PageTargetChange[] = [];
  const rejected: PageOpRejection[] = [];
  const rejectOrThrow = (index: number, reason: PageOpRejection['reason'], message: string): boolean => {
    if (actor.actor === 'agent') { rejected.push(reject(index, reason, message)); return true; }
    throw new Error(`Page operation ${index}: ${message}`);
  };

  ops.forEach((op, opIndex) => {
    const ensureMutable = () => { if (blocks === initialBlocks) blocks = [...initialBlocks]; };
    if (op.op === 'insert') {
      const at = insertionIndex(blocks, op.after);
      if (at === null) { rejectOrThrow(opIndex, 'missing', 'Insertion anchor does not exist'); return; }
      const id = actor.newId?.();
      if (!id || id.length > 200 || blocks.some((block) => block.id === id)) { rejectOrThrow(opIndex, 'invalid', 'A unique server assigned block id is required'); return; }
      const parsedContent = parsePageBlockInput(op.block);
      const content = parsedContent && (actor.actor === 'user' ? retainUserPageSegmentSources(parsedContent) : parsedContent);
      if (!content) { rejectOrThrow(opIndex, 'invalid', 'Invalid block content'); return; }
      const block = { ...content, id, rev: actor.revision,
        ...(actor.actor === 'user' ? { edit: { at: actor.now } as BlockEdit } : { sources: [source as BlockSource] }) } as PageBlock;
      ensureMutable();
      const before = missingBlockSnapshot();
      blocks.splice(at, 0, block);
      const after = snapshotBlock(blocks, at);
      touched.push({ id, op: 'insert', before, after });
      return;
    }

    const index = blocks.findIndex((block) => block.id === op.id);
    if (index < 0) { rejectOrThrow(opIndex, 'missing', `Block ${op.id} does not exist`); return; }
    const current = blocks[index];
    if (op.expectRev !== undefined && op.expectRev !== current.rev) { rejectOrThrow(opIndex, 'stale', `Block ${op.id} revision changed`); return; }
    if (actor.actor === 'agent' && op.expectRev === undefined) { rejectOrThrow(opIndex, 'invalid', 'Agent operation requires expectRev'); return; }
    const before = snapshotBlock(blocks, index);

    if (op.op === 'delete') {
      ensureMutable();
      blocks.splice(index, 1);
      const change = { id: current.id, op: 'delete' as const, before, after: missingBlockSnapshot() };
      touched.push(change); deleted.push(change); return;
    }
    if (op.op === 'release') {
      if (!current.edit) return;
      ensureMutable();
      const released = { ...current, rev: actor.revision } as PageBlock;
      delete (released as { edit?: BlockEdit }).edit;
      blocks[index] = released;
      touched.push({ id: current.id, op: 'release', before, after: snapshotBlock(blocks, index) });
      return;
    }
    if (op.op === 'update') {
      const parsedContent = parsePageBlockInput(op.block);
      const content = parsedContent && (actor.actor === 'user' ? retainUserPageSegmentSources(parsedContent, current) : parsedContent);
      if (!content || content.type !== current.type) { rejectOrThrow(opIndex, 'invalid', 'Updated content must be valid and retain the block type'); return; }
      const currentContent = Object.fromEntries(Object.entries(current).filter(([key]) => !['id', 'rev', 'sources', 'edit'].includes(key)));
      if (stableEqual(currentContent, content) && (actor.actor === 'agent'
        ? !!source && addSource(current.sources, source) === current.sources
        : !!current.edit)) return;
      const next: PageBlock = { ...content, id: current.id, rev: actor.revision,
        ...(current.sources === undefined ? {} : { sources: current.sources }),
        ...(actor.actor === 'user' ? { edit: { at: actor.now } } : current.edit ? { edit: current.edit } : {}),
      } as PageBlock;
      if (source) next.sources = addSource(current.sources, source);
      if (stableEqual(current, next)) return;
      ensureMutable(); blocks[index] = next;
      touched.push({ id: current.id, op: 'update', before, after: snapshotBlock(blocks, index) });
      return;
    }
    if (op.op === 'move') {
      if (op.after === current.id) return;
      const without = blocks.filter((block) => block.id !== current.id);
      const target = insertionIndex(without, op.after);
      if (target === null) { rejectOrThrow(opIndex, 'missing', 'Move anchor does not exist'); return; }
      const beforeWithout = blocks;
      if (target === index || (op.after === null && index === 0) || (op.after !== null && blocks[index - 1]?.id === op.after)) return;
      const nextBlock: PageBlock = { ...current, rev: actor.revision,
        ...(actor.actor === 'user' ? { edit: { at: actor.now } } : {}),
      };
      if (source) nextBlock.sources = addSource(current.sources, source);
      ensureMutable();
      blocks.splice(index, 1);
      const adjusted = insertionIndex(blocks, op.after);
      if (adjusted === null) { blocks = beforeWithout; rejectOrThrow(opIndex, 'missing', 'Move anchor does not exist'); return; }
      blocks.splice(adjusted, 0, nextBlock);
      touched.push({ id: current.id, op: 'move', before, after: snapshotBlock(blocks, adjusted) });
    }
  });
  return { blocks, touched, deleted, rejected };
}
