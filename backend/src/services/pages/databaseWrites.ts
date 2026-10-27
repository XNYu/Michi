import {
  applyPageDatabaseOps, parsePageDatabaseOps,
  type PageDatabase, type PageDatabaseEditOp, type PageDatabaseRow,
  type PageDatabaseView,
} from 'michi-shared';
import { MICHI_DB_LIMITS, type MaintenanceReceipt, type MaintenanceResourceRef, type BlockSource } from 'michi-shared';
import type {
  ChangeSource, ChangeTarget, PageChangeDto, PageWriteResult,
  RowLocation, TargetMutation, TargetSnapshot,
} from 'michi-shared';
import {
  invalidateDatabasePages, newPageId, PageWriteError, pagesTransaction,
  requireChatChangeSource,
} from './core';
import { getDatabase, requireDatabaseRecord, saveDatabase } from './repository';
import { getDb } from '../db';
import { dismissPendingProposals, getTargetHead, insertChange, setTargetHead } from './historyRepository';
import { pageComponents } from './components';
import { pinHumanDatabaseViews } from './componentReferences';
import { canonical } from './canonicalJson';
import { assertMaintenanceAuthority, assertMaintenanceResourceCurrent, getMaintenancePlan, getMaintenanceReceipt,
  maintenanceOperationKey, persistMaintenanceReceiptInTransaction, type AuthorityInput } from './maintenanceRepository';

export interface ApplyUserDatabaseEditsInput {
  databaseId: string;
  ownerUserId: string;
  revision: number;
  ops: unknown;
  now?: number;
}
export interface ApplyAgentDbEditsInput {
  databaseId: string;
  workspaceId: string;
  ownerUserId: string;
  source: Extract<ChangeSource, { kind: 'chat' | 'helper' }>;
  ops: unknown;
  now?: number;
}
export interface ApplyComponentDbEditsInput {
  databaseId: string; workspaceId: string; ownerUserId: string; componentId: string; version: number;
  host: { kind: 'database_view'; databaseId: string; viewId: string };
  ops: unknown; authorize: () => void; now?: number;
}
export type ApplyMaintenanceDatabaseSetInput = AuthorityInput & {
  planId: string; sourceTurnId: string; resource: MaintenanceResourceRef; databaseId: string;
  payloadHash: string; payload: unknown; assignedIds: unknown; ops: unknown;
  execution: BlockSource & { runId: string }; evidence: BlockSource; now: number;
};

type Rejected = PageWriteResult['rejected'][number];
type Edit = { op: PageDatabaseEditOp; index: number };

const json = (value: unknown): string => JSON.stringify(value);
const same = (a: unknown, b: unknown): boolean => json(a) === json(b);
const sameCanonical = (a: unknown, b: unknown): boolean => json(canonical(a)) === json(canonical(b));
const safeNow = (value?: number): number => {
  const now = value ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new PageWriteError(400, 'invalid', 'Invalid timestamp');
  return now;
};
const invalid = (message: string): PageWriteError => new PageWriteError(400, 'invalid', message);

function parseOps(raw: unknown, actor: 'user' | 'agent'): PageDatabaseEditOp[] {
  const result = parsePageDatabaseOps(raw, actor);
  if (!result.ok) throw invalid(result.error);
  return result.ops;
}
function parseAgentOps(raw: unknown): { items: Edit[]; rejected: Rejected[] } {
  if (!Array.isArray(raw) || raw.length > MICHI_DB_LIMITS.editOps) throw invalid('invalid operation batch size');
  let bytes: number;
  try { bytes = new TextEncoder().encode(JSON.stringify(raw)).length; } catch { throw invalid('invalid operation payload'); }
  if (bytes > MICHI_DB_LIMITS.editBytes) throw invalid('operation payload too large');
  const items: Edit[] = [];
  const rejected: Rejected[] = [];
  raw.forEach((candidate, index) => {
    const parsed = parsePageDatabaseOps([candidate], 'agent');
    if (parsed.ok) items.push({ op: parsed.ops[0]!, index });
    else rejected.push(rejection(index, 'invalid', parsed.error));
  });
  return { items, rejected };
}

