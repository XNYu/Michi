import { isSystemWorkspaceSettings, type BlockSource, type ChangeEvidence, type ChangeReadScope, type FirstRunState, type PageWriteResult } from 'michi-shared';
import { getDb } from '../db';
import { PageWriteError, pagesTransaction } from '../pages/core';
import { assertMaintenanceAuthority } from '../pages/maintenanceRepository';
import { getMaintenancePageBlocks } from '../pages/repository';
import { getFirstRun, updateFirstRun } from '../pages/firstRun';
import { listWorkspaceHomes } from '../pages/homePages';
import { readNode, readNodeOverview, type ReadNodeOpts } from '../globalContext';
import {
  finishHomeRun, firstRunReadNodeIds, getHomeRun, recordFirstRunReads, type HomeRunKind, type HomeRunRecord,
} from './firstRunStore';
import { FIRST_RUN_LIST_PAGE, firstRunWindowDays, historyListPage, listHistoryConversations } from './firstRunHistory';
import { homeWritePayloadHash, writeHomePage } from './firstRunWriter';
import { citedOps, forgetHomeRunReads, noteReadHome, noteReadMessages, readHomeCount, withoutSources, type DroppedSource } from './firstRunSources';
import { noteFirstRunProgress } from './firstRunHold';

/** The trusted run binding a maintenance send carries (MaintenanceExecutionContext). */
export interface HomeToolContext {
  workspaceId: string; ownerUserId: string; jobId: string; runId: string; claimedBy: string; configRevision: number;
  planId: string;
  execution: BlockSource & { runId: string };
}

export const HOME_RUN_ID_PREFIX = 'mhr-';
const invalid = (message: string) => new PageWriteError(400, 'invalid', message);

/** The home run a maintenance send is bound to, or null for an incremental plan. */
export function homeRunFor(context: HomeToolContext): HomeRunRecord | null {
  if (!context.planId.startsWith(HOME_RUN_ID_PREFIX)) return null;
  const run = getHomeRun(context.planId, context.ownerUserId);
  if (!run || run.workspaceId !== context.workspaceId || run.jobId !== context.jobId || run.runId !== context.runId) {
    throw new PageWriteError(409, 'stale_revision', 'This maintenance run is no longer bound to a home run');
  }
  return run;
}

function authority(context: HomeToolContext, now: number): void {
  assertMaintenanceAuthority({ workspaceId: context.workspaceId, ownerUserId: context.ownerUserId, jobId: context.jobId,
    runId: context.runId, claimedBy: context.claimedBy, configRevision: context.configRevision }, now);
}

function activeRun(context: HomeToolContext, kind: HomeRunKind | null, now: number): HomeRunRecord {
  const run = homeRunFor(context);
  if (!run) throw new PageWriteError(409, 'invalid', 'This tool is only available while the Meta agent writes a home page');
  if (kind && run.kind !== kind) {
    throw new PageWriteError(409, 'invalid', kind === 'first-run'
      ? 'History tools are only available during a first-time generation' : 'Workspace homes are only read for the Spaces Home summary');
  }
  authority(context, now);
  return run;
}

function stillOpen(run: HomeRunRecord): void {
  if (run.state !== 'active') throw new PageWriteError(409, 'stale_revision', `This home run already finished (${run.state}); make no further write or no-change call`);
}

const FIRST_RUN_ORDER: FirstRunState[] = ['queued', 'reading', 'writing', 'done'];

/** Moves progress forward only; a run that already finished or failed is left alone. */
function advanceFirstRun(workspaceId: string, ownerUserId: string, target: 'reading' | 'writing' | 'done', now: number): void {
  const current = getFirstRun(workspaceId, ownerUserId);
  if (!current || current.state === 'done' || current.state === 'failed') return;
  const reads = new Set(firstRunReadNodeIds(workspaceId, ownerUserId));
  const readCount = Math.max(current.readCount, Math.min(reads.size, current.total));
  const steps = FIRST_RUN_ORDER.slice(FIRST_RUN_ORDER.indexOf(current.state) + 1, FIRST_RUN_ORDER.indexOf(target) + 1);
  for (const state of steps) updateFirstRun({ workspaceId, ownerUserId, state, readCount, now });
  if (!steps.length && readCount !== current.readCount) updateFirstRun({ workspaceId, ownerUserId, readCount, now });
}

function historyFor(context: HomeToolContext) {
  const progress = getFirstRun(context.workspaceId, context.ownerUserId);
  if (!progress) throw new PageWriteError(409, 'invalid', 'This workspace has no first-time generation');
  return listHistoryConversations(context.workspaceId, progress.startedAt, firstRunWindowDays(context.workspaceId, context.ownerUserId));
}

