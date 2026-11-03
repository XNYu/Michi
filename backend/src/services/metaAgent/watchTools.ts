import type { PageWriteResult } from 'michi-shared';
import { PageWriteError, pagesTransaction } from '../pages/core';
import { applyWatchDatabaseSet } from '../pages/databaseWrites';
import { livePageEditLease, PageEditBusyError, type PageEditLease } from '../pages/editLeases';
import { assertMaintenanceAuthority, listEligibleMaintenanceManifest } from '../pages/maintenanceRepository';
import { maintenancePagePath, type MaintenanceExecutionContext } from '../pages/maintenanceWriter';
import { getDatabase, getMaintenanceDatabasePage, getMaintenancePageBlocks, getPage, liveTaskDatabaseId } from '../pages/repository';
import { writeHomePage } from './firstRunWriter';
import { withoutSources } from './firstRunSources';
import {
  getWatchDecision, getWatchRun, listWatchDecisions, observeWatchResource, recordWatchDecision, watchPayloadHash, watchRunSource,
  WATCH_RUN_ID_PREFIX, type WatchRunRecord,
} from './watches';

/**
 * The maintenance tools as a watch check uses them. A check has no source
 * turn and no routing: it reads any eligible page or database of its
 * workspace, and each one gets at most one final decision per check, against
 * the revision the check read. Every call re-checks run authority.
 */

type Kind = 'page' | 'database';
const READ_MAX_BYTES = 64 * 1024;
const invalid = (message: string) => new PageWriteError(400, 'invalid', message);
const stale = (message: string) => new PageWriteError(409, 'stale_revision', message);

/** The watch check a maintenance send is bound to, or null for any other run. */
export function watchRunFor(context: MaintenanceExecutionContext): WatchRunRecord | null {
  if (!context.planId.startsWith(WATCH_RUN_ID_PREFIX)) return null;
  const run = getWatchRun(context.planId, context.ownerUserId);
  if (!run || run.workspaceId !== context.workspaceId || run.jobId !== context.jobId || run.runId !== context.runId) {
    throw stale('This maintenance run is no longer bound to a watch check');
  }
  return run;
}

function activeRun(context: MaintenanceExecutionContext, args: Record<string, unknown>, now: number): WatchRunRecord {
  const run = watchRunFor(context);
  if (!run) throw invalid('This tool is only bound to a watch check');
  if (args.sourceTurnId !== run.id) throw invalid(`Use sourceTurnId "${run.id}" for this watch check`);
  assertMaintenanceAuthority({ workspaceId: context.workspaceId, ownerUserId: context.ownerUserId, jobId: context.jobId,
    runId: context.runId, claimedBy: context.claimedBy, configRevision: context.configRevision }, now);
  if (run.state !== 'active') throw stale(`This watch check already finished (${run.state}); make no further write or no-change call`);
  return run;
}

function authorize(context: MaintenanceExecutionContext, now: number): () => void {
  return () => assertMaintenanceAuthority({ workspaceId: context.workspaceId, ownerUserId: context.ownerUserId, jobId: context.jobId,
    runId: context.runId, claimedBy: context.claimedBy, configRevision: context.configRevision }, now);
}

function resourceId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw invalid(`${name} is required`);
  return value;
}

/** Excluded page trees, other workspaces and the saved Home page stay out of reach, as for conversation maintenance. */
function requireEligible(context: MaintenanceExecutionContext, kind: Kind, id: string): void {
  const manifest = listEligibleMaintenanceManifest(context.workspaceId, context.ownerUserId);
  const found = kind === 'page' ? manifest.pages.some((page) => page.id === id) : manifest.databases.some((database) => database.id === id);
  if (!found) throw new PageWriteError(404, 'not_found', `This ${kind} is not one this watch may change; use maintenance_list_resources`);
}

function busy(lease: PageEditLease): PageEditBusyError {
  return new PageEditBusyError(lease, 'PAGE_BUSY: a conversation is editing this page right now. Do not write it in this check: '
    + 'Michi records it as waiting, and the next check reads it again. Continue with the other resources.');
}

/** Leaves the page waiting while a conversation edits it, then refuses the call. */
function deferIfLeased(run: WatchRunRecord, pageId: string, now: number): void {
  const lease = livePageEditLease(pageId, now);
  if (!lease) return;
  recordWatchDecision({ runId: run.id, kind: 'page', resourceId: pageId, outcome: 'deferred', payloadHash: null, result: null, now });
  throw busy(lease);
}

