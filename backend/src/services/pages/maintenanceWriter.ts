import { createHash } from 'node:crypto';
import { agentPageOpProblem, parseAgentPageOps, type AgentPageEditOp, parsePageDatabaseOps, type PageDatabaseEditOp } from 'michi-shared';
import type { BlockSource, MaintenancePlan, MaintenanceResourceKind, MaintenanceResourceRef, MaintenanceReceipt, PageWriteResult } from 'michi-shared';
import {
  assertMaintenanceAuthority, assertMaintenanceResourceCurrent, freezeMaintenanceResourcePayload, getMaintenancePlan, getMaintenanceReceipt,
  assertMaintenanceSourceCoverageComplete, listEligibleMaintenanceManifest, maintenanceOperationKey, recordMaintenanceRouting, type AuthorityInput,
  refreshMaintenanceSourceManifest, reobserveRoutedMaintenanceResource, listMaintenanceResourceStates, type MaintenanceResourceState,
} from './maintenanceRepository';
import { applyMaintenancePageSet } from './pageWrites';
import { applyMaintenanceDatabaseSet } from './databaseWrites';
import { PageWriteError } from './core';
import { deferMaintenancePageForEditLease } from './maintenanceRepository';
import { livePageEditLease, maintenanceBusyError, PageEditBusyError } from './editLeases';
import { runInTransaction } from '../db';
import { getPage } from './repository';
import { canonical } from './canonicalJson';
import { validateMaintenanceSegmentSourceReferences } from './segmentSources';

/** Trusted scheduler identity bound to the live maintenance chat session. */
export interface MaintenanceExecutionContext extends AuthorityInput {
  planId: string;
  sources: Array<{ sourceTurnId: string; evidence: BlockSource }>;
  execution: BlockSource & { runId: string };
}

const MAX_OPS = 50;
const MAX_CANDIDATES = 2000;
/** `role: 'tasks'` names the workspace's task database to the maintenance agent. */
type MaintenanceSourceResourceEntry = { kind: MaintenanceResourceKind; id: string; revision: number; title: string; pagePath?: string; role?: 'tasks'; decision?: MaintenanceResourceState; available?: false };
const now = () => Date.now();
const invalid = (message: string) => new PageWriteError(400, 'invalid', message);

function contextPlan(context: MaintenanceExecutionContext, allowTerminal = false): MaintenancePlan {
  assertMaintenanceAuthority({ workspaceId: context.workspaceId, ownerUserId: context.ownerUserId, jobId: context.jobId,
    runId: context.runId, claimedBy: context.claimedBy, configRevision: context.configRevision }, now());
  const plan = getMaintenancePlan(context.planId, context.ownerUserId);
  if (!plan || plan.workspaceId !== context.workspaceId || plan.jobId !== context.jobId ||
      plan.runId !== context.runId || plan.configRevision !== context.configRevision ||
      !(allowTerminal ? ['routing', 'processing', 'terminal'].includes(plan.state) : ['routing', 'processing'].includes(plan.state))) {
    throw new PageWriteError(409, 'stale_revision', 'Maintenance plan is no longer active');
  }
  return plan;
}

export function requireMaintenanceSource(context: MaintenanceExecutionContext, sourceTurnId: unknown, allowTerminal = false) {
  if (typeof sourceTurnId !== 'string') throw invalid('sourceTurnId is required');
  const trusted = context.sources.find((source) => source.sourceTurnId === sourceTurnId);
  const planSource = contextPlan(context, allowTerminal).sources.find((source) => source.sourceTurnId === sourceTurnId);
  if (!trusted || !planSource || JSON.stringify(trusted.evidence) !== JSON.stringify(planSource.evidence)) {
    throw new PageWriteError(404, 'not_found', 'Source turn is not in the active maintenance batch');
  }
  return { ...planSource, evidence: trusted.evidence };
}

export function requireMaintenanceResource(
  context: MaintenanceExecutionContext,
  sourceTurnId: string,
  kind: MaintenanceResourceKind,
  resourceId: string,
): MaintenanceResourceRef {
  const resource = getPlannedMaintenanceResource(context, sourceTurnId, kind, resourceId);
  assertMaintenanceResourceCurrent({ workspaceId: context.workspaceId, ownerUserId: context.ownerUserId,
    planId: context.planId, sourceTurnId, resource });
  return resource;
}

