import { createHash } from 'node:crypto';
import { parseAgentPageOps, parseChangeSource, type BlockSource, type ChangeEvidence, type ChangeReadScope, type ChangeSource, type PageWriteResult } from 'michi-shared';
import { PageWriteError, invalidatePages, newPageId, pagesTransaction } from '../pages/core';
import { getPage, savePageContent } from '../pages/repository';
import { planAgentEdits, writeChanges } from '../pages/pageWrites';

const MAX_OPS = 50;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}

/** An insert with after null lands at the top, and a call cannot name the ids it assigns. */
export const HOME_WRITE_ORDER_NOTE = 'An insert with after null goes to the top of the page, and a call cannot refer to blocks it inserts itself: to add several blocks in reading order, list the inserts last block first (all with after null), or anchor each one to an existing block id.';

/** Identifies an operation set so an exact retry replays its receipt. */
export function homeWritePayloadHash(pageId: string, ops: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical({ pageId, ops }))).digest('hex');
}

export function parseHomeWriteOps(raw: unknown) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_OPS) throw new PageWriteError(400, 'invalid', 'Page operation set must contain 1-50 operations');
  const ops = parseAgentPageOps(raw);
  if (!ops) throw new PageWriteError(400, 'invalid', 'Invalid page operations');
  return ops;
}

export interface HomeWriteInput {
  ownerUserId: string;
  pageId: string;
  ops: unknown;
  /** The scheduled maintenance turn doing the write. */
  execution: BlockSource & { runId: string };
  jobId: string;
  /** Per operation index: the messages that block cites (first run), checked by the caller. */
  evidence: ReadonlyArray<readonly ChangeEvidence[]>;
  /** What the run read: its conversations (first run) or the workspace homes (Spaces Home summary). */
  read: ChangeReadScope | null;
  now: number;
}

/**
 * Writes a home page as the Meta agent, with change records that can be undone
 * one by one. Each block's record cites the messages named for it and says
 * what the run read. The whole set is planned or none of it: a block a person
 * edited is never changed in place, its change becomes a proposal. The caller
 * checks run authority in the same transaction.
 */
export function writeHomePage(input: HomeWriteInput): PageWriteResult {
  const ops = parseHomeWriteOps(input.ops);
  const blockSource: BlockSource = { nodeId: input.execution.nodeId, turnId: input.execution.turnId, assistantId: input.execution.assistantId };
  const sourceWith = (evidence: readonly ChangeEvidence[]): ChangeSource => ({ kind: 'maintenance', ...blockSource, jobId: input.jobId,
    runId: input.execution.runId, evidence: evidence.slice(0, 100), ...(input.read ? { read: input.read } : {}) });
  const source = sourceWith([]);
  const recordSources = ops.map((_op, index) => sourceWith(input.evidence[index] ?? []));
  if (![source, ...recordSources].every((candidate) => parseChangeSource(candidate))) throw new PageWriteError(400, 'invalid', 'Invalid maintenance provenance');
  return pagesTransaction(() => {
    const page = getPage(input.pageId, input.ownerUserId, { write: true });
    const planned = planAgentEdits({ page, ownerUserId: input.ownerUserId, source: blockSource, rawOps: ops, now: input.now, atomic: true });
    if (!planned.records.length) throw new PageWriteError(400, 'invalid', 'The operation set made no change; record an explicit no-change decision');
    const updated = same(planned.working, page.blocks) ? page
      : savePageContent(page.id, input.ownerUserId, { ...page, blocks: planned.working, revision: page.revision + 1 },
        { source, now: input.now, expectedRevision: page.revision });
    const changes = writeChanges({ page, owner: input.ownerUserId, source, batchId: newPageId('batch'), now: input.now,
      appliedRev: updated.revision, records: planned.records.map((record) => ({ ...record, source: recordSources[record.index] ?? source })) });
    invalidatePages([page.id], input.now, 'agent');
    return { resource: { kind: 'page', id: page.id }, revision: getPage(page.id, input.ownerUserId).revision,
      applied: changes.filter((change) => change.proposalState === null),
      proposed: changes.filter((change) => change.proposalState === 'pending'), rejected: [] };
  });
}