function markRead(context: HomeToolContext, nodeIds: string[], now: number): void {
  recordFirstRunReads(context.workspaceId, context.ownerUserId, nodeIds, now);
  advanceFirstRun(context.workspaceId, context.ownerUserId, 'reading', now);
}

function integer(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw invalid(`${name} must be an integer from ${min} to ${max}`);
  return value as number;
}

export function listHistory(context: HomeToolContext, args: Record<string, unknown>, now: number) {
  activeRun(context, 'first-run', now);
  const all = historyFor(context);
  const page = historyListPage(all, integer(args.offset, 'offset', 0, all.length, 0),
    integer(args.limit, 'limit', 1, FIRST_RUN_LIST_PAGE.max, FIRST_RUN_LIST_PAGE.default));
  markRead(context, page.conversations.map((entry) => entry.nodeId), now);
  return page;
}

function historyNode(context: HomeToolContext, nodeId: unknown): string {
  if (typeof nodeId !== 'string' || !nodeId.trim()) throw invalid('nodeId is required');
  if (!historyFor(context).some((entry) => entry.nodeId === nodeId)) {
    throw new PageWriteError(404, 'not_found', 'Conversation is not in this workspace\'s first-time reading range');
  }
  return nodeId;
}

function nodeText(result: { status: string; text: string }) {
  if (result.status !== 'ok') throw new PageWriteError(result.status === 'not_found' ? 404 : 409, 'invalid', result.text);
  return { text: result.text };
}

export function readHistoryOverview(context: HomeToolContext, args: Record<string, unknown>, now: number) {
  activeRun(context, 'first-run', now);
  const nodeId = historyNode(context, args.nodeId);
  const result = nodeText(readNodeOverview(context.workspaceId, context.ownerUserId, nodeId));
  markRead(context, [nodeId], now);
  return result;
}

/** Shows each message with its id, so a block can cite the message its facts come from. */
export function readHistoryNode(context: HomeToolContext, args: Record<string, unknown>, now: number) {
  const run = activeRun(context, 'first-run', now);
  const nodeId = historyNode(context, args.nodeId);
  const opts: ReadNodeOpts = { limit: integer(args.limit, 'limit', 1, 50, 20), messageIds: true };
  if (args.role === 'user' || args.role === 'assistant') opts.role = args.role;
  if (args.from === 'head' || args.from === 'tail') opts.from = args.from;
  if (args.offset !== undefined) opts.offset = integer(args.offset, 'offset', 1, 100_000, 1);
  const result = nodeText(readNode(context.workspaceId, context.ownerUserId, nodeId, opts));
  markRead(context, [nodeId], now);
  noteReadMessages(run.id, nodeId, result.text);
  return result;
}

/** Lists the workspace homes, or reads one in block ranges; the summary never reads conversations. */
export function readWorkspaceHome(context: HomeToolContext, args: Record<string, unknown>, now: number) {
  const run = activeRun(context, 'home-summary', now);
  const homes = listWorkspaceHomes(context.ownerUserId).filter((home) => home.firstRun && home.hiddenAt === null);
  if (args.workspaceId === undefined) {
    return { workspaces: homes.map((home) => ({ workspaceId: home.workspaceId, workspaceName: home.workspaceName,
      homePageId: home.homePageId, firstRun: home.firstRun?.state ?? null, error: home.firstRun?.error ?? null })) };
  }
  const home = homes.find((entry) => entry.workspaceId === args.workspaceId);
  if (!home?.homePageId) throw new PageWriteError(404, 'not_found', 'Workspace home not found');
  const offset = integer(args.offset, 'offset', 0, 1_000, 0);
  const limit = integer(args.limit, 'limit', 1, 20, 20);
  const page = getMaintenancePageBlocks(home.homePageId, context.ownerUserId, { offset, limit });
  noteReadHome(run.id, home.workspaceId);
  return { workspaceId: home.workspaceId, workspaceName: home.workspaceName, ...page };
}

function targetOf(run: HomeRunRecord, args: Record<string, unknown>): string {
  if (args.sourceTurnId !== run.id) throw invalid(`Use sourceTurnId "${run.id}" for this run`);
  if (args.pageId !== run.targetPageId && args.resourceId !== run.targetPageId) {
    throw new PageWriteError(404, 'not_found', 'This run may only read and write its own home page');
  }
  return run.targetPageId;
}

export function readTargetPage(context: HomeToolContext, args: Record<string, unknown>, now: number) {
  const run = activeRun(context, null, now);
  const pageId = targetOf(run, args);
  const page = getMaintenancePageBlocks(pageId, context.ownerUserId, {
    ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
    ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
  });
  if (run.kind === 'first-run' && run.state === 'active') advanceFirstRun(context.workspaceId, context.ownerUserId, 'writing', now);
  return page;
}

interface HomeWriteSources { ops: unknown; evidence: ChangeEvidence[][]; read: ChangeReadScope | null; notes: string[] }