/** Returns the immutable routed target; first writes separately recheck currentness in their commit transaction. */
export function getPlannedMaintenanceResource(
  context: MaintenanceExecutionContext,
  sourceTurnId: string,
  kind: MaintenanceResourceKind,
  resourceId: string,
  allowTerminal = false,
): MaintenanceResourceRef {
  const source = requireMaintenanceSource(context, sourceTurnId, allowTerminal);
  const resource = source.candidates.find((candidate) => candidate.kind === kind && candidate.id === resourceId);
  if (!source.routingComplete || !resource) throw new PageWriteError(404, 'not_found', 'Resource is not routed for this source turn');
  return resource;
}

function stableIds(operationKey: string, payload: unknown, count: number, prefix: 'block' | 'row'): string[] {
  const digest = createHash('sha256').update(`${operationKey}:${JSON.stringify(canonical(payload))}`).digest('hex').slice(0, 28);
  return Array.from({ length: count }, (_, index) => `${prefix}-${digest}-${index.toString(36)}`);
}

function sameCanonical(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function replayResult(operationKey: string, context: MaintenanceExecutionContext, sourceTurnId: string,
  payload: unknown, assignedIds: unknown): PageWriteResult | null {
  const plan = contextPlan(context, true);
  return runInTransaction(() => {
    assertMaintenanceAuthority({ workspaceId: context.workspaceId, ownerUserId: context.ownerUserId, jobId: context.jobId,
      runId: context.runId, claimedBy: context.claimedBy, configRevision: context.configRevision }, now());
    const receipt = getMaintenanceReceipt(operationKey);
    if (!receipt) return null;
    const selected = context.sources.find((source) => source.sourceTurnId === sourceTurnId);
    if (!selected || receipt.planId !== plan.id || receipt.jobId !== context.jobId || receipt.sourceTurnId !== sourceTurnId ||
        receipt.generation !== plan.generation || receipt.payloadHash !== createHash('sha256').update(JSON.stringify({ payload, assignedIds })).digest('hex') || !sameCanonical(receipt.payload, payload) ||
        !sameCanonical(receipt.assignedIds, assignedIds) || !sameCanonical(receipt.evidence, selected.evidence)) {
      throw new PageWriteError(409, 'stale_revision', 'Maintenance receipt does not match this operation set');
    }
    const result = receipt.result as PageWriteResult;
    if (!result || !Array.isArray(result.applied) || !Array.isArray(result.proposed) || !Array.isArray(result.rejected)) {
      throw new PageWriteError(409, 'stale_revision', 'Stored maintenance receipt result is invalid');
    }
    return result;
  });
}

function normalizedPageOps(raw: unknown): AgentPageEditOp[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_OPS) throw invalid('Page operation set must contain 1-50 operations');
  const parsed = parseAgentPageOps(raw);
  if (!parsed) {
    const index = raw.findIndex((op) => agentPageOpProblem(op) !== '');
    throw invalid(index < 0 ? 'Invalid maintenance page operations' : `Invalid maintenance page operation ${index}: ${agentPageOpProblem(raw[index])}`);
  }
  return parsed;
}

function normalizedDatabaseOps(raw: unknown): PageDatabaseEditOp[] {
  if (Array.isArray(raw) && raw.some((op) => !!op && typeof op === 'object' && !Array.isArray(op) &&
      (op as Record<string, unknown>).op === 'row.add' && Object.hasOwn(op, 'id'))) {
    throw invalid('row.add IDs are assigned by the maintenance writer');
  }
  const parsed = parsePageDatabaseOps(raw, 'agent');
  if (!parsed.ok || parsed.ops.length < 1) throw invalid(parsed.ok ? 'Database operation set must not be empty' : parsed.error);
  return parsed.ops;
}

/** Resolve candidate IDs against the server-frozen manifest before persisting source routing. */
export function routeMaintenanceSource(context: MaintenanceExecutionContext, sourceTurnId: string, rawCandidates: unknown, reason?: string): MaintenancePlan {
  const currentSource = requireMaintenanceSource(context, sourceTurnId);
  if (currentSource.routingComplete) return contextPlan(context);
  const refreshed = refreshMaintenanceSource(context, sourceTurnId);
  const source = refreshed.sources.find((item) => item.sourceTurnId === sourceTurnId)!;
  if (!Array.isArray(rawCandidates) || rawCandidates.length > MAX_CANDIDATES) throw invalid('Invalid maintenance candidate set');
  const seen = new Set<string>();
  const manifest: MaintenanceResourceRef[] = [];
  for (const raw of rawCandidates) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('Invalid maintenance candidate');
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).some((key) => !['kind', 'id'].includes(key)) ||
        !['page', 'database'].includes(String(item.kind)) || typeof item.id !== 'string' || !item.id.trim()) throw invalid('Candidate accepts only kind and id');
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const allowed = source.manifest.find((entry) => entry.kind === item.kind && entry.id === item.id);
    if (!allowed) throw new PageWriteError(409, 'invalid', 'Candidate is outside the frozen eligible manifest');
    manifest.push(allowed);
  }
  return recordMaintenanceRouting({ ...context, planId: context.planId, sourceTurnId, manifest, reason, now: now() });
}

