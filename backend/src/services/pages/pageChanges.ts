import { parsePageBlockInput, parsePageDatabaseOps, retainUserPageSegmentSources } from 'michi-shared';
import type { PageBlock, PageBlockInput, PageDatabase, PageDatabaseRow, PageDatabaseView } from 'michi-shared';
import type {
  BlockLocation, ChangeTarget, PageChangeDto, RowLocation, TargetMutation, TargetSnapshot,
} from 'michi-shared';
import { invalidateDatabasePages, invalidatePages, PageWriteError, pagesTransaction } from './core';
import { getDatabase, getPage, requireDatabaseRecord, saveDatabase, savePageContent } from './repository';
import { dismissPendingProposals, getChange, getTargetHead, listChangeBatch, setTargetHead, updateChange } from './historyRepository';
import { pageComponents } from './components';
import { pinHumanDatabaseViews, pinHumanPageComponentBlocks } from './componentReferences';
import { canonical } from './canonicalJson';

export { dismissPendingProposals };

type SafeTarget = ChangeTarget;
type EditableProposal =
  | { kind: 'block'; block: PageBlockInput }
  | { kind: 'row'; values?: Record<string, PageDatabaseRow['values'][string]>; body?: string }
  | { kind: 'view'; config: Record<string, unknown> };

const json = (value: unknown): string => JSON.stringify(value);
const conflict = (message = 'The change can no longer be applied safely'): PageWriteError =>
  new PageWriteError(409, 'undo_conflict', message);
const same = (a: unknown, b: unknown): boolean => json(canonical(a)) === json(canonical(b));

function safeNow(value?: number): number {
  const now = value ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new PageWriteError(400, 'invalid', 'Invalid timestamp');
  return now;
}

function readCurrent(target: SafeTarget, owner: string): { snapshot: TargetSnapshot; workspaceId: string } {
  if (target.kind === 'block') {
    const page = getPage(target.pageId, owner, { write: true });
    const index = page.blocks.findIndex((block) => block.id === target.blockId);
    if (index < 0) return { snapshot: { kind: 'block', exists: false, id: target.blockId, location: null }, workspaceId: page.workspaceId };
    return { snapshot: { kind: 'block', exists: true, block: page.blocks[index]!, location: blockLocation(page.blocks, index) }, workspaceId: page.workspaceId };
  }
  const record = requireDatabaseRecord(target.databaseId, owner, { write: true });
  const database = getDatabase(target.databaseId, owner, { write: true });
  if (target.kind === 'row') {
    const row = database.rows.find((item) => item.id === target.rowId);
    return { snapshot: row
      ? { kind: 'row', exists: true, row: structuredClone(row), location: rowLocation(database, target.rowId) }
      : { kind: 'row', exists: false, id: target.rowId, location: null }, workspaceId: record.workspace_id };
  }
  return { snapshot: databaseSnapshot(database), workspaceId: record.workspace_id };
}

function blockLocation(blocks: readonly PageBlock[], index: number): BlockLocation {
  return { parentId: null, slot: null, previousId: index > 0 ? blocks[index - 1]!.id : null,
    nextId: index + 1 < blocks.length ? blocks[index + 1]!.id : null };
}
function rowLocation(database: PageDatabase, rowId: string): RowLocation {
  const position = database.rows.findIndex((row) => row.id === rowId);
  if (position < 0) return { position: database.rows.length, after: database.rows.at(-1)?.id ?? null };
  return { position, after: database.rows[position - 1]?.id ?? null };
}
function databaseSnapshot(database: PageDatabase): TargetSnapshot {
  return { kind: 'database', exists: true, database: { id: database.id, workspaceId: database.workspaceId,
    title: database.title, columns: structuredClone(database.columns), views: structuredClone(database.views),
    revision: database.revision, updatedAt: database.updatedAt } };
}

function assertExpected(current: TargetSnapshot, expected: TargetSnapshot | null): void {
  if (!expected || current.kind !== expected.kind || current.exists !== expected.exists) throw conflict();
  if (!current.exists || !expected.exists) {
    if (current.kind !== expected.kind || current.exists !== expected.exists ||
      (!current.exists && !expected.exists && current.id !== expected.id)) throw conflict();
    return;
  }
  if (current.kind === 'block' && expected.kind === 'block') {
    if (!same(current.location, expected.location) || !same({ ...current.block, rev: undefined }, { ...expected.block, rev: undefined })) throw conflict();
  } else if (current.kind === 'row' && expected.kind === 'row') {
    // Order is compared through `location`; stored positions are not renumbered after a delete.
    const strip = (row: PageDatabaseRow) => ({ ...row, rev: undefined, updatedAt: undefined, position: undefined });
    if (!same(current.location, expected.location) || !same(strip(current.row), strip(expected.row))) throw conflict();
  } else if (current.kind === 'database' && expected.kind === 'database') {
    const strip = (database: TargetSnapshot & { kind: 'database'; exists: true }) => {
      const { revision: _revision, updatedAt: _updatedAt, ...content } = database.database;
      return content;
    };
    if (!same(strip(current), strip(expected))) throw conflict();
  } else throw conflict();
}

