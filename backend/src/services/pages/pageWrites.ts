import { agentPageOpProblem, applyPageOps, parseAgentPageOps, parseUserPageOps } from 'michi-shared';
import { blockLocation } from 'michi-shared';
import { parseChangeSource } from 'michi-shared';
import type { AgentPageEditOp, BlockLocation, BlockSource, ChangeSource, MaintenanceResourceRef, PageChangeDto, PageDto, PageWriteResult, TargetMutation, TargetSnapshot } from 'michi-shared';
import { assertPageRequestSize, invalidatePages, newPageId, PageWriteError, pagesTransaction, requireChatChangeSource, type ChatChangeSource } from './core';
import { assertNoNewTaskBoardOnHome, getPage, pageConversationIds, savePageContent, validateConversationReferences, validatePageReferences } from './repository';
import { pinHumanPageComponentBlocks } from './componentReferences';
import { canonical } from './canonicalJson';
import { dismissPendingProposals, getTargetHead, insertChange, setTargetHead } from './historyRepository';
import {
  assertMaintenanceAuthority, assertMaintenanceResourceCurrent, getMaintenancePlan, getMaintenanceReceipt,
  maintenanceOperationKey, persistMaintenanceReceiptInTransaction,
} from './maintenanceRepository';
import type { AuthorityInput } from './maintenanceRepository';
import { validateMaintenanceSegmentSourceReferences, validateSegmentSourceReferences } from './segmentSources';

export { PageWriteError, pagesTransaction, newPageId, invalidatePages, assertPageRequestSize, requireChatChangeSource };
export type { ChatChangeSource };

const MAX_BLOCKS = 40;
const MAX_OPS = 50;
type BlockSnapshot = Extract<TargetSnapshot, { kind: 'block' }>;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const sameCanonical = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export interface ApplyMaintenancePageSetInput {
  workspaceId: string;
  ownerUserId: string;
  pageId: string;
  expectedRevision: number;
  source: Extract<ChangeSource, { kind: 'maintenance' }>;
  evidence: BlockSource;
  operationKey: string;
  payloadHash: string;
  planId: string;
  sourceTurnId: string;
  generation: number;
  ops: unknown;
  assignedIds: { blockIds: string[] };
  execution: BlockSource & { runId: string };
  authority: AuthorityInput;
  now: number;
}

function safeNow(value?: number): number {
  const now = value ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new PageWriteError(400, 'invalid', 'Invalid timestamp');
  return now;
}

function pageSnapshot(page: PageDto, blocks: PageDto['blocks'], revision: number): PageDto {
  return { ...page, blocks, revision };
}

function blockSnapshot(block: PageDto['blocks'][number] | undefined, location: BlockLocation | null, id: string): BlockSnapshot {
  return block && location
    ? { kind: 'block', exists: true, block, location }
    : { kind: 'block', exists: false, id, location: null };
}

function currentLocation(blocks: PageDto['blocks'], id: string): BlockLocation | null {
  const index = blocks.findIndex((block) => block.id === id);
  return index < 0 ? null : blockLocation(blocks, index);
}

function location(snapshot: BlockSnapshot): BlockLocation | null {
  return snapshot.kind === 'block' && snapshot.exists ? snapshot.location : null;
}

function changeOp(before: BlockSnapshot, after: BlockSnapshot): PageChangeDto['op'] {
  if (!before.exists && after.exists) return 'insert';
  if (before.exists && !after.exists) return 'delete';
  if (before.exists && after.exists && !same(before.location, after.location)) {
    const content = (block: typeof before.block) => Object.fromEntries(Object.entries(block).filter(([key]) => !['rev', 'sources', 'edit'].includes(key)));
    if (same(content(before.block), content(after.block))) return 'move';
  }
  return 'update';
}

function toMutationPair(before: BlockSnapshot, after: BlockSnapshot, id: string): { forward: TargetMutation; inverse: TargetMutation } {
  const beforeLocation = location(before);
  const afterLocation = location(after);
  if (!before.exists && after.exists) {
    return {
      forward: { kind: 'block', op: 'upsert', block: after.block, location: after.location },
      inverse: { kind: 'block', op: 'delete', id, expectedLocation: after.location },
    };
  }
  if (before.exists && !after.exists) {
    return {
      forward: { kind: 'block', op: 'delete', id, expectedLocation: before.location },
      inverse: { kind: 'block', op: 'upsert', block: before.block, location: before.location },
    };
  }
  if (!before.exists || !after.exists || !beforeLocation || !afterLocation) throw new PageWriteError(400, 'invalid', 'Invalid block history snapshots');
  return {
    forward: { kind: 'block', op: 'upsert', block: after.block, location: after.location },
    inverse: { kind: 'block', op: 'upsert', block: before.block, location: before.location },
  };
}