/** The resource's decision as a write must find it: read in this check and not yet decided, or the exact same set replayed. */
function writable(run: WatchRunRecord, kind: Kind, id: string, payloadHash: string): { replay: unknown } | { observedRevision: number } {
  const decision = getWatchDecision(run.id, kind, id);
  if (decision?.outcome && decision.outcome !== 'deferred') {
    if (decision.payloadHash === payloadHash) return { replay: decision.result };
    throw stale(`This ${kind} already has its final decision in this check; make no further write or no-change call for it`);
  }
  if (decision?.observedRevision == null) throw invalid(`Read this ${kind} from its first range in this check before writing it`);
  return { observedRevision: decision.observedRevision };
}

export function readWatchSource(context: MaintenanceExecutionContext, args: Record<string, unknown>, now: number) {
  return watchRunSource(activeRun(context, args, now));
}

/** Every page and database the check may change, with any decision it already made. */
export function listWatchResources(context: MaintenanceExecutionContext, args: Record<string, unknown>, now: number) {
  const run = activeRun(context, args, now);
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 100;
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) {
    throw invalid('Resource listing requires an offset and a limit from 1 to 100');
  }
  const manifest = listEligibleMaintenanceManifest(context.workspaceId, context.ownerUserId);
  const pageById = new Map(manifest.pages.map((page) => [page.id, page]));
  const decisions = new Map(listWatchDecisions(run.id).map((decision) => [`${decision.kind}:${decision.resourceId}`, decision.outcome]));
  const decided = (kind: Kind, id: string) => { const outcome = decisions.get(`${kind}:${id}`); return outcome ? { decision: outcome } : {}; };
  const all = [
    ...manifest.pages.map((page) => ({ kind: 'page' as const, id: page.id, title: page.title.slice(0, 160),
      pagePath: maintenancePagePath(page.id, pageById), ...decided('page', page.id) })),
    ...manifest.databases.map((database) => {
      const pagePath = database.pageIds.filter((id) => pageById.has(id)).map((id) => maintenancePagePath(id, pageById)).sort()[0];
      return { kind: 'database' as const, id: database.id, title: database.title.slice(0, 160),
        ...(pagePath ? { pagePath } : {}), ...(database.role ? { role: database.role } : {}), ...decided('database', database.id) };
    }),
  ].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  let resources = all.slice(offset as number, (offset as number) + (limit as number));
  const result = () => ({ sourceTurnId: run.id, totalResources: all.length, offset, resources,
    nextOffset: (offset as number) + resources.length < all.length ? (offset as number) + resources.length : null });
  while (resources.length && Buffer.byteLength(JSON.stringify(result()), 'utf8') > READ_MAX_BYTES) resources = resources.slice(0, -1);
  return result();
}

export function readWatchPage(context: MaintenanceExecutionContext, args: Record<string, unknown>, now: number) {
  const run = activeRun(context, args, now);
  const pageId = resourceId(args.pageId, 'pageId');
  requireEligible(context, 'page', pageId);
  deferIfLeased(run, pageId, now);
  const read = getMaintenancePageBlocks(pageId, context.ownerUserId, {
    ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
    ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
  });
  if (!args.offset) observeWatchResource(run.id, 'page', pageId, read.page.revision, now);
  else if (getWatchDecision(run.id, 'page', pageId)?.observedRevision !== read.page.revision) {
    throw stale('Page changed since this check read it; read it again from its first range');
  }
  return read;
}

export function readWatchDatabase(context: MaintenanceExecutionContext, args: Record<string, unknown>, now: number) {
  const run = activeRun(context, args, now);
  const databaseId = resourceId(args.databaseId, 'databaseId');
  requireEligible(context, 'database', databaseId);
  const read = getMaintenanceDatabasePage(databaseId, context.ownerUserId, {
    ...(typeof args.cursor === 'string' ? { cursor: args.cursor } : {}),
    ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
    ...(Array.isArray(args.columnIds) ? { columnIds: args.columnIds as string[] } : {}),
    ...(typeof args.includeBodies === 'boolean' ? { includeBodies: args.includeBodies } : {}),
  });
  if (args.cursor === undefined) observeWatchResource(run.id, 'database', databaseId, read.database.revision, now);
  else if (getWatchDecision(run.id, 'database', databaseId)?.observedRevision !== read.database.revision) {
    throw stale('Database changed since this check read it; read it again from its first page');
  }
  return read;
}

/** Listing tasks reads the task database: the revision it saw is the one a write must find. */
export function observeWatchTaskDatabase(context: MaintenanceExecutionContext, args: Record<string, unknown>, now: number): { databaseId: string; revision: number } {
  const run = activeRun(context, args, now);
  const databaseId = liveTaskDatabaseId(context.workspaceId, context.ownerUserId);
  if (!databaseId) throw new PageWriteError(404, 'not_found', 'This workspace has no task database');
  requireEligible(context, 'database', databaseId);
  const { revision } = getDatabase(databaseId, context.ownerUserId);
  observeWatchResource(run.id, 'database', databaseId, revision, now);
  return { databaseId, revision };
}