function insertionPosition(blocks: readonly PageBlock[], location: BlockLocation): number {
  if (location.parentId !== null || location.slot !== null) throw conflict('The block location is invalid');
  const previous = location.previousId === null ? -1 : blocks.findIndex((block) => block.id === location.previousId);
  const next = location.nextId === null ? -1 : blocks.findIndex((block) => block.id === location.nextId);
  if ((location.previousId !== null && previous < 0) || (location.nextId !== null && next < 0)) throw conflict('A block restoration anchor is missing');
  if (location.previousId === null && location.nextId === null) {
    if (blocks.length) throw conflict('The block restoration location is no longer empty');
    return 0;
  }
  if (location.previousId === null) {
    if (next !== 0) throw conflict('The block restoration anchors changed');
    return 0;
  }
  if (location.nextId === null) {
    if (previous !== blocks.length - 1) throw conflict('The block restoration anchors changed');
    return blocks.length;
  }
  if (next !== previous + 1) throw conflict('The block restoration anchors changed');
  return next;
}

function ensureBlockLocation(blocks: readonly PageBlock[], id: string, expected: BlockLocation): void {
  const index = blocks.findIndex((block) => block.id === id);
  if (index < 0 || !same(blockLocation(blocks, index), expected)) throw conflict('The block location changed');
}

function writePageMutation(target: Extract<SafeTarget, {kind:'block'}>, owner: string, mutation: TargetMutation,
  expected: TargetSnapshot | null, now: number): void {
  const page = getPage(target.pageId, owner, { write: true });
  const current = readCurrent(target, owner).snapshot;
  assertExpected(current, expected);
  const blocks = [...page.blocks];
  const index = blocks.findIndex((block) => block.id === target.blockId);
  if (mutation.kind !== 'block') throw conflict('The recorded mutation has the wrong target kind');
  if (mutation.op === 'delete') {
    if (mutation.id !== target.blockId || index < 0) throw conflict();
    ensureBlockLocation(blocks, target.blockId, mutation.expectedLocation);
    blocks.splice(index, 1);
  } else {
    if (mutation.block.id !== target.blockId) throw conflict();
    const without = blocks.filter((block) => block.id !== target.blockId);
    const at = insertionPosition(without, mutation.location);
    const changed: PageBlock = { ...mutation.block, rev: page.revision + 1 };
    if (index >= 0) blocks.splice(index, 1);
    blocks.splice(at, 0, changed);
  }
  savePageContent(page.id, owner, { ...page, blocks, revision: page.revision + 1 }, {
    source: { kind: 'user' }, now, expectedRevision: page.revision,
  });
  invalidatePages([page.id], now, 'user');
}

function insertRow(database: PageDatabase, row: PageDatabaseRow, location: RowLocation, revision: number, now: number): PageDatabase {
  const rows = database.rows.filter((item) => item.id !== row.id);
  let position: number;
  if (location.after === null) position = 0;
  else {
    const anchor = rows.findIndex((item) => item.id === location.after);
    if (anchor < 0) throw conflict('A row restoration anchor is missing');
    position = anchor + 1;
  }
  // The row must still occupy the recorded gap; do not silently choose a new location.
  if (location.after === null && location.position > 0) throw conflict('The row restoration anchor changed');
  if (location.after !== null && position !== location.position) throw conflict('The row restoration anchor changed');
  rows.splice(position, 0, { ...structuredClone(row), position, rev: revision, updatedAt: now });
  return { ...database, rows: rows.map((item, index) => ({ ...item, position: index })), revision, updatedAt: now };
}