function rowLocation(database: PageDatabase, rowId: string): RowLocation {
  const position = database.rows.findIndex((row) => row.id === rowId);
  if (position < 0) return { position: database.rows.length, after: database.rows.at(-1)?.id ?? null };
  return { position, after: database.rows[position - 1]?.id ?? null };
}
function rowSnapshot(database: PageDatabase, rowId: string): TargetSnapshot {
  const row = database.rows.find((item) => item.id === rowId);
  return row ? { kind: 'row', exists: true, row: structuredClone(row), location: rowLocation(database, rowId) }
    : { kind: 'row', exists: false, id: rowId, location: null };
}
/** The snapshot with the location the row had at that step of a batch (the snapshot's own when unknown). */
function atLocation(snapshot: TargetSnapshot, location: RowLocation | null | undefined): TargetSnapshot {
  return location && snapshot.kind === 'row' && snapshot.exists ? { ...snapshot, location } : snapshot;
}
function dbSnapshot(database: PageDatabase): TargetSnapshot {
  return { kind: 'database', exists: true, database: {
    id: database.id, workspaceId: database.workspaceId, title: database.title,
    columns: structuredClone(database.columns), views: structuredClone(database.views),
    revision: database.revision, updatedAt: database.updatedAt,
  } };
}
function targetRev(target: ChangeTarget, before: TargetSnapshot, fallback: number): number {
  if (target.kind === 'row' && before.kind === 'row' && before.exists) return before.row.rev;
  if (target.kind === 'database' && before.kind === 'database' && before.exists) return before.database.revision;
  return fallback;
}
function targetHead(workspaceId: string, target: ChangeTarget, currentRevision: number) {
  return getTargetHead(workspaceId, target) ?? { headId: null, targetRevision: currentRevision };
}
function recordChange(input: {
  ownerUserId: string; workspaceId: string; batchId: string; target: ChangeTarget;
  op: PageChangeDto['op']; before: TargetSnapshot | null; after: TargetSnapshot | null;
  forward: TargetMutation; inverse: TargetMutation; baseRev: number; appliedRev: number | null;
  source: ChangeSource; now: number; proposal: boolean;
}): PageChangeDto {
  const head = targetHead(input.workspaceId, input.target, input.baseRev);
  const change = insertChange(input.ownerUserId, input.workspaceId, {
    id: newPageId('chg'), batchId: input.batchId, target: input.target, op: input.op,
    before: input.before, after: input.after, forward: input.forward, inverse: input.inverse,
    baseRev: input.baseRev, appliedRev: input.appliedRev, previousHeadId: head.headId,
    source: input.source, proposalState: input.proposal ? 'pending' : null,
    applicationState: input.proposal ? null : 'applied', createdAt: input.now, resolvedAt: null,
  });
  if (!input.proposal) setTargetHead(input.workspaceId, input.target, {
    headId: change.id, targetRevision: Math.max(head.targetRevision + 1, input.appliedRev ?? input.baseRev),
  });
  return change;
}

function rowOwned(row: PageDatabaseRow): boolean { return Object.keys(row.edited).length > 0 || row.bodyEditedAt !== null; }
function protectRowDelete(row: PageDatabaseRow): boolean { return rowOwned(row); }

function rejection(index: number, reason: Rejected['reason'], message: string): Rejected {
  return { index, reason, message };
}
function mapApplyRejection(reason: 'target_missing' | 'revision_conflict'): Rejected['reason'] {
  return reason === 'target_missing' ? 'missing' : 'stale';
}
function isMissingError(message: string): boolean {
  return /missing|not found|target missing/i.test(message);
}

function assertExpectedDatabaseRevision(database: PageDatabase, revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1) throw invalid('A valid database revision is required');
  if (database.revision !== revision) throw new PageWriteError(409, 'stale_revision', 'Database revision changed');
}