/** Scheduler-only preparation for the next source; requires all prior sources to be terminal. */
export function refreshMaintenanceSource(context: MaintenanceExecutionContext, sourceTurnId: string): MaintenancePlan {
  requireMaintenanceSource(context, sourceTurnId);
  return refreshMaintenanceSourceManifest({ workspaceId: context.workspaceId, ownerUserId: context.ownerUserId,
    jobId: context.jobId, runId: context.runId, claimedBy: context.claimedBy, configRevision: context.configRevision,
    planId: context.planId, sourceTurnId, now: now() });
}

/** Lists a bounded page of still-eligible frozen candidates with trusted display metadata only. */
export function listMaintenanceSourceResources(
  context: MaintenanceExecutionContext,
  sourceTurnId: string,
  offset = 0,
  limit = 100,
): { sourceTurnId: string; totalResources: number; offset: number; resources: MaintenanceSourceResourceEntry[]; nextOffset: number | null; routed?: true; note?: string } {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_CANDIDATES ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalid('Resource listing requires an offset and a limit from 1 to 100');
  // A routed manifest is immutable, so a recovered run lists the routed resources and their decisions and
  // continues from them. Only reading a resource refreshes its revision; only an unrouted source is refreshed here.
  const routed = requireMaintenanceSource(context, sourceTurnId).routingComplete;
  const source = (routed ? contextPlan(context) : refreshMaintenanceSource(context, sourceTurnId))
    .sources.find((item) => item.sourceTurnId === sourceTurnId);
  if (!source) throw new PageWriteError(404, 'not_found', 'Source turn is not in the active maintenance batch');
  const states = routed ? listMaintenanceResourceStates(context.planId, context.ownerUserId, sourceTurnId) : null;

  const manifest = listEligibleMaintenanceManifest(context.workspaceId, context.ownerUserId);
  const pageById = new Map(manifest.pages.map((page) => [page.id, page]));
  const databaseById = new Map(manifest.databases.map((database) => [database.id, database]));
  const currentByKey = new Map(manifest.resources.map((resource) => [`${resource.kind}:${resource.id}`, resource]));
  const available: MaintenanceSourceResourceEntry[] = [];
  const decisionOf = (entry: MaintenanceResourceRef) => states ? { decision: states.get(`${entry.kind}:${entry.id}`) ?? 'pending' } : {};
  for (const planned of routed ? source.candidates : source.manifest) {
    const current = currentByKey.get(`${planned.kind}:${planned.id}`);
    const page = planned.kind === 'page' ? pageById.get(planned.id) : undefined;
    const database = planned.kind === 'database' ? databaseById.get(planned.id) : undefined;
    // The workspace task database stays available when its board route changed: reading it adopts the new route.
    const onRoute = !!current && (sameCanonical([...current.pageIds].sort(), [...planned.pageIds].sort()) || database?.role === 'tasks');
    if (!onRoute || (planned.kind === 'page' ? !page : !database)) {
      // A routed resource that left its route stays listed: reading it once from its first page makes the system record it as skipped.
      if (routed) available.push({ kind: planned.kind, id: planned.id, revision: planned.revision, title: '(no longer available)', available: false, ...decisionOf(planned) });
      continue;
    }
    if (planned.kind === 'page' && page) {
      available.push({ kind: 'page', id: planned.id, revision: routed ? planned.revision : current!.revision,
        title: page.title.slice(0, 160), pagePath: maintenancePagePath(page.id, pageById), ...decisionOf(planned) });
      continue;
    }
    if (!database) continue;
    const firstPagePath = planned.pageIds.map((id) => pageById.get(id)).filter((page) => !!page)
      .map((page) => maintenancePagePath(page!.id, pageById)).sort((a, b) => a.localeCompare(b))[0];
    available.push({ kind: 'database', id: planned.id, revision: routed ? planned.revision : current!.revision,
      title: database.title.slice(0, 160), ...(firstPagePath ? { pagePath: firstPagePath } : {}), ...(database.role ? { role: database.role } : {}), ...decisionOf(planned) });
  }
  available.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));

  let pageResources = available.slice(offset, offset + limit);
  const makeResult = () => ({ sourceTurnId, totalResources: available.length, offset, resources: pageResources,
    nextOffset: offset + pageResources.length < available.length ? offset + pageResources.length : null,
    ...(routed ? { routed: true as const, note: ROUTED_NOTE } : {}) });
  while (pageResources.length && Buffer.byteLength(JSON.stringify(makeResult()), 'utf8') > 64 * 1024) pageResources = pageResources.slice(0, -1);
  if (!pageResources.length && offset < available.length) throw new PageWriteError(400, 'invalid', 'One maintenance resource entry exceeds the 64 KB response limit');
  return makeResult();
}