function saveDatabaseMutation(target: Extract<SafeTarget, {kind:'row'|'database'}>, owner: string, mutation: TargetMutation,
  expected: TargetSnapshot | null, now: number, restore = false): void {
  const dbRecord = requireDatabaseRecord(target.databaseId, owner, { write: true });
  const database = getDatabase(target.databaseId, owner, { write: true });
  const current = readCurrent(target, owner).snapshot;
  assertExpected(current, expected);
  if (mutation.kind === 'database' && target.kind === 'database') {
    if (mutation.op !== 'replace' || mutation.database.id !== database.id || mutation.database.workspaceId !== database.workspaceId) throw conflict('Unsupported database mutation');
    saveDatabase({ ...database, title: mutation.database.title, columns: structuredClone(mutation.database.columns),
      views: structuredClone(mutation.database.views), revision: database.revision + 1, updatedAt: now }, owner, { now, restore });
  } else if (mutation.kind === 'row' && target.kind === 'row') {
    if (target.databaseId !== dbRecord.id) throw conflict();
    const revision = database.revision + 1;
    const index = database.rows.findIndex((row) => row.id === target.rowId);
    let next: PageDatabase;
    if (mutation.op === 'delete') {
      if (mutation.id !== target.rowId || index < 0 || !same(rowLocation(database, target.rowId), mutation.expectedLocation)) throw conflict('The row location changed');
      const rows = database.rows.filter((row) => row.id !== target.rowId).map((row, i) => ({ ...row, position: i, rev: row.rev }));
      next = { ...database, rows, revision, updatedAt: now };
    } else if (mutation.op === 'upsert') {
      if (mutation.row.id !== target.rowId) throw conflict();
      next = insertRow(database, mutation.row, mutation.location, revision, now);
    } else {
      if (mutation.id !== target.rowId || index < 0) throw conflict();
      const prior = database.rows[index]!;
      const values = { ...prior.values, ...structuredClone(mutation.values) };
      const edited = { ...prior.edited, ...mutation.edited };
      const body = mutation.body === undefined ? prior.body : mutation.body;
      const bodyEditedAt = mutation.bodyEditedAt === undefined ? prior.bodyEditedAt : mutation.bodyEditedAt;
      const rows = [...database.rows];
      rows[index] = { ...prior, values, body, edited, bodyEditedAt, rev: revision, updatedAt: now };
      next = { ...database, rows, revision, updatedAt: now };
    }
    saveDatabase(next, owner, { now, restore });
  } else throw conflict('The recorded mutation has the wrong target kind');
  invalidateDatabasePages(target.databaseId, now, 'user');
}

function applyMutation(change: PageChangeDto, owner: string, mutation: TargetMutation, expected: TargetSnapshot | null, now: number): void {
  if (change.target.kind === 'block') {
    writePageMutation(change.target, owner, mutation, expected, now);
  } else {
    saveDatabaseMutation(change.target, owner, mutation, expected, now, true);
  }
}

function transitionGuard(change: PageChangeDto, owner: string, action: 'undo' | 'redo'): { workspaceId: string; head: {headId:string|null;targetRevision:number} } {
  const info = readCurrent(change.target, owner);
  const head = getTargetHead(info.workspaceId, change.target) ?? { headId: null, targetRevision: 1 };
  if (action === 'undo' && head.headId !== change.id) throw conflict('A newer change owns this target');
  if (action === 'redo' && head.headId !== change.previousHeadId) throw conflict('The preceding target head has changed');
  return { workspaceId: info.workspaceId, head };
}

function resourceRevision(target: ChangeTarget, owner: string): number {
  const current = readCurrent(target, owner).snapshot;
  if (current.kind === 'block' && current.exists) return current.block.rev;
  if (current.kind === 'row' && current.exists) return current.row.rev;
  if (current.kind === 'database' && current.exists) return current.database.revision;
  if (target.kind === 'block') return getPage(target.pageId, owner).revision;
  return getDatabase(target.databaseId, owner).revision;
}

/**
 * Puts back one applied change. A person's own change is put back only by
 * Undo of the batch it made (`allowUser`); reverting one change from the
 * history stays for agent changes.
 */
export function revertChange(changeId: string, ownerUserId: string, now?: number, options: { allowUser?: boolean } = {}): PageChangeDto {
  return pagesTransaction(() => {
    const timestamp = safeNow(now);
    const change = getChange(changeId, ownerUserId, { write: true });
    if (change.applicationState === 'reverted') return change;
    if (change.applicationState !== 'applied' || (change.proposalState !== null && change.proposalState !== 'accepted') || (change.source.kind === 'user' && !options.allowUser)) throw conflict('Only applied agent changes can be reverted');
    const { workspaceId, head } = transitionGuard(change, ownerUserId, 'undo');
    applyMutation(change, ownerUserId, change.inverse, change.after, timestamp);
    setTargetHead(workspaceId, change.target, { headId: change.previousHeadId, targetRevision: Math.max(head.targetRevision + 1, resourceRevision(change.target, ownerUserId)) });
    return updateChange(change.id, ownerUserId, { applicationState: 'reverted' });
  });
}