/** Apply one ordinary database write as a transaction, with one resource revision and one history batch. */
export function applyUserDatabaseEdits(input: ApplyUserDatabaseEditsInput): PageWriteResult {
  return pagesTransaction(() => {
    const now = safeNow(input.now);
    const current = getDatabase(input.databaseId, input.ownerUserId, { write: true });
    assertExpectedDatabaseRevision(current, input.revision);
    const ops = parseOps(input.ops, 'user');
    const workspaceId = requireDatabaseRecord(input.databaseId, input.ownerUserId, { write: true }).workspace_id;
    const nextRevision = current.revision + 1;
    let working = current;
    const rejected: Rejected[] = [];
    if (ops.length) {
      try {
        const result = applyPageDatabaseOps(working, ops, {
          actor: 'user', revision: nextRevision, now,
          newId: (prefix) => newPageId(prefix === 'row' ? 'row' : prefix === 'col' ? 'column' : 'view'),
        });
        working = result.database;
      } catch (error) {
        throw invalid(error instanceof Error ? error.message : 'Invalid database edit batch');
      }
    }
    if (ops.some((op) => op.op === 'view.save')) working = pinHumanDatabaseViews(working, input.ownerUserId);
    if (!working || same(current, working)) {
      return { resource: { kind: 'database', id: current.id }, revision: current.revision, applied: [], proposed: [], rejected };
    }
    const beforeDb = dbSnapshot(current);
    const afterDb = dbSnapshot(working);
    const schemaOps = ops.filter((op) => op.op.startsWith('column.') || op.op === 'option.add' || op.op.startsWith('view.'));
    const rowOps = ops.filter((op) => op.op.startsWith('row.'));
    const batchId = newPageId('batch');
    const source: ChangeSource = { kind: 'user' };
    const applied: PageChangeDto[] = [];
    if (schemaOps.length && !same({ title: current.title, columns: current.columns, views: current.views }, { title: working.title, columns: working.columns, views: working.views })) {
      const hasSchema = schemaOps.some((op) => op.op.startsWith('column.') || op.op === 'option.add');
      const target: ChangeTarget = { kind: 'database', databaseId: current.id };
      const baseRev = current.revision;
      applied.push(recordChange({ ownerUserId: input.ownerUserId, workspaceId, batchId, target,
        op: hasSchema ? 'schema' : 'view', before: beforeDb, after: afterDb,
        forward: { kind: 'database', op: 'replace', database: { id: working.id, workspaceId: working.workspaceId, title: working.title, columns: working.columns, views: working.views } },
        inverse: { kind: 'database', op: 'replace', database: { id: current.id, workspaceId: current.workspaceId, title: current.title, columns: current.columns, views: current.views } },
        baseRev, appliedRev: working.revision, source, now, proposal: false }));
    }
    const touched = new Set<string>([...current.rows, ...working.rows].map((row) => row.id)
      .filter((id, index, all) => all.indexOf(id) === index && !same(current.rows.find((row) => row.id === id), working.rows.find((row) => row.id === id))));
    for (const rowId of touched) {
      const before = rowSnapshot(current, rowId), after = rowSnapshot(working, rowId);
      if (same(before, after)) continue;
      const rowTarget: ChangeTarget = { kind: 'row', databaseId: current.id, rowId,
        columnIds: [...new Set([...Object.keys(before.kind === 'row' && before.exists ? before.row.values : {}), ...Object.keys(after.kind === 'row' && after.exists ? after.row.values : {})])]
          .filter((columnId) => !same(before.kind === 'row' && before.exists ? before.row.values[columnId] : undefined, after.kind === 'row' && after.exists ? after.row.values[columnId] : undefined) ||
            !same(before.kind === 'row' && before.exists ? before.row.edited[columnId] : undefined, after.kind === 'row' && after.exists ? after.row.edited[columnId] : undefined)).sort(),
        ...(before.kind === 'row' && before.exists && after.kind === 'row' && after.exists && before.row.body === after.row.body ? {} :
          (before.kind === 'row' && before.exists && before.row.body !== undefined || after.kind === 'row' && after.exists && after.row.body !== undefined) ? { body: true as const } : {}) };
      const baseRev = targetRev(rowTarget, before, current.revision);
      const forward: TargetMutation = after.kind === 'row' && after.exists
        ? { kind: 'row', op: 'upsert', row: after.row, location: after.location }
        : { kind: 'row', op: 'delete', id: rowId, expectedLocation: before.kind === 'row' && before.exists ? before.location : rowLocation(current, rowId) };
      const inverse: TargetMutation = before.kind === 'row' && before.exists
        ? { kind: 'row', op: 'upsert', row: before.row, location: before.location }
        : { kind: 'row', op: 'delete', id: rowId, expectedLocation: after.kind === 'row' && after.exists ? after.location : rowLocation(working, rowId) };
      applied.push(recordChange({ ownerUserId: input.ownerUserId, workspaceId, batchId, target: rowTarget, op: 'row', before, after,
        forward, inverse, baseRev, appliedRev: after.kind === 'row' && after.exists ? after.row.rev : working.revision, source, now, proposal: false }));
      if (after.kind === 'row' && !after.exists) dismissPendingProposals(workspaceId, rowTarget, now);
    }
    saveDatabase(working, input.ownerUserId, { now });
    invalidateDatabasePages(current.id, now, 'user');
    return { resource: { kind: 'database', id: current.id }, revision: working.revision, applied, proposed: [], rejected };
  });
}