export function writeChanges(args: {
  page: PageDto; owner: string; source: ChangeSource; batchId: string; now: number; appliedRev: number;
  /** A record's own `source` (a home write cites per block) wins over the write's. */
  records: Array<{ id: string; before: BlockSnapshot; after: BlockSnapshot; proposal: boolean; source?: ChangeSource }>;
}): PageChangeDto[] {
  const written: PageChangeDto[] = [];
  for (const record of args.records) {
    const target = { kind: 'block' as const, pageId: args.page.id, blockId: record.id };
    const priorHead = getTargetHead(args.page.workspaceId, target);
    const currentRevision = record.before.kind === 'block' && record.before.exists
      ? record.before.block.rev : priorHead?.targetRevision ?? args.page.revision;
    const pair = toMutationPair(record.before, record.after, record.id);
    const change: Omit<PageChangeDto, 'seq'> = {
      id: newPageId('chg'), batchId: args.batchId, target,
      op: changeOp(record.before, record.after), before: record.before, after: record.after,
      forward: pair.forward, inverse: pair.inverse, baseRev: currentRevision,
      appliedRev: record.proposal ? null : args.appliedRev, previousHeadId: priorHead?.headId ?? null,
      source: record.source ?? args.source, proposalState: record.proposal ? 'pending' : null,
      applicationState: record.proposal ? null : 'applied', createdAt: args.now, resolvedAt: null,
    };
    written.push(insertChange(args.owner, args.page.workspaceId, change));
    if (!record.proposal) {
      const nextRevision = record.after.kind === 'block' && record.after.exists
        ? Math.max((priorHead?.targetRevision ?? currentRevision) + 1, record.after.block.rev)
        : Math.max((priorHead?.targetRevision ?? currentRevision) + 1, args.appliedRev);
      setTargetHead(args.page.workspaceId, target, { headId: change.id, targetRevision: nextRevision });
      if (record.after.kind === 'block' && !record.after.exists) {
        dismissPendingProposals(args.page.workspaceId, target, args.now);
      }
    }
  }
  return written;
}

function result(page: PageDto, changes: PageChangeDto[], rejected: PageWriteResult['rejected']): PageWriteResult {
  return {
    resource: { kind: 'page', id: page.id }, revision: page.revision,
    applied: changes.filter((change) => change.proposalState === null),
    proposed: changes.filter((change) => change.proposalState === 'pending'), rejected,
  };
}

export type AgentEditPlan = {
  working: PageDto['blocks'];
  /** `index` is the operation that made the record. */
  records: Array<{ id: string; index: number; before: BlockSnapshot; after: BlockSnapshot; proposal: boolean }>;
  rejected: PageWriteResult['rejected'];
};

/** A completed interactive write, including the version the renderer may fetch. */
export interface AgentPageWriteResult extends PageWriteResult {
  viewVersion: number;
  atomic: boolean;
  commitStatus: 'committed' | 'partial' | 'proposed' | 'rejected' | 'unchanged';
}

function agentResult(page: PageDto, changes: PageChangeDto[], rejected: PageWriteResult['rejected'], atomic: boolean): AgentPageWriteResult {
  const written = result(page, changes, rejected);
  const mixed = written.applied.length > 0 && written.proposed.length > 0;
  const commitStatus = changes.length && (rejected.length || mixed) ? 'partial'
    : written.applied.length ? 'committed'
    : written.proposed.length ? 'proposed'
    : rejected.length ? 'rejected' : 'unchanged';
  return { ...written, viewVersion: page.viewVersion, atomic, commitStatus };
}