/** Puts back a reverted change; a person's own change only through the batch redo (`allowUser`). */
export function redoChange(changeId: string, ownerUserId: string, now?: number, options: { allowUser?: boolean } = {}): PageChangeDto {
  return pagesTransaction(() => {
    const timestamp = safeNow(now);
    const change = getChange(changeId, ownerUserId, { write: true });
    if (change.applicationState === 'applied') return change;
    if (change.applicationState !== 'reverted' || (change.proposalState !== null && change.proposalState !== 'accepted') || (change.source.kind === 'user' && !options.allowUser)) throw conflict('Only reverted agent changes can be redone');
    const { workspaceId, head } = transitionGuard(change, ownerUserId, 'redo');
    applyMutation(change, ownerUserId, change.forward, change.before, timestamp);
    setTargetHead(workspaceId, change.target, { headId: change.id, targetRevision: Math.max(head.targetRevision + 1, resourceRevision(change.target, ownerUserId)) });
    return updateChange(change.id, ownerUserId, { applicationState: 'applied' });
  });
}

/**
 * The order in which a batch's changes are put back: newest first, except that a deleted
 * row or block that is another deleted item's restoration anchor goes first.
 */
function revertOrder(records: PageChangeDto[]): PageChangeDto[] {
  // Reverse change order is normally right, but a deleted row or block may be
  // the recorded restoration anchor for another deleted item in the same batch.
  // Restore those anchors first, while retaining newest-first order otherwise.
  const byTarget = new Map(records.map((record) => [changeTargetKey(record.target), record]));
  const dependencies = new Map(records.map((record) => [record.id, new Set<string>()]));
  for (const record of records) {
    const inverse = record.inverse;
    if ((inverse.kind !== 'block' && inverse.kind !== 'row') || inverse.op !== 'upsert') continue;
    const anchors = inverse.kind === 'block'
      ? [inverse.location.previousId, inverse.location.nextId]
      : [inverse.location.after];
    for (const anchor of anchors) {
      if (anchor === null) continue;
      const anchorKey = record.target.kind === 'block'
        ? `block:${record.target.pageId}:${anchor}`
        : record.target.kind === 'row' ? `row:${record.target.databaseId}:${anchor}` : null;
      const anchorChange = anchorKey ? byTarget.get(anchorKey) : undefined;
      if (!anchorChange || anchorChange.id === record.id) continue;
      const anchorInverse = anchorChange.inverse;
      if ((anchorInverse.kind === 'block' || anchorInverse.kind === 'row') && anchorInverse.op === 'upsert') {
        dependencies.get(record.id)!.add(anchorChange.id);
      }
    }
  }
  const ordered: PageChangeDto[] = [];
  const remaining = new Map(records.map((record) => [record.id, record]));
  while (remaining.size) {
    const ready = [...remaining.values()]
      .filter((record) => [...dependencies.get(record.id)!].every((dependency) => !remaining.has(dependency)))
      .sort((a, b) => b.seq - a.seq);
    // A cycle cannot be safely restored by ordering these independent writes;
    // leave normal conflict checks to report it instead of looping forever.
    if (!ready.length) {
      ordered.push(...[...remaining.values()].sort((a, b) => b.seq - a.seq));
      break;
    }
    for (const record of ready) {
      ordered.push(record);
      remaining.delete(record.id);
    }
  }
  return ordered;
}

export function revertBatch(batchId: string, ownerUserId: string, workspaceId: string, now?: number): { reverted: string[]; conflicts: Array<{changeId:string;message:string}> } {
  const records = listChangeBatch(batchId, ownerUserId, workspaceId).filter((record) => record.applicationState === 'applied');
  const ordered = revertOrder(records);
  const reverted: string[] = [];
  const conflicts: Array<{changeId:string;message:string}> = [];
  for (const record of ordered) {
    try { revertChange(record.id, ownerUserId, now, { allowUser: true }); reverted.push(record.id); }
    catch (error) {
      if (error instanceof PageWriteError && (error.status === 409 || error.code === 'task_board_needs_workspace')) conflicts.push({ changeId: record.id, message: error.message });
      else throw error;
    }
  }
  return { reverted, conflicts };
}

/** Redoes what `revertBatch` undid, in the reverse of its order, reporting changes that no longer apply. */
export function redoBatch(batchId: string, ownerUserId: string, workspaceId: string, now?: number): { redone: string[]; conflicts: Array<{changeId:string;message:string}> } {
  // The reverse of the order Undo used, so anchors are redone after what they anchor.
  const records = revertOrder(listChangeBatch(batchId, ownerUserId, workspaceId).filter((record) => record.applicationState === 'reverted')).reverse();
  const redone: string[] = [];
  const conflicts: Array<{changeId:string;message:string}> = [];
  for (const record of records) {
    try { redoChange(record.id, ownerUserId, now, { allowUser: true }); redone.push(record.id); }
    catch (error) {
      if (error instanceof PageWriteError && (error.status === 409 || error.code === 'task_board_needs_workspace')) conflicts.push({ changeId: record.id, message: error.message });
      else throw error;
    }
  }
  return { redone, conflicts };
}