/**
 * A first run's blocks cite the messages named in their `sources`, and every
 * record says how many conversations the run read. A summary cites no
 * conversation; its records say how many workspace homes it read.
 */
function sourcesFor(run: HomeRunRecord, context: HomeToolContext, rawOps: unknown): HomeWriteSources {
  if (run.kind !== 'first-run') {
    const stripped = withoutSources(rawOps, true);
    const homes = readHomeCount(run.id);
    return { ops: stripped.ops, evidence: [], read: homes > 0 ? { kind: 'workspace-homes', count: homes } : null,
      notes: stripped.dropped ? ['The Spaces Home summary cites the workspace homes it read; sources on its operations were ignored.'] : [] };
  }
  const read = new Set(firstRunReadNodeIds(context.workspaceId, context.ownerUserId));
  const nodeIds = new Set(historyFor(context).filter((entry) => read.has(entry.nodeId)).map((entry) => entry.nodeId));
  const cited = citedOps({ runId: run.id, rawOps, nodeIds });
  return { ops: cited.ops, evidence: cited.evidence, read: { kind: 'conversations', count: nodeIds.size }, notes: cited.dropped.map(droppedNote) };
}

function droppedNote(entry: DroppedSource): string {
  const name = typeof entry.messageId === 'string' ? `message ${entry.messageId}` : 'a source';
  return `Operation ${entry.op}: ${name} was not cited (${entry.reason}).`;
}

function finishProgress(run: HomeRunRecord, context: HomeToolContext, now: number): void {
  if (run.kind === 'first-run') advanceFirstRun(context.workspaceId, context.ownerUserId, 'done', now);
}

/** The run's one final write: an exact retry replays the receipt; anything else is refused once it finished. */
export function writeTargetPage(context: HomeToolContext, args: Record<string, unknown>, now: number): PageWriteResult {
  const run = activeRun(context, null, now);
  const pageId = targetOf(run, args);
  const payloadHash = homeWritePayloadHash(pageId, args.ops);
  if (run.state === 'written' && run.payloadHash === payloadHash) return run.result as PageWriteResult;
  stillOpen(run);
  if (!targetIsHome(run)) throw new PageWriteError(404, 'not_found', 'Home page not found');
  const sources = sourcesFor(run, context, args.ops);
  const result = pagesTransaction(() => {
    authority(context, now);
    const current = homeRunFor(context)!;
    stillOpen(current);
    const page = writeHomePage({ ownerUserId: context.ownerUserId, pageId, ops: sources.ops, execution: context.execution,
      jobId: context.jobId, evidence: sources.evidence, read: sources.read, now });
    const written: PageWriteResult & { sourceNotes?: string[] } = sources.notes.length ? { ...page, sourceNotes: sources.notes } : page;
    if (!finishHomeRun(run.id, { state: 'written', payloadHash, result: written }, now)) throw new PageWriteError(409, 'stale_revision', 'This home run already finished');
    finishProgress(run, context, now);
    return written;
  });
  forgetHomeRunReads(run.id);
  if (run.kind === 'first-run') noteFirstRunProgress(context.ownerUserId, now);
  return result;
}

export function recordTargetNoChange(context: HomeToolContext, args: Record<string, unknown>, now: number) {
  const run = activeRun(context, null, now);
  targetOf(run, args);
  if (args.resourceKind !== 'page') throw invalid('resourceKind must be page');
  const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
  if (!reason || reason.length > 2000) throw invalid('A 1-2000 character reason is required');
  const result = { decision: 'no_change', reason, resource: { kind: 'page', id: run.targetPageId } };
  if (run.state === 'no_change' && JSON.stringify(run.result) === JSON.stringify(result)) return result;
  stillOpen(run);
  const recorded = pagesTransaction(() => {
    authority(context, now);
    if (!finishHomeRun(run.id, { state: 'no_change', result }, now)) throw new PageWriteError(409, 'stale_revision', 'This home run already finished');
    finishProgress(run, context, now);
    return result;
  });
  forgetHomeRunReads(run.id);
  if (run.kind === 'first-run') noteFirstRunProgress(context.ownerUserId, now);
  return recorded;
}

/** A first run writes a user workspace's home; a summary writes the Spaces Home. */
function targetIsHome(run: HomeRunRecord): boolean {
  const row = getDb().prepare('SELECT w.settings,p.role FROM pages p JOIN workspaces w ON w.id=p.workspace_id WHERE p.id=? AND p.owner_user_id=?')
    .get(run.targetPageId, run.ownerUserId) as { settings: string | null; role: string | null } | undefined;
  if (!row) return false;
  return run.kind === 'first-run'
    ? row.role === 'workspace-home' && !isSystemWorkspaceSettings(row.settings)
    : row.role === 'spaces-home';
}