/** Plans ordered agent edits. Maintenance uses the same planner but requires the entire plan to succeed. */
export function planAgentEdits(args: {
  page: PageDto; ownerUserId: string; source: BlockSource; rawOps: readonly unknown[]; now: number;
  assignedIds?: readonly string[]; atomic?: boolean;
}): AgentEditPlan {
  // Invalid evidence aborts the batch before any operation is planned or any history can be persisted.
  const inputs = args.rawOps.flatMap(raw => {
    const op = parseAgentPageOps([raw])?.[0];
    return op && (op.op === 'insert' || op.op === 'update') ? [op.block] : [];
  });
  validateSegmentSourceReferences(args.page.workspaceId, args.ownerUserId, inputs, args.page.blocks);
  let working = args.page.blocks;
  const rejected: PageWriteResult['rejected'] = [];
  const records: AgentEditPlan['records'] = [];
  const seenTargets = new Set<string>();
  const nextRev = args.page.revision + 1;
  let assignedIndex = 0;
  const reject = (index: number, reason: PageWriteResult['rejected'][number]['reason'], message: string) => {
    rejected.push({ index, reason, message });
    if (args.atomic) throw new PageWriteError(409, 'stale_revision', `Maintenance operation ${index} rejected: ${message}`);
  };
  args.rawOps.forEach((raw, index) => {
    const parsed = parseAgentPageOps([raw]);
    if (!parsed) { reject(index, 'invalid', `Invalid agent page operation: ${agentPageOpProblem(raw)}`); return; }
    const op: AgentPageEditOp = parsed[0]!;
    const assignedId = op.op === 'insert' && args.assignedIds ? args.assignedIds[assignedIndex++] : undefined;
    const id = op.op === 'insert' ? null : op.id;
    if (id && seenTargets.has(id)) { reject(index, 'invalid', `Block ${id} is already targeted in this call`); return; }
    if (id) seenTargets.add(id);
    let candidate: ReturnType<typeof applyPageOps>;
    try {
      candidate = applyPageOps(working, [op], {
        actor: 'agent', source: args.source, revision: nextRev, now: args.now,
        newId: () => args.assignedIds ? assignedId ?? '' : newPageId('block'),
      });
    } catch (error) {
      reject(index, 'invalid', error instanceof Error ? error.message : 'Invalid page operation');
      return;
    }
    const failure = candidate.rejected[0];
    if (failure) { reject(index, failure.reason, failure.message); return; }
    if (candidate.blocks.length > MAX_BLOCKS) { reject(index, 'invalid', 'A page may contain at most 40 blocks'); return; }
    // Hard error, not a soft rejection: a proposal that adds a board could never be accepted.
    assertNoNewTaskBoardOnHome(args.page.workspaceId, args.ownerUserId, candidate.blocks, working);
    try {
      validatePageReferences(args.page.workspaceId, args.ownerUserId, candidate.blocks);
      const written = candidate.blocks.find((block) => block.id === candidate.touched[0]?.id);
      if (written) validateConversationReferences(args.page.workspaceId, [written], pageConversationIds(working), true);
    }
    catch (error) {
      reject(index, 'invalid', error instanceof Error ? error.message : 'Invalid page references');
      return;
    }
    const touched = candidate.touched[0];
    if (!touched) return;
    const touchedBlock = candidate.blocks.find((block) => block.id === touched.id);
    if (touchedBlock) {
      const normalized = pinHumanPageComponentBlocks([touchedBlock], args.page.workspaceId, args.ownerUserId)[0]!;
      if (normalized !== touchedBlock) candidate = { ...candidate, blocks: candidate.blocks.map((block) => block.id === touched.id ? normalized : block) };
    }
    const beforeBlock = working.find((block) => block.id === touched.id);
    const afterBlock = candidate.blocks.find((block) => block.id === touched.id);
    const before = blockSnapshot(beforeBlock, touched.before.location, touched.id);
    const after = blockSnapshot(afterBlock, currentLocation(candidate.blocks, touched.id), touched.id);
    const proposal = !!beforeBlock?.edit;
    records.push({ id: touched.id, index, before, after, proposal });
    if (!proposal) working = candidate.blocks;
  });
  return { working, records, rejected };
}