function changeTargetKey(target: ChangeTarget): string {
  return target.kind === 'block' ? `block:${target.pageId}:${target.blockId}`
    : target.kind === 'row' ? `row:${target.databaseId}:${target.rowId}`
      : `database:${target.databaseId}`;
}

function parseEditedContent(value: unknown): EditableProposal | undefined {
  if (value === undefined) return undefined;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    if (raw.kind === 'block' && Object.keys(raw).every((key) => ['kind','block','content'].includes(key)) && !(raw.block !== undefined && raw.content !== undefined)) {
      const block = parsePageBlockInput(raw.block ?? raw.content);
      if (block) return { kind: 'block', block };
      throw new PageWriteError(400, 'invalid', 'Invalid edited block content');
    }
    if (raw.kind === 'row' && Object.keys(raw).every((key) => ['kind','values','body'].includes(key)) &&
      (raw.values !== undefined || raw.body !== undefined)) {
      const parsed = parsePageDatabaseOps([{ op: 'row.update', id: 'proposal-row',
        ...(raw.values === undefined ? {} : { values: raw.values }), ...(raw.body === undefined ? {} : { body: raw.body }) }], 'user');
      if (parsed.ok) return { kind: 'row', ...(raw.values === undefined ? {} : { values: raw.values as Record<string, PageDatabaseRow['values'][string]> }), ...(raw.body === undefined ? {} : { body: raw.body as string }) };
    }
    if (raw.kind === 'view' && Object.keys(raw).every((key) => ['kind','config'].includes(key)) &&
      raw.config !== null && typeof raw.config === 'object' && !Array.isArray(raw.config)) {
      return { kind: 'view', config: raw.config as Record<string, unknown> };
    }
    const block = parsePageBlockInput(value);
    if (block) return { kind: 'block', block };
  }
  throw new PageWriteError(400, 'invalid', 'Invalid edited proposal content');
}

function resolveProposal(changeId: string, owner: string, now?: number, editedInput?: unknown, action: 'accept'|'dismiss'|'reopen' = 'accept'): PageChangeDto {
  return pagesTransaction(() => {
    const timestamp = safeNow(now);
    const change = getChange(changeId, owner, { write: true });
    if (action === 'dismiss') {
      if (change.proposalState === 'dismissed') return change;
      if (change.proposalState !== 'pending') throw conflict('Only pending proposals can be dismissed');
      const next = updateChange(change.id, owner, { proposalState: 'dismissed', resolvedAt: timestamp });
      invalidateTarget(change.target, owner, timestamp);
      return next;
    }
    if (action === 'reopen') {
      if (change.proposalState === 'pending') return change;
      if (change.proposalState !== 'dismissed') throw conflict('Only dismissed proposals can be reopened');
      const next = updateChange(change.id, owner, { proposalState: 'pending', resolvedAt: timestamp });
      invalidateTarget(change.target, owner, timestamp);
      return next;
    }
    if (change.proposalState === 'accepted' && change.applicationState === 'applied') return change;
    if (change.proposalState !== 'pending' || change.applicationState !== null) throw conflict('Only pending proposals can be accepted');
    const edited = parseEditedContent(editedInput);
    const current = readCurrent(change.target, owner);
    const head = getTargetHead(current.workspaceId, change.target) ?? { headId: null, targetRevision: currentRevision(current.snapshot) };
    if (currentRevision(current.snapshot) !== change.baseRev) throw new PageWriteError(409, 'proposal_stale', 'The proposed target has changed');
    const accepted = acceptedMutations(change, current.snapshot, edited, timestamp, owner);
    const appliedRev = applyAccepted(change, owner, accepted.forward, current.snapshot, timestamp);
    const afterCurrent = readCurrent(change.target, owner).snapshot;
    const forward = mutationForAccepted(change.target, accepted.forward, afterCurrent);
    if ((forward.kind === 'block' && forward.op === 'delete') || (forward.kind === 'row' && forward.op === 'delete')) {
      dismissPendingProposals(current.workspaceId, change.target, timestamp, change.id);
    }
    setTargetHead(current.workspaceId, change.target, { headId: change.id, targetRevision: Math.max(head.targetRevision + 1, resourceRevision(change.target, owner)) });
    return updateChange(change.id, owner, {
      before: accepted.before, after: afterCurrent, forward, inverse: accepted.inverse,
      appliedRev, previousHeadId: head.headId,
      proposalState: 'accepted', applicationState: 'applied', resolvedAt: timestamp,
    });
  });
}