const ROUTED_NOTE = 'This source is already routed and routing is final: no resource can be added. These are its routed resources with their decisions. Read each resource whose decision is "pending" again from its first page: that read refreshes its revision. Then write it or record no change; leave the decided ones alone. An entry with available:false left its routed pages (deleted, excluded or moved) and cannot be written: read it once from its first page and the system records it as skipped. Do this for every such entry, or the source stays unfinished.';

function authorityOf(context: MaintenanceExecutionContext): AuthorityInput {
  return { workspaceId: context.workspaceId, ownerUserId: context.ownerUserId, jobId: context.jobId,
    runId: context.runId, claimedBy: context.claimedBy, configRevision: context.configRevision };
}

/** Read-side refresh of one routed resource, before its first range is read; a resource the system had to skip fails the read. */
export function reobserveRoutedResource(context: MaintenanceExecutionContext, sourceTurnId: string, kind: MaintenanceResourceKind, resourceId: string): void {
  if (!requireMaintenanceSource(context, sourceTurnId).routingComplete) return;
  const result = reobserveRoutedMaintenanceResource({ ...authorityOf(context), planId: context.planId, sourceTurnId, kind, resourceId, now: now() });
  if (result.outcome === 'skipped') throw new PageWriteError(409, 'stale_revision', `${result.reason}. It needs no more work in this run; continue with the source's other resources.`);
}

/**
 * Leaves a routed page pending while a conversation holds its edit lease:
 * records the deferral for this run, then refuses the read, write or no-change.
 */
export function deferIfPageLeased(context: MaintenanceExecutionContext, sourceTurnId: string, pageId: string, at = now()): void {
  const lease = livePageEditLease(pageId, at);
  if (!lease) return;
  deferMaintenancePageForEditLease({ planId: context.planId, sourceTurnId, pageId, runId: context.runId, now: at });
  throw maintenanceBusyError(lease);
}

function maintenancePagePath(pageId: string, pages: Map<string, { id: string; parentId: string | null; title: string }>): string {
  const parts: string[] = [];
  let current = pages.get(pageId);
  const seen = new Set<string>();
  while (current && !seen.has(current.id) && parts.length < 12) {
    seen.add(current.id);
    parts.unshift(current.title.slice(0, 100));
    current = current.parentId ? pages.get(current.parentId) : undefined;
  }
  let path = parts.join(' / ');
  if (path.length > 240) path = `…${path.slice(-239)}`;
  return path;
}