function userEdit(args: { pageId: string; ownerUserId: string; revision: number; ops: unknown; now?: number }): PageWriteResult {
  assertPageRequestSize(args.ops);
  const now = safeNow(args.now);
  if (!Number.isSafeInteger(args.revision) || args.revision < 1) throw new PageWriteError(400, 'invalid', 'Invalid page revision');
  const ops = parseUserPageOps(args.ops);
  if (!ops) throw new PageWriteError(400, 'invalid', 'Invalid page edit operations');
  if (ops.length > MAX_OPS) throw new PageWriteError(400, 'invalid', 'Too many page edit operations');
  return pagesTransaction(() => {
    const page = getPage(args.pageId, args.ownerUserId, { write: true });
    if (page.revision !== args.revision) throw new PageWriteError(409, 'stale_revision', 'Page revision changed');
    const revision = page.revision + 1;
    let changed: ReturnType<typeof applyPageOps>;
    try {
      changed = applyPageOps(page.blocks, ops, { actor: 'user', revision, now, newId: () => newPageId('block') });
      const touchedIds = new Set(changed.touched.map((entry) => entry.id));
      const touchedBlocks = changed.blocks.filter((block) => touchedIds.has(block.id));
      const normalized = new Map(pinHumanPageComponentBlocks(touchedBlocks, page.workspaceId, args.ownerUserId).map((block) => [block.id, block]));
      changed = { ...changed, blocks: changed.blocks.map((block) => normalized.get(block.id) ?? block) };
    }
    catch (error) {
      if (error instanceof PageWriteError) throw error;
      throw new PageWriteError(400, 'invalid', error instanceof Error ? error.message : 'Invalid page operation');
    }
    if (changed.blocks.length > MAX_BLOCKS) throw new PageWriteError(400, 'invalid', 'A page may contain at most 40 blocks');
    if (!changed.touched.length) return result(page, [], []);
    validatePageReferences(page.workspaceId, args.ownerUserId, changed.blocks);
    const touchedIds = new Set(changed.touched.map((entry) => entry.id));
    validateConversationReferences(page.workspaceId, changed.blocks.filter((block) => touchedIds.has(block.id)), pageConversationIds(page.blocks), true);

    const initial = new Map(page.blocks.map((block) => [block.id, block]));
    const final = new Map(changed.blocks.map((block) => [block.id, block]));
    const ids = new Set([...initial.keys(), ...final.keys()]);
    const records: Array<{ id: string; before: BlockSnapshot; after: BlockSnapshot; proposal: boolean }> = [];
    for (const id of ids) {
      const targetChanges = changed.touched.filter((entry) => entry.id === id);
      if (!targetChanges.length) continue;
      const beforeBlock = initial.get(id);
      const afterBlock = final.get(id);
      if (beforeBlock && afterBlock && same(beforeBlock, afterBlock)) continue;
      records.push({
        id,
        before: blockSnapshot(beforeBlock, currentLocation(page.blocks, id), id),
        after: blockSnapshot(afterBlock, currentLocation(changed.blocks, id), id),
        proposal: false,
      });
    }
    if (!records.length) return result(page, [], []);
    const updated = savePageContent(page.id, args.ownerUserId, pageSnapshot(page, changed.blocks, revision), { source: { kind: 'user' }, now, expectedRevision: page.revision });
    const changes = writeChanges({ page, owner: args.ownerUserId, source: { kind: 'user' }, batchId: newPageId('batch'), now, appliedRev: updated.revision, records });
    invalidatePages([page.id], now, 'user');
    return result(getPage(page.id, args.ownerUserId), changes, []);
  });
}

export function applyUserPageEdits(args: { pageId: string; ownerUserId: string; revision: number; ops: unknown; now?: number }): PageWriteResult {
  return userEdit(args);
}

export function applyAgentPageEdits(args: {
  pageId: string; workspaceId: string; ownerUserId: string; source: ChatChangeSource; ops: unknown; now?: number;
  /** Publish one coherent group, or leave both content and history unchanged. */
  atomic?: boolean;
}): AgentPageWriteResult {
  assertPageRequestSize(args.ops);
  const now = safeNow(args.now);
  if (!Array.isArray(args.ops) || args.ops.length > MAX_OPS) throw new PageWriteError(400, 'invalid', 'Invalid page edit operations');
  return pagesTransaction(() => {
    const page = getPage(args.pageId, args.ownerUserId, { write: true });
    if (page.workspaceId !== args.workspaceId) throw new PageWriteError(404, 'not_found', 'Page not found');
    requireChatChangeSource(page.workspaceId, args.ownerUserId, args.source, page.id);
    const planned = planAgentEdits({ page, ownerUserId: args.ownerUserId,
      source: { nodeId: args.source.nodeId, turnId: args.source.turnId, assistantId: args.source.assistantId },
      rawOps: args.ops as unknown[], now });
    const { working, rejected, records } = planned;

    if (args.atomic) {
      const mixedOwnership = records.some((record) => record.proposal) && records.some((record) => !record.proposal);
      if (rejected.length || mixedOwnership) {
        const reasons = new Map(rejected.map((entry) => [entry.index, entry]));
        const message = mixedOwnership
          ? 'Atomic page edits cannot combine immediate changes with protected-content proposals. Nothing was saved. Submit only independent changes separately, or submit the protected changes as proposals.'
          : `Atomic page edit was not committed because operation ${rejected[0]!.index} was rejected. Nothing was saved; reread the page and submit the complete corrected group.`;
        return agentResult(page, [], (args.ops as unknown[]).map((_op, index) => reasons.get(index)
          ?? { index, reason: 'invalid' as const, message }), true);
      }
    }

    const contentChanged = !same(working, page.blocks);
    let updated = page;
    if (contentChanged) {
      updated = savePageContent(page.id, args.ownerUserId, pageSnapshot(page, working, page.revision + 1), { source: args.source, now, expectedRevision: page.revision });
    }
    const changes = records.length
      ? writeChanges({ page, owner: args.ownerUserId, source: args.source, batchId: newPageId('batch'), now, appliedRev: updated.revision, records })
      : [];
    if (changes.length) invalidatePages([page.id], now, 'agent');
    return agentResult(changes.length ? getPage(page.id, args.ownerUserId) : updated, changes, rejected, args.atomic === true);
  });
}