export function acceptProposal(changeId: string, ownerUserId: string, now?: number, editedContent?: unknown): PageChangeDto {
  return resolveProposal(changeId, ownerUserId, now, editedContent, 'accept');
}
export function dismissProposal(changeId: string, ownerUserId: string, now?: number): PageChangeDto {
  return resolveProposal(changeId, ownerUserId, now, undefined, 'dismiss');
}
export function reopenProposal(changeId: string, ownerUserId: string, now?: number): PageChangeDto {
  return resolveProposal(changeId, ownerUserId, now, undefined, 'reopen');
}

function currentRevision(snapshot: TargetSnapshot): number {
  if (snapshot.kind === 'block' && snapshot.exists) return snapshot.block.rev;
  if (snapshot.kind === 'row' && snapshot.exists) return snapshot.row.rev;
  if (snapshot.kind === 'database' && snapshot.exists) return snapshot.database.revision;
  return 1;
}

function mutationForAccepted(target: ChangeTarget, mutation: TargetMutation, snapshot: TargetSnapshot): TargetMutation {
  if (snapshot.kind === 'block' && snapshot.exists && mutation.kind === 'block' && mutation.op === 'upsert') {
    return { ...mutation, block: snapshot.block, location: snapshot.location };
  }
  if (snapshot.kind === 'row' && snapshot.exists && mutation.kind === 'row' && mutation.op !== 'delete') {
    return { kind: 'row', op: 'upsert', row: snapshot.row, location: snapshot.location };
  }
  if (target.kind === 'database' && snapshot.kind === 'database' && snapshot.exists && mutation.kind === 'database' && mutation.op === 'replace') {
    return { kind: 'database', op: 'replace', database: { id: snapshot.database.id, workspaceId: snapshot.database.workspaceId,
      title: snapshot.database.title, columns: structuredClone(snapshot.database.columns), views: structuredClone(snapshot.database.views) } };
  }
  return mutation;
}

function invalidateTarget(target: ChangeTarget, owner: string, now: number): void {
  if (target.kind === 'block') invalidatePages([target.pageId], now, 'user');
  else invalidateDatabasePages(target.databaseId, now, 'user');
}