/** Apply chat row edits with server-owned row IDs and per-cell human ownership protection. */
export function applyAgentDbEdits(input: ApplyAgentDbEditsInput): PageWriteResult {
  return applyAgentDbEditsWithSource(input, input.source, () => requireChatChangeSource(input.workspaceId, input.ownerUserId, input.source));
}

function applyAgentDbEditsWithSource(
  input: Omit<ApplyAgentDbEditsInput, 'source'> & { source?: ChangeSource; now?: number },
  source: ChangeSource,
  authorize: () => void,
  assignedRowIds?: string[],
): PageWriteResult {
  return pagesTransaction(() => {
    const now = safeNow(input.now);
    const record = requireDatabaseRecord(input.databaseId, input.ownerUserId, { write: true });
    if (record.workspace_id !== input.workspaceId) throw new PageWriteError(404, 'not_found', 'Database not found');
    authorize();
    const current = getDatabase(input.databaseId, input.ownerUserId, { write: true });
    const parsedOps = parseAgentOps(input.ops);
    const ops = parsedOps.items;
    const revision = current.revision + 1;
    let working = current;
    const applied: PageChangeDto[] = [];
    const proposed: PageChangeDto[] = [];
    const rejected: Rejected[] = [...parsedOps.rejected];
    const batchId = newPageId('batch');
    const touchedExisting = new Set<string>();
    const beforeByRow = new Map<string, TargetSnapshot>();
    const acceptedRowOps = new Map<string, PageDatabaseEditOp>();
    // Where each row sat in the state right before and right after its own op, so Undo
    // (which replays the batch's ops newest first) finds it where that op left it.
    const stepLocations = new Map<string, { before: RowLocation | null; after: RowLocation | null }>();
    const stepAfter = (database: PageDatabase, rowId: string): RowLocation | null =>
      database.rows.some((row) => row.id === rowId) ? rowLocation(database, rowId) : null;
    const proposalByRow = new Map<string, { op: PageDatabaseEditOp; before: TargetSnapshot; values?: Record<string, PageDatabaseRow['values'][string]>; body?: string; remove?: true; baseRev: number }>();
    const newId = (prefix: 'col' | 'view' | 'row') => newPageId(prefix === 'row' ? 'row' : prefix === 'col' ? 'column' : 'view');
    let assignedRowIndex = 0;
    let applyRevision = revision;

    for (let offset = 0; offset < ops.length; offset += 1) {
      const { op, index } = ops[offset]!;
      if (op.op === 'row.add') {
        // Client supplied IDs are deliberately ignored for agent-created rows.
        const rowId = assignedRowIds?.[assignedRowIndex++] ?? newId('row');
        const safeOp = { ...op, id: rowId } as PageDatabaseEditOp;
        try {
          const result = applyPageDatabaseOps(working, [safeOp], { actor: 'agent', revision: applyRevision, now, newId });
          working = result.database;
          if (result.changed) applyRevision = working.revision + 1;
          const before = rowSnapshot(current, rowId), after = rowSnapshot(working, rowId);
          if (after.kind === 'row' && after.exists && !same(before, after)) {
            acceptedRowOps.set(rowId, safeOp);
            beforeByRow.set(rowId, before);
            stepLocations.set(rowId, { before: null, after: stepAfter(working, rowId) });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Invalid row operation';
          rejected.push(rejection(index, isMissingError(message) ? 'missing' : 'invalid', message));
        }
        continue;
      }
      if (op.op !== 'row.update' && op.op !== 'row.delete') {
        rejected.push(rejection(index, 'invalid', 'Only row update and delete operations are supported'));
        continue;
      }
      const rowId = op.id;
      if (touchedExisting.has(rowId)) {
        rejected.push(rejection(index, 'invalid', `Duplicate row target ${rowId} in one call`));
        continue;
      }
      const before = rowSnapshot(working, rowId);
      if (before.kind !== 'row' || !before.exists) {
        rejected.push(rejection(index, 'missing', `Row ${rowId} does not exist`));
        continue;
      }
      touchedExisting.add(rowId);
      if (op.expectRev !== before.row.rev) {
        rejected.push(rejection(index, 'stale', `Row ${rowId} revision changed`));
        continue;
      }
      beforeByRow.set(rowId, rowSnapshot(current, rowId));
      if (op.op === 'row.delete') {
        if (protectRowDelete(before.row)) {
          proposalByRow.set(rowId, { op, before, remove: true, baseRev: before.row.rev });
          continue;
        }
      }
      if (op.op === 'row.update') {
        const unprotectedValues: Record<string, PageDatabaseRow['values'][string]> = {};
        const protectedValues: Record<string, PageDatabaseRow['values'][string]> = {};
        for (const [columnId, value] of Object.entries(op.values ?? {})) {
          if (same(before.row.values[columnId], value)) continue;
          (before.row.edited[columnId] === undefined ? unprotectedValues : protectedValues)[columnId] = value;
        }
        const bodyChanges = op.body !== undefined && op.body !== before.row.body;
        const bodyProtected = bodyChanges && before.row.bodyEditedAt !== null;
        const unprotectedBody = bodyChanges && !bodyProtected ? op.body : undefined;
        const protectedBody = bodyProtected ? op.body : undefined;
        const hasApply = Object.keys(unprotectedValues).length > 0 || unprotectedBody !== undefined;
        const hasProposal = Object.keys(protectedValues).length > 0 || protectedBody !== undefined;
        if (hasApply) {
          const safeOp = { op: 'row.update', id: rowId, expectRev: before.row.rev,
            ...(Object.keys(unprotectedValues).length ? { values: unprotectedValues } : {}),
            ...(unprotectedBody === undefined ? {} : { body: unprotectedBody }) } as PageDatabaseEditOp;
          const result = applyPageDatabaseOps(working, [safeOp], { actor: 'agent', revision: applyRevision, now, newId });
          if (result.rejectedOps.length) {
            rejected.push(rejection(index, mapApplyRejection(result.rejectedOps[0]!.reason), 'Row update could not be applied'));
            continue;
          }
          working = result.database;
          if (result.changed) applyRevision = working.revision + 1;
          acceptedRowOps.set(rowId, safeOp);
          stepLocations.set(rowId, { before: before.location, after: stepAfter(working, rowId) });
        }
        if (hasProposal) proposalByRow.set(rowId, { op, before: rowSnapshot(working, rowId), values: protectedValues,
          ...(protectedBody === undefined ? {} : { body: protectedBody }),
          baseRev: working.rows.find((row) => row.id === rowId)?.rev ?? before.row.rev });
        continue;
      }
      try {
        const safeOp = { ...op } as PageDatabaseEditOp;
        const result = applyPageDatabaseOps(working, [safeOp], { actor: 'agent', revision: applyRevision, now, newId });
        if (result.rejectedOps.length) {
          rejected.push(rejection(index, mapApplyRejection(result.rejectedOps[0]!.reason), 'Row operation could not be applied'));
          continue;
        }
        working = result.database;
        if (result.changed) applyRevision = working.revision + 1;
        acceptedRowOps.set(rowId, safeOp);
        stepLocations.set(rowId, { before: before.location, after: stepAfter(working, rowId) });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid row operation';
        rejected.push(rejection(index, isMissingError(message) ? 'missing' : 'invalid', message));
      }
    }

    if (!same(current, working)) {
      working = { ...working, revision, updatedAt: now,
        rows: working.rows.map((row) => same(current.rows.find((item) => item.id === row.id), row)
          ? row : { ...row, rev: revision, updatedAt: now }) };
    }

    for (const [rowId, op] of acceptedRowOps) {
      const step = stepLocations.get(rowId);
      const before = atLocation(beforeByRow.get(rowId) ?? rowSnapshot(current, rowId), step?.before);
      const after = atLocation(rowSnapshot(working, rowId), step?.after);
      if (same(before, after)) continue;
      const target: ChangeTarget = { kind: 'row', databaseId: current.id, rowId,
        columnIds: op.op === 'row.update' ? Object.keys(op.values ?? {}).sort() : op.op === 'row.add' ? Object.keys(op.values).sort() : op.op === 'row.delete' && before.kind === 'row' && before.exists ? Object.keys(before.row.values).sort() : [],
        ...(op.op === 'row.update' && op.body !== undefined || op.op === 'row.add' && op.body !== undefined || op.op === 'row.delete' && before.kind === 'row' && before.exists && before.row.body !== undefined ? { body: true } : {}) };
      const location = after.kind === 'row' && after.exists ? after.location : before.kind === 'row' && before.exists ? before.location : rowLocation(current, rowId);
      const forward: TargetMutation = after.kind === 'row' && after.exists
        ? { kind: 'row', op: 'upsert', row: after.row, location: after.location }
        : { kind: 'row', op: 'delete', id: rowId, expectedLocation: location };
      const inverse: TargetMutation = before.kind === 'row' && before.exists
        ? { kind: 'row', op: 'upsert', row: before.row, location: before.location }
        : { kind: 'row', op: 'delete', id: rowId, expectedLocation: location };
        applied.push(recordChange({ ownerUserId: input.ownerUserId, workspaceId: input.workspaceId, batchId, target, op: 'row', before, after,
        forward, inverse, baseRev: before.kind === 'row' && before.exists ? before.row.rev : current.revision,
        appliedRev: after.kind === 'row' && after.exists ? after.row.rev : working.revision, source, now, proposal: false }));
      if (after.kind === 'row' && !after.exists) dismissPendingProposals(input.workspaceId, target, now);
    }
    for (const [rowId, proposal] of proposalByRow) {
      const latestRow = working.rows.find((row) => row.id === rowId);
      const originalBefore = proposal.before;
      const before = originalBefore.kind === 'row' && originalBefore.exists && latestRow
        ? { ...originalBefore, row: { ...originalBefore.row, rev: latestRow.rev, updatedAt: latestRow.updatedAt } }
        : originalBefore;
      if (before.kind !== 'row' || !before.exists) continue;
      const target: ChangeTarget = { kind: 'row', databaseId: current.id, rowId,
        columnIds: proposal.remove ? Object.keys(before.row.edited).sort() : Object.keys(proposal.values ?? {}).sort(),
        ...(proposal.remove ? before.row.bodyEditedAt !== null ? { body: true } : {} : proposal.body === undefined ? {} : { body: true }) };
      const proposedRow = proposal.remove ? undefined : {
        ...before.row, values: { ...before.row.values, ...(proposal.values ?? {}) },
        ...(proposal.body === undefined ? {} : { body: proposal.body }),
      };
      const after: TargetSnapshot = proposedRow
        ? { kind: 'row', exists: true, row: proposedRow, location: before.location }
        : { kind: 'row', exists: false, id: rowId, location: null };
      const forward: TargetMutation = proposal.remove
        ? { kind: 'row', op: 'delete', id: rowId, expectedLocation: before.location }
        : { kind: 'row', op: 'patch', id: rowId, values: proposal.values ?? {}, ...(proposal.body === undefined ? {} : { body: proposal.body }) };
      const inverse: TargetMutation = proposal.remove
        ? { kind: 'row', op: 'upsert', row: before.row, location: before.location }
        : { kind: 'row', op: 'patch', id: rowId,
          values: Object.fromEntries(Object.keys(proposal.values ?? {}).map((key) => [key, before.row.values[key] ?? null])),
          ...(proposal.body === undefined ? {} : { body: before.row.body ?? '' }) };
      proposed.push(recordChange({ ownerUserId: input.ownerUserId, workspaceId: input.workspaceId, batchId, target, op: 'row', before, after,
        forward, inverse, baseRev: latestRow?.rev ?? proposal.baseRev, appliedRev: null, source, now, proposal: true }));
    }

    if (working.revision !== current.revision) {
      saveDatabase(working, input.ownerUserId, { now, actor: 'agent' });
      invalidateDatabasePages(current.id, now, 'agent');
    } else if (proposed.length) {
      invalidateDatabasePages(current.id, now, 'agent');
    }
    return { resource: { kind: 'database', id: current.id }, revision: working.revision, applied, proposed, rejected };
  });
}

/** Component writes are row-only and keep the same per-cell protection rules as agent row edits. */
export function applyComponentDbEdits(input: ApplyComponentDbEditsInput): PageWriteResult {
  if (input.host.kind !== 'database_view' || input.host.databaseId !== input.databaseId) throw invalid('Component host does not match database');
  const source: ChangeSource = { kind: 'component', componentId: input.componentId, version: input.version,
    databaseId: input.databaseId, viewId: input.host.viewId };
  return applyAgentDbEditsWithSource({ ...input, source }, source, () => {
    const record = requireDatabaseRecord(input.databaseId, input.ownerUserId, { write: true });
    if (record.workspace_id !== input.workspaceId) throw new PageWriteError(404, 'not_found', 'Database not found');
    const current = getDatabase(input.databaseId, input.ownerUserId, { write: true });
    const view = current.views.find((item) => item.id === input.host.viewId);
    if (!view || view.type !== 'custom' || view.config.componentId !== input.componentId ||
      (view.config.pinnedVersion ?? input.version) !== input.version) throw new PageWriteError(409, 'stale_revision', 'Component host binding changed');
    input.authorize();
  });
}

/** Apply a frozen maintenance database row batch and commit its receipt atomically. */
export function applyMaintenanceDatabaseSet(input: ApplyMaintenanceDatabaseSetInput): PageWriteResult & { receipt: MaintenanceReceipt } {
  return pagesTransaction(() => {
    const now = safeNow(input.now);
    assertMaintenanceAuthority(input, now);
    const plan = getMaintenancePlan(input.planId, input.ownerUserId);
    if (!plan || plan.workspaceId !== input.workspaceId || plan.jobId !== input.jobId || plan.runId !== input.runId || plan.configRevision !== input.configRevision) {
      throw new PageWriteError(409, 'stale_revision', 'Maintenance plan changed');
    }
    if (input.resource.kind !== 'database' || input.resource.id !== input.databaseId) throw invalid('Maintenance database resource does not match target');
    const key = maintenanceOperationKey(input.jobId, input.sourceTurnId, 'database', input.databaseId, plan.generation);
    const prior = getMaintenanceReceipt(key);
    if (prior) {
      if (prior.payloadHash !== input.payloadHash || !sameCanonical(prior.payload, input.payload) || !sameCanonical(prior.assignedIds, input.assignedIds)) {
        throw new PageWriteError(409, 'stale_revision', 'Maintenance resource already has a different receipt');
      }
      return { ...(prior.result as PageWriteResult), receipt: prior };
    }
    assertMaintenanceResourceCurrent({ workspaceId: input.workspaceId, ownerUserId: input.ownerUserId,
      planId: input.planId, sourceTurnId: input.sourceTurnId, resource: input.resource });
    const expectedPayload = { ops: parseOps(input.ops, 'agent') };
    if (!sameCanonical(expectedPayload, input.payload)) throw invalid('Maintenance operations differ from frozen payload');
    if (expectedPayload.ops.some((op) => !op.op.startsWith('row.'))) throw invalid('Maintenance database edits must contain row operations only');
    const assigned = input.assignedIds as { rowIds?: unknown };
    if (!assigned || !Array.isArray(assigned.rowIds) || assigned.rowIds.some((id) => typeof id !== 'string' || !id)) throw invalid('Invalid frozen maintenance row IDs');
    const rowAdds = expectedPayload.ops.filter((op) => op.op === 'row.add').length;
    if (assigned.rowIds.length !== rowAdds || new Set(assigned.rowIds).size !== assigned.rowIds.length) throw invalid('Frozen maintenance row IDs do not match operations');
    const current = getDatabase(input.databaseId, input.ownerUserId, { write: true });
    if (current.workspaceId !== input.workspaceId || current.revision !== input.resource.revision) throw new PageWriteError(409, 'stale_revision', 'Database changed since maintenance routing');
    const source: ChangeSource = { kind: 'maintenance', ...input.execution, jobId: input.jobId,
      runId: input.runId, evidence: [input.evidence] };
    const result = applyAgentDbEditsWithSource({ databaseId: input.databaseId, workspaceId: input.workspaceId,
      ownerUserId: input.ownerUserId, source, ops: expectedPayload.ops, now }, source,
      () => assertMaintenanceAuthority(input, now), assigned.rowIds as string[]);
    if (result.rejected.length) throw invalid(`Maintenance row batch rejected: ${result.rejected[0]!.message}`);
    if (!result.applied.length && !result.proposed.length) throw invalid('Maintenance row batch made no verified change');
    const outcome = result.applied.length ? 'written' : 'proposed';
    const receipt = persistMaintenanceReceiptInTransaction({ ...input, resource: input.resource, outcome,
      payloadHash: input.payloadHash, payload: input.payload, assignedIds: input.assignedIds,
      result, now });
    return { ...result, receipt };
  });
}

export interface ConfigureDatabaseViewInput {
  databaseId: string; workspaceId: string; ownerUserId: string; revision: number; viewId?: string;
  componentId: string; props: unknown; pinnedVersion?: number; source: Extract<ChangeSource, { kind: 'chat' | 'helper' }>;
  now?: number;
}

/** Configure a custom view to render a validated, versioned library component. */
export function configureDatabaseView(input: ConfigureDatabaseViewInput): PageWriteResult & { viewId: string } {
  return pagesTransaction(() => {
    const now = safeNow(input.now);
    requireChatChangeSource(input.workspaceId, input.ownerUserId, input.source);
    const record = requireDatabaseRecord(input.databaseId, input.ownerUserId, { write: true });
    if (record.workspace_id !== input.workspaceId) throw new PageWriteError(404, 'not_found', 'Database not found');
    const current = getDatabase(input.databaseId, input.ownerUserId, { write: true });
    assertExpectedDatabaseRevision(current, input.revision);
    const viewId = input.viewId ?? newPageId('view');
    const viewIndex = current.views.findIndex((view) => view.id === viewId);
    const componentVersion = pageComponents.read(input.workspaceId, input.ownerUserId, input.componentId, input.pinnedVersion).version;
    const props = pageComponents.validateProps(input.workspaceId, input.ownerUserId, input.componentId, componentVersion, input.props);
    if (props === null) throw invalid('Invalid custom view component props');
    const old = viewIndex < 0 ? undefined : current.views[viewIndex]!;
    if (!old && current.views.length >= MICHI_DB_LIMITS.views) throw invalid('Database has reached the custom view limit');
    const existingReference = getDb().prepare(`SELECT protected FROM page_component_refs WHERE owner_user_id=? AND workspace_id=?
      AND host_kind='database_view' AND database_id=? AND view_id=?`).get(input.ownerUserId,input.workspaceId,input.databaseId,viewId) as {protected:number}|undefined;
    const componentName = pageComponents.list(input.workspaceId, input.ownerUserId).items.find((item) => item.id === input.componentId)?.name;
    if (!componentName) throw new PageWriteError(404, 'not_found', 'Component not found');
    const { pinnedVersion: _previousPin, ...configWithoutPin } = old?.config ?? { filters: [], match: 'all' as const, sorts: [] };
    const view: PageDatabaseView = { ...(old ?? { id: viewId, name: componentName, position: current.views.length }),
      type: 'custom', config: { ...configWithoutPin, componentId: input.componentId,
        ...(input.pinnedVersion === undefined ? {} : { pinnedVersion: componentVersion }), props } };
    const nextViews = viewIndex < 0 ? [...current.views, view] : current.views.map((item, index) => index === viewIndex ? view : item);
    if (same(current.views, nextViews)) return { resource: { kind: 'database', id: current.id }, revision: current.revision, applied: [], proposed: [], rejected: [], viewId };
    const working: PageDatabase = { ...current, views: nextViews,
      revision: current.revision + 1, updatedAt: now };
    const target: ChangeTarget = { kind: 'database', databaseId: current.id };
    const before = dbSnapshot(current), after = dbSnapshot(working), batchId = newPageId('batch');
    if (old?.edit !== undefined || existingReference?.protected === 1) {
      const proposed = recordChange({ ownerUserId: input.ownerUserId, workspaceId: input.workspaceId, batchId, target,
        op: 'view', before, after,
        forward: { kind: 'database', op: 'replace', database: { id: working.id, workspaceId: working.workspaceId,
          title: working.title, columns: working.columns, views: working.views } },
        inverse: { kind: 'database', op: 'replace', database: { id: current.id, workspaceId: current.workspaceId,
          title: current.title, columns: current.columns, views: current.views } },
        baseRev: current.revision, appliedRev: null, source: input.source, now, proposal: true });
      invalidateDatabasePages(current.id, now, 'agent');
      return { resource: { kind: 'database', id: current.id }, revision: current.revision, applied: [], proposed: [proposed], rejected: [], viewId };
    }
    const applied = [recordChange({ ownerUserId: input.ownerUserId, workspaceId: input.workspaceId, batchId, target,
      op: 'view', before, after,
      forward: { kind: 'database', op: 'replace', database: { id: working.id, workspaceId: working.workspaceId, title: working.title, columns: working.columns, views: working.views } },
      inverse: { kind: 'database', op: 'replace', database: { id: current.id, workspaceId: current.workspaceId, title: current.title, columns: current.columns, views: current.views } },
      baseRev: current.revision, appliedRev: working.revision, source: input.source, now, proposal: false })];
    saveDatabase(working, input.ownerUserId, { now, actor: 'agent' });
    invalidateDatabasePages(current.id, now, 'agent');
    return { resource: { kind: 'database', id: current.id }, revision: working.revision, applied, proposed: [], rejected: [], viewId };
  });
}