export function writeWatchPage(context: MaintenanceExecutionContext, args: Record<string, unknown>, now: number): PageWriteResult {
  const run = activeRun(context, args, now);
  const pageId = resourceId(args.pageId, 'pageId');
  requireEligible(context, 'page', pageId);
  // A check cites no conversation: sources on its operations are dropped.
  const ops = withoutSources(args.ops, true).ops;
  const payloadHash = watchPayloadHash({ kind: 'page', pageId, ops });
  const state = writable(run, 'page', pageId, payloadHash);
  if ('replay' in state) return state.replay as PageWriteResult;
  deferIfLeased(run, pageId, now);
  try {
    return pagesTransaction(() => {
      authorize(context, now)();
      deferIfLeased(run, pageId, now);
      const page = getPage(pageId, context.ownerUserId, { write: true });
      if (page.workspaceId !== context.workspaceId) throw new PageWriteError(404, 'not_found', 'Page not found');
      if (page.revision !== state.observedRevision) throw stale('Page changed since this check read it; read it again from its first range');
      const result = writeHomePage({ ownerUserId: context.ownerUserId, pageId, ops, execution: context.execution,
        jobId: context.jobId, evidence: [], read: null, now });
      if (!recordWatchDecision({ runId: run.id, kind: 'page', resourceId: pageId, outcome: result.applied.length ? 'written' : 'proposed',
        payloadHash, result, now })) throw stale('This page already has its final decision in this check');
      return result;
    });
  } catch (error) {
    // A conversation took the lease inside the transaction, which rolled the deferral back with it.
    if (error instanceof PageEditBusyError) recordWatchDecision({ runId: run.id, kind: 'page', resourceId: pageId, outcome: 'deferred', payloadHash: null, result: null, now });
    throw error;
  }
}

export function writeWatchDatabase(context: MaintenanceExecutionContext, args: Record<string, unknown>, now: number): PageWriteResult {
  const run = activeRun(context, args, now);
  const databaseId = resourceId(args.databaseId, 'databaseId');
  requireEligible(context, 'database', databaseId);
  if (Array.isArray(args.ops) && args.ops.some((op) => !!op && typeof op === 'object' && (op as Record<string, unknown>).op === 'row.add' && Object.hasOwn(op, 'id'))) {
    throw invalid('row.add IDs are assigned by the writer');
  }
  const payloadHash = watchPayloadHash({ kind: 'database', databaseId, ops: args.ops });
  const state = writable(run, 'database', databaseId, payloadHash);
  if ('replay' in state) return state.replay as PageWriteResult;
  return pagesTransaction(() => {
    const result = applyWatchDatabaseSet({ databaseId, workspaceId: context.workspaceId, ownerUserId: context.ownerUserId,
      jobId: context.jobId, expectedRevision: state.observedRevision, ops: args.ops, execution: context.execution,
      authorize: authorize(context, now), now });
    if (!recordWatchDecision({ runId: run.id, kind: 'database', resourceId: databaseId, outcome: result.applied.length ? 'written' : 'proposed',
      payloadHash, result, now })) throw stale('This database already has its final decision in this check');
    return result;
  });
}

export function recordWatchNoChange(context: MaintenanceExecutionContext, args: Record<string, unknown>, now: number) {
  const run = activeRun(context, args, now);
  const kind = args.resourceKind;
  if (kind !== 'page' && kind !== 'database') throw invalid('resourceKind must be page or database');
  const id = resourceId(args.resourceId, 'resourceId');
  requireEligible(context, kind, id);
  const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
  if (!reason || reason.length > 2000) throw invalid('A 1-2000 character reason is required');
  const result = { decision: 'no_change', reason, resource: { kind, id } };
  const payloadHash = watchPayloadHash(result);
  const decision = getWatchDecision(run.id, kind, id);
  if (decision?.outcome && decision.outcome !== 'deferred') {
    if (decision.payloadHash === payloadHash) return result;
    throw stale(`This ${kind} already has its final decision in this check`);
  }
  return pagesTransaction(() => {
    authorize(context, now)();
    if (!recordWatchDecision({ runId: run.id, kind, resourceId: id, outcome: 'no_change', payloadHash, result, now })) {
      throw stale(`This ${kind} already has its final decision in this check`);
    }
    return result;
  });
}