export function createMaintenanceWriter() {
  function authority(context: MaintenanceExecutionContext): AuthorityInput {
    return { workspaceId: context.workspaceId, ownerUserId: context.ownerUserId, jobId: context.jobId,
      runId: context.runId, claimedBy: context.claimedBy, configRevision: context.configRevision };
  }
  function page(context: MaintenanceExecutionContext, sourceTurnId: string, pageId: string, rawOps: unknown): PageWriteResult {
    const plan = contextPlan(context, true);
    const resource = getPlannedMaintenanceResource(context, sourceTurnId, 'page', pageId, true);
    const ops = normalizedPageOps(rawOps);
    const payload = canonical({ ops });
    const operationKey = maintenanceOperationKey(context.jobId, sourceTurnId, 'page', pageId, plan.generation);
    const assignedIds = { blockIds: stableIds(operationKey, payload, ops.filter((op) => op.op === 'insert').length, 'block') };
    const saved = replayResult(operationKey, context, sourceTurnId, payload, assignedIds);
    if (saved) return requireSuccessfulResourceResult(saved);
    if (!['routing', 'processing'].includes(plan.state)) throw new PageWriteError(409, 'stale_revision', 'Maintenance plan is terminal');
    deferIfPageLeased(context, sourceTurnId, pageId);
    assertMaintenanceSourceCoverageComplete(context.planId, context.ownerUserId, sourceTurnId);
    assertMaintenanceResourceCurrent({ workspaceId: context.workspaceId, ownerUserId: context.ownerUserId,
      planId: context.planId, sourceTurnId, resource });
    // A rejected citation must not freeze an unusable payload and prevent the agent from correcting it.
    const page = getPage(pageId, context.ownerUserId);
    validateMaintenanceSegmentSourceReferences(page.workspaceId, context.ownerUserId,
      ops.flatMap(op => op.op === 'insert' || op.op === 'update' ? [op.block] : []), page.blocks, resourceEvidence(context, sourceTurnId));
    const frozen = freezeMaintenanceResourcePayload({ ...authority(context), planId: context.planId, sourceTurnId,
      kind: 'page', resourceId: pageId, payload, assignedIds, now: now() });
    let result: PageWriteResult;
    try {
      result = applyMaintenancePageSet({ workspaceId: context.workspaceId, ownerUserId: context.ownerUserId,
        pageId, expectedRevision: resource.revision, source: { kind: 'maintenance', ...context.execution,
          jobId: context.jobId, runId: context.runId, evidence: [resourceEvidence(context, sourceTurnId)] },
        evidence: resourceEvidence(context, sourceTurnId), operationKey, payloadHash: frozen.payloadHash, planId: context.planId,
        sourceTurnId, generation: plan.generation, ops,
        assignedIds: frozen.assignedIds as { blockIds: string[] }, execution: context.execution, authority: authority(context), now: now() });
    } catch (error) {
      // A conversation took the lease after the checks above; the write rolled back, so record the deferral outside it.
      if (error instanceof PageEditBusyError) {
        deferMaintenancePageForEditLease({ planId: context.planId, sourceTurnId, pageId, runId: context.runId, now: now() });
      }
      throw error;
    }
    return requireSuccessfulResourceResult(result);
  }
  function database(context: MaintenanceExecutionContext, sourceTurnId: string, databaseId: string, rawOps: unknown): PageWriteResult {
    const plan = contextPlan(context, true);
    const resource = getPlannedMaintenanceResource(context, sourceTurnId, 'database', databaseId, true);
    const ops = normalizedDatabaseOps(rawOps);
    const payload = canonical({ ops });
    const operationKey = maintenanceOperationKey(context.jobId, sourceTurnId, 'database', databaseId, plan.generation);
    const assignedIds = { rowIds: stableIds(operationKey, payload, ops.filter((op) => op.op === 'row.add').length, 'row') };
    const saved = replayResult(operationKey, context, sourceTurnId, payload, assignedIds);
    if (saved) return requireSuccessfulResourceResult(saved);
    if (!['routing', 'processing'].includes(plan.state)) throw new PageWriteError(409, 'stale_revision', 'Maintenance plan is terminal');
    assertMaintenanceSourceCoverageComplete(context.planId, context.ownerUserId, sourceTurnId);
    assertMaintenanceResourceCurrent({ workspaceId: context.workspaceId, ownerUserId: context.ownerUserId,
      planId: context.planId, sourceTurnId, resource });
    const frozen = freezeMaintenanceResourcePayload({ ...authority(context), planId: context.planId, sourceTurnId,
      kind: 'database', resourceId: databaseId, payload, assignedIds, now: now() });
    const result = applyMaintenanceDatabaseSet({ ...authority(context), planId: context.planId, sourceTurnId,
      resource, databaseId, payloadHash: frozen.payloadHash, payload: frozen.payload, assignedIds: frozen.assignedIds,
      ops, execution: context.execution,
      evidence: resourceEvidence(context, sourceTurnId), now: now() });
    return requireSuccessfulResourceResult(result);
  }
  return { page, database };
}

function resourceEvidence(context: MaintenanceExecutionContext, sourceTurnId: string): BlockSource {
  return requireMaintenanceSource(context, sourceTurnId, true).evidence;
}

function requireSuccessfulResourceResult(result: PageWriteResult): PageWriteResult {
  if (result.rejected.length) throw new PageWriteError(409, 'stale_revision', 'Maintenance operation set was rejected atomically and nothing was applied; read the resource again and send a corrected operation set');
  if (!result.applied.length && !result.proposed.length) throw invalid('The operation set made no verified change; record an explicit no-change decision');
  return result;
}

export function maintenanceReceiptOutcome(result: PageWriteResult): MaintenanceReceipt['outcome'] {
  return result.applied.length ? 'written' : 'proposed';
}