function acceptedMutations(change: PageChangeDto, before: TargetSnapshot, edited: EditableProposal | undefined, now: number, owner: string): {
  before: TargetSnapshot; after: TargetSnapshot; forward: TargetMutation; inverse: TargetMutation;
} {
  if (change.target.kind === 'block') {
    const target = change.target;
    if (change.forward.kind !== 'block') throw conflict();
    const current = before;
    if (current.kind !== 'block') throw conflict();
    const original = current.exists ? current.block : null;
    if (edited && edited.kind !== 'block') throw new PageWriteError(400, 'invalid', 'Edited content does not match this proposal');
    if (change.forward.op === 'delete') {
      if (!original || edited) throw conflict('This block proposal cannot be edited');
      if (!current.exists || !same(current.location, change.forward.expectedLocation)) throw new PageWriteError(409, 'proposal_stale', 'The proposed block location has changed');
      return { before, after: { kind: 'block', exists: false, id: target.blockId, location: null },
        forward: change.forward, inverse: { kind: 'block', op: 'upsert', block: original, location: current.location } };
    }
    if (change.forward.block.id !== target.blockId) throw conflict();
    try {
      const page = getPage(target.pageId, owner, { write: true });
      const withoutTarget = page.blocks.filter((block) => block.id !== target.blockId);
      insertionPosition(withoutTarget, change.forward.location);
    } catch {
      throw new PageWriteError(409, 'proposal_stale', 'The proposed block location has changed');
    }
    if (original && current.exists && !same(current.location, change.forward.location)) {
      throw new PageWriteError(409, 'proposal_stale', 'The proposed block location has changed');
    }
    const content = edited?.kind === 'block' ? retainUserPageSegmentSources(edited.block, change.forward.block) : stripBlock(change.forward.block);
    if (original && content.type !== original.type) throw new PageWriteError(400, 'invalid', 'Edited block must retain its type');
    let block: PageBlock = { ...content, id: target.blockId,
      rev: original?.rev ?? change.forward.block.rev, ...(change.forward.block.sources ? { sources: change.forward.block.sources } : {}), edit: { at: now } } as PageBlock;
    block = pinHumanPageComponentBlocks([block], getPage(target.pageId, owner).workspaceId, owner)[0]!;
    const afterLocation = original ? change.forward.location : change.forward.location;
    const after: TargetSnapshot = { kind: 'block', exists: true, block, location: afterLocation };
    const forward: TargetMutation = { kind: 'block', op: 'upsert', block, location: afterLocation };
    const inverse: TargetMutation = original && current.exists
      ? { kind: 'block', op: 'upsert', block: original, location: current.location }
      : { kind: 'block', op: 'delete', id: target.blockId, expectedLocation: afterLocation };
    return { before, after, forward, inverse };
  }
  if (change.target.kind === 'database') {
    if (change.op !== 'view' || change.forward.kind !== 'database' || change.forward.op !== 'replace' ||
      change.inverse.kind !== 'database' || change.inverse.op !== 'replace' || before.kind !== 'database' || !before.exists ||
      !change.after || change.after.kind !== 'database' || !change.after.exists) throw conflict('Unsupported database proposal');
    assertExpected(before, change.before);
    const originalDatabase = before.database;
    const proposedDatabase = change.forward.database;
    const storedAfter = change.after.database;
    if (proposedDatabase.id !== originalDatabase.id || proposedDatabase.workspaceId !== originalDatabase.workspaceId ||
      !same(proposedDatabase.title, originalDatabase.title) || !same(proposedDatabase.columns, originalDatabase.columns) ||
      storedAfter.id !== proposedDatabase.id || storedAfter.workspaceId !== proposedDatabase.workspaceId ||
      !same(storedAfter.title, proposedDatabase.title) || !same(storedAfter.columns, proposedDatabase.columns) ||
      !same(proposedDatabase.views, storedAfter.views) || !same(change.inverse.database.views, originalDatabase.views)) {
      throw conflict('The view proposal changed unrelated database content');
    }
    const beforeViews = new Map(originalDatabase.views.map((view) => [view.id, view]));
    const proposedViews = new Map(proposedDatabase.views.map((view) => [view.id, view]));
    if (beforeViews.size !== originalDatabase.views.length || proposedViews.size !== proposedDatabase.views.length || beforeViews.size !== proposedViews.size) {
      throw conflict('The view proposal changed the view set');
    }
    const changedViews = originalDatabase.views.filter((view) => !same(view, proposedViews.get(view.id)));
    if (changedViews.length !== 1) throw conflict('The view proposal must change exactly one view');
    const originalView = changedViews[0]!;
    const proposedView = proposedViews.get(originalView.id);
    const stripComponentConfig = (view: PageDatabaseView) => ({ ...view, type: 'custom', config: {
      ...view.config, componentId: undefined, pinnedVersion: undefined, props: undefined, height: undefined,
    } });
    if (!proposedView || originalView.edit === undefined || proposedView.type !== 'custom' || !proposedView.config.componentId ||
      !same(stripComponentConfig(originalView), stripComponentConfig(proposedView))) {
      throw conflict('The protected view proposal changed fields outside its component configuration');
    }
    if (edited && edited.kind !== 'view') throw new PageWriteError(400, 'invalid', 'Edited content does not match this proposal');
    const configPatch = edited?.kind === 'view' ? edited.config : {};
    const proposedConfigKeys = ['componentId', 'pinnedVersion', 'props', 'height']
      .filter((key) => !same(originalView.config[key as keyof PageDatabaseView['config']], proposedView.config[key as keyof PageDatabaseView['config']]));
    if (Object.keys(configPatch).some((key) => !['componentId', 'pinnedVersion', 'props', 'height'].includes(key)) ||
      Object.keys(configPatch).some((key) => !proposedConfigKeys.includes(key))) {
      throw new PageWriteError(400, 'invalid', 'Edited fields must be a subset of the proposed view configuration');
    }
    const candidate = { ...proposedView, config: { ...proposedView.config, ...configPatch } };
    const parsed = parsePageDatabaseOps([{ op: 'view.save', view: {
      id: candidate.id, name: candidate.name, type: candidate.type, config: candidate.config,
    } }], 'user');
    if (!parsed.ok) throw new PageWriteError(400, 'invalid', 'Invalid edited view configuration');
    const config = candidate.config;
    const componentId = config.componentId;
    const propsInput = config.props;
    if (!componentId || propsInput === undefined) throw new PageWriteError(400, 'invalid', 'Invalid custom view component configuration');
    const version = pageComponents.read(
      before.database.workspaceId, owner, componentId, config.pinnedVersion,
    ).version;
    const props = pageComponents.validateProps(before.database.workspaceId, owner, componentId, version, propsInput);
    if (props === null) throw new PageWriteError(400, 'invalid', 'Invalid custom view component props');
    const acceptedView: PageDatabaseView = { ...candidate, config: { ...config, pinnedVersion: version, props }, edit: { at: now } };
    const liveDatabase = getDatabase(change.target.databaseId, owner, { write: true });
    const preNormalized = { ...liveDatabase, views: liveDatabase.views.map((view) => view.id === acceptedView.id ? acceptedView : view) };
    const afterDatabase = pinHumanDatabaseViews(preNormalized, owner);
    const normalizedView = afterDatabase.views.find((view) => view.id === acceptedView.id);
    if (!normalizedView || normalizedView.type !== 'custom') throw conflict('The accepted view could not be normalized');
    return {
      before,
      after: { kind: 'database', exists: true, database: { ...afterDatabase, revision: before.database.revision + 1, updatedAt: now } },
      forward: { kind: 'database', op: 'replace', database: afterDatabase },
      inverse: { kind: 'database', op: 'replace', database: { id: originalDatabase.id, workspaceId: originalDatabase.workspaceId,
        title: originalDatabase.title, columns: originalDatabase.columns, views: originalDatabase.views } },
    };
  }
  if (change.target.kind !== 'row' || change.forward.kind !== 'row') throw conflict();
  if (before.kind !== 'row' || !before.exists || change.forward.op === 'delete') {
    if (change.forward.kind === 'row' && change.forward.op === 'delete' && before.kind === 'row' && before.exists && !edited) {
      return { before, after: { kind: 'row', exists: false, id: change.target.rowId, location: null }, forward: change.forward,
        inverse: { kind: 'row', op: 'upsert', row: before.row, location: before.location } };
    }
    throw conflict('This row proposal cannot be edited');
  }
  if (edited && edited.kind !== 'row') throw new PageWriteError(400, 'invalid', 'Edited content does not match this proposal');
  if (change.forward.op === 'patch') {
    const proposedValues = change.forward.values;
    const proposedKeys = Object.keys(proposedValues);
    const editedValues = edited?.kind === 'row' ? edited.values ?? {} : proposedValues;
    if (Object.keys(editedValues).some((key) => !proposedKeys.includes(key))) throw new PageWriteError(400, 'invalid', 'Edited cells must be a subset of the proposal');
    const proposesBody = change.forward.body !== undefined;
    if (edited?.kind === 'row' && edited.body !== undefined && !proposesBody) throw new PageWriteError(400, 'invalid', 'Edited body is outside the proposal');
    const values = { ...before.row.values, ...editedValues };
    const editedCells = { ...before.row.edited, ...Object.fromEntries(Object.keys(editedValues).map((key) => [key, now])) };
    const body = edited?.kind === 'row' && edited.body !== undefined ? edited.body : change.forward.body;
    const bodyEditedAt = body === undefined ? before.row.bodyEditedAt : now;
    const row: PageDatabaseRow = { ...before.row, values, ...(body === undefined ? {} : { body }), edited: editedCells, bodyEditedAt, updatedAt: now };
    const after: TargetSnapshot = { kind: 'row', exists: true, row, location: before.location };
    return { before, after, forward: { kind: 'row', op: 'upsert', row, location: before.location },
      inverse: { kind: 'row', op: 'upsert', row: before.row, location: before.location } };
  }
  if (change.forward.op === 'upsert') {
    const proposed = change.forward.row;
    const editedValues = edited?.kind === 'row' ? edited.values ?? {} : {};
    if (Object.keys(editedValues).some((key) => !(key in proposed.values)) || (edited?.kind === 'row' && edited.body !== undefined && proposed.body === undefined)) {
      throw new PageWriteError(400, 'invalid', 'Edited fields must be a subset of the proposal');
    }
    const row: PageDatabaseRow = { ...proposed, values: { ...proposed.values, ...editedValues }, ...(edited?.kind === 'row' && edited.body !== undefined ? { body: edited.body } : {}),
      edited: { ...proposed.edited, ...Object.fromEntries(Object.keys(editedValues).map((key) => [key, now])) },
      bodyEditedAt: edited?.kind === 'row' && edited.body !== undefined ? now : proposed.bodyEditedAt, updatedAt: now };
    const after: TargetSnapshot = { kind: 'row', exists: true, row, location: change.forward.location };
    return { before, after, forward: { kind: 'row', op: 'upsert', row, location: change.forward.location }, inverse: { kind: 'row', op: 'upsert', row: before.row, location: before.location } };
  }
  throw conflict('Unsupported row proposal');
}

function stripBlock(block: PageBlock): PageBlockInput {
  const { id: _id, rev: _rev, edit: _edit, sources: _sources, ...content } = block;
  return content as PageBlockInput;
}

function applyAccepted(change: PageChangeDto, owner: string, forward: TargetMutation, before: TargetSnapshot, now: number): number {
  if (change.target.kind === 'block') {
    writePageMutation(change.target, owner, forward, before, now);
    return getPage(change.target.pageId, owner).revision;
  }
  saveDatabaseMutation(change.target, owner, forward, before, now);
  return getDatabase(change.target.databaseId, owner).revision;
}