/** Applies a frozen maintenance page edit set and commits its receipt in the same savepoint. */
export function applyMaintenancePageSet(args: ApplyMaintenancePageSetInput): PageWriteResult {
  assertPageRequestSize(args.ops);
  const now = safeNow(args.now);
  if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 1 ||
      !Number.isSafeInteger(args.generation) || args.generation < 1) {
    throw new PageWriteError(400, 'invalid', 'Invalid maintenance page revision or generation');
  }
  if (!Array.isArray(args.ops) || args.ops.length < 1 || args.ops.length > MAX_OPS) {
    throw new PageWriteError(400, 'invalid', 'Maintenance operation set must contain 1-50 operations');
  }
  const parsedOps = parseAgentPageOps(args.ops);
  if (!parsedOps || !sameCanonical(parsedOps, args.ops)) throw new PageWriteError(400, 'invalid', 'Maintenance operations must be normalized agent page operations');
  const insertCount = parsedOps.filter((op) => op.op === 'insert').length;
  if (!args.assignedIds || !Array.isArray(args.assignedIds.blockIds) || args.assignedIds.blockIds.length !== insertCount ||
      args.assignedIds.blockIds.some((id) => typeof id !== 'string' || !id.trim() || id.length > 200) ||
      new Set(args.assignedIds.blockIds).size !== insertCount) {
    throw new PageWriteError(400, 'invalid', 'Frozen maintenance block IDs do not match the operation set');
  }
  if (!args.evidence || !args.source || !parseChangeSource(args.source) || args.source.kind !== 'maintenance' ||
      args.workspaceId !== args.authority.workspaceId || args.ownerUserId !== args.authority.ownerUserId ||
      args.source.jobId !== args.authority.jobId || args.source.runId !== args.authority.runId ||
      args.source.runId !== args.execution.runId || args.source.nodeId !== args.execution.nodeId ||
      args.source.turnId !== args.execution.turnId || args.source.assistantId !== args.execution.assistantId ||
      !same(args.source.evidence, [args.evidence])) {
    throw new PageWriteError(400, 'invalid', 'Invalid maintenance page provenance');
  }
  const expectedResource: MaintenanceResourceRef = { kind: 'page', id: args.pageId, revision: args.expectedRevision, pageIds: [args.pageId] };
  const expectedOperationKey = maintenanceOperationKey(args.authority.jobId, args.sourceTurnId, 'page', args.pageId, args.generation);
  const payload = canonical({ ops: parsedOps });
  if (args.operationKey !== expectedOperationKey || typeof args.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(args.payloadHash) ||
      typeof args.planId !== 'string' || !args.planId.trim() || typeof args.sourceTurnId !== 'string' || !args.sourceTurnId.trim()) {
    throw new PageWriteError(400, 'invalid', 'Invalid maintenance operation identity');
  }
  return pagesTransaction(() => {
    assertMaintenanceAuthority(args.authority, now);
    const plan = getMaintenancePlan(args.planId, args.ownerUserId);
    if (!plan || plan.workspaceId !== args.workspaceId || plan.jobId !== args.authority.jobId ||
        plan.runId !== args.authority.runId || plan.configRevision !== args.authority.configRevision || plan.generation !== args.generation) {
      throw new PageWriteError(404, 'not_found', 'Maintenance plan not found');
    }
    const sourcePlan = plan.sources.find((source) => source.sourceTurnId === args.sourceTurnId);
    if (!sourcePlan || !same(sourcePlan.evidence, args.evidence)) throw new PageWriteError(404, 'not_found', 'Maintenance source is not in the plan');

    const existing = getMaintenanceReceipt(args.operationKey);
    if (existing) {
      if (existing.planId !== args.planId || existing.jobId !== args.authority.jobId || existing.sourceTurnId !== args.sourceTurnId ||
          existing.generation !== args.generation || existing.payloadHash !== args.payloadHash ||
          !sameCanonical(existing.payload, payload) || !sameCanonical(existing.assignedIds, args.assignedIds) || !sameCanonical(existing.evidence, args.evidence)) {
        throw new PageWriteError(409, 'stale_revision', 'Maintenance receipt does not match this operation set');
      }
      const saved = existing.result as PageWriteResult;
      if (!saved || saved.resource?.kind !== 'page' || saved.resource.id !== args.pageId || !Array.isArray(saved.applied) ||
          !Array.isArray(saved.proposed) || !Array.isArray(saved.rejected)) {
        throw new PageWriteError(409, 'stale_revision', 'Stored maintenance receipt has an invalid page result');
      }
      return saved;
    }
    if (!sourcePlan.routingComplete) throw new PageWriteError(409, 'stale_revision', 'Maintenance source routing is incomplete');
    const routed = sourcePlan.candidates.find((resource) => resource.kind === 'page' && resource.id === args.pageId);
    if (!routed || !same(routed, expectedResource)) throw new PageWriteError(409, 'stale_revision', 'Maintenance page differs from its routed resource');

    const page = getPage(args.pageId, args.ownerUserId, { write: true });
    if (page.workspaceId !== args.workspaceId) throw new PageWriteError(404, 'not_found', 'Page not found');
    if (page.revision !== args.expectedRevision) throw new PageWriteError(409, 'stale_revision', 'Page revision changed');
    if (args.assignedIds.blockIds.some((id) => page.blocks.some((block) => block.id === id))) {
      throw new PageWriteError(409, 'stale_revision', 'Frozen maintenance block ID already exists on the page');
    }
    assertMaintenanceResourceCurrent({ workspaceId: args.workspaceId, ownerUserId: args.ownerUserId,
      planId: args.planId, sourceTurnId: args.sourceTurnId, resource: expectedResource });
    validateMaintenanceSegmentSourceReferences(page.workspaceId, args.ownerUserId,
      parsedOps.flatMap(op => op.op === 'insert' || op.op === 'update' ? [op.block] : []), page.blocks, args.evidence);
    const planned = planAgentEdits({ page, ownerUserId: args.ownerUserId,
      source: { nodeId: args.source.nodeId, turnId: args.source.turnId, assistantId: args.source.assistantId },
      rawOps: parsedOps, now, assignedIds: args.assignedIds.blockIds, atomic: true });
    if (planned.records.length === 0) throw new PageWriteError(400, 'invalid', 'Maintenance operation set made no change; record an explicit no-change decision');

    const contentChanged = !same(planned.working, page.blocks);
    const updated = contentChanged
      ? savePageContent(page.id, args.ownerUserId, pageSnapshot(page, planned.working, page.revision + 1),
        { source: args.source, now, expectedRevision: page.revision })
      : page;
    const changes = writeChanges({ page, owner: args.ownerUserId, source: args.source, batchId: newPageId('batch'), now,
      appliedRev: updated.revision, records: planned.records });
    if (!changes.length) throw new PageWriteError(400, 'invalid', 'Maintenance operation set made no change; record an explicit no-change decision');
    if (contentChanged || changes.length) invalidatePages([page.id], now, 'agent');
    const pageResult = result(changes.length ? getPage(page.id, args.ownerUserId) : updated, changes, []);
    persistMaintenanceReceiptInTransaction({ ...args.authority, planId: args.planId, sourceTurnId: args.sourceTurnId,
      resource: expectedResource, outcome: pageResult.applied.length ? 'written' : 'proposed', payloadHash: args.payloadHash,
      payload, assignedIds: args.assignedIds, result: pageResult, execution: args.execution, evidence: args.evidence, now });
    return pageResult;
  });
}
