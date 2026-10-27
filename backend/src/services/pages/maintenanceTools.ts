import { createHash } from 'node:crypto';
import { pageBlockInputSchema, TASK_COLUMN } from 'michi-shared';
import type { BlockSource, MaintenanceResourceKind } from 'michi-shared';
import { META_AGENT_MAINTENANCE_TOOL_NAMES } from '../../agents/maintenancePolicy';
import {
  homeRunFor, listHistory, readHistoryNode, readHistoryOverview, readTargetPage, readWorkspaceHome, recordTargetNoChange, writeTargetPage,
  type HomeToolContext,
} from '../metaAgent/firstRunTools';
import { readMaintenanceSourceMessages, assertMaintenanceSourceCoverageComplete } from './maintenanceRepository';
import { getDatabase, getMaintenanceDatabasePage, getMaintenancePageBlocks, liveTaskDatabaseId } from './repository';
import { threadStates } from './homeSections';
import { listTasks } from './taskList';
import { pageLayoutContext } from './layoutRules';
import {
  assertMaintenanceAuthority, assertMaintenanceResourceCurrent, freezeMaintenanceResourcePayload, getMaintenancePlan, getMaintenanceReceipt,
  maintenanceOperationKey, persistMaintenanceReceiptInTransaction,
} from './maintenanceRepository';
import { runInTransaction } from '../db';
import { withoutSources } from '../metaAgent/firstRunSources';
import { PageWriteError } from './core';
import {
  createMaintenanceWriter, getPlannedMaintenanceResource, reobserveRoutedResource, requireMaintenanceResource, requireMaintenanceSource,
  listMaintenanceSourceResources, routeMaintenanceSource, type MaintenanceExecutionContext,
} from './maintenanceWriter';

export interface MaintenanceToolDefinition {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
  execute(args: unknown): MaintenanceToolResult;
}

export interface MaintenanceToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  details?: unknown;
}

export interface MaintenanceToolDependencies {
  readSource?: typeof readMaintenanceSourceMessages;
  now?: () => number;
}

const string = { type: 'string', minLength: 1, maxLength: 200 };
const MAINTENANCE_READ_MAX_BYTES = 64 * 1024;
const MAINTENANCE_TASK_LIMIT = 20;
const databaseCellValue = { anyOf: [
  { type: 'string', maxLength: 2000 }, { type: 'number' }, { type: 'boolean' }, { type: 'null' },
  { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 200 } },
  { type: 'object', properties: { start: { type: 'string', maxLength: 100 }, end: { type: 'string', maxLength: 100 } }, required: ['start'], additionalProperties: false },
] };
const databaseValues = { type: 'object', description: 'Object mapping exact database column IDs from maintenance_read_database to cell values.', additionalProperties: databaseCellValue };
const databaseWriteOperation = (op: 'row.add' | 'row.update' | 'row.delete', extra: Record<string, unknown>, required: string[]) => ({
  type: 'object', properties: { op: { type: 'string', enum: [op] }, ...extra }, required: ['op', ...required], additionalProperties: false,
});
/** One branch per catalog block type (blockCatalog.ts). */
const pageBlockInput = pageBlockInputSchema();
const pageWriteOperation = (op: 'insert' | 'update' | 'delete' | 'move', extra: Record<string, unknown>, required: string[]) => ({
  type: 'object', properties: { op: { type: 'string', enum: [op] }, ...extra }, required: ['op', ...required], additionalProperties: false,
});
const blockSources = { type: 'array', maxItems: 10, description: 'First-time generation only: the messages this block\'s facts come from, each the conversation\'s nodeId and a message id read_node showed you ([message <id>]). Michi keeps only messages you read. Leave it out in other runs.',
  items: { type: 'object', properties: { nodeId: string, messageId: string }, required: ['nodeId', 'messageId'], additionalProperties: false } };
const maintenancePageOps = { type: 'array', minItems: 1, maxItems: 50, items: { oneOf: [
  pageWriteOperation('insert', { block: pageBlockInput, after: { anyOf: [string, { type: 'null' }] }, sources: blockSources }, ['block', 'after']),
  pageWriteOperation('update', { id: string, expectRev: { type: 'integer', minimum: 1 }, block: pageBlockInput, sources: blockSources }, ['id', 'expectRev', 'block']),
  pageWriteOperation('delete', { id: string, expectRev: { type: 'integer', minimum: 1 } }, ['id', 'expectRev']),
  pageWriteOperation('move', { id: string, expectRev: { type: 'integer', minimum: 1 }, after: { anyOf: [string, { type: 'null' }] } }, ['id', 'expectRev', 'after']),
] } };
const maintenanceDatabaseOps = { type: 'array', minItems: 1, maxItems: 50, items: { oneOf: [
  databaseWriteOperation('row.add', { values: databaseValues, body: { type: 'string', maxLength: 100000 }, after: { anyOf: [string, { type: 'null' }] } }, ['values']),
  databaseWriteOperation('row.update', { id: string, expectRev: { type: 'integer', minimum: 1 }, values: databaseValues }, ['id', 'expectRev', 'values']),
  databaseWriteOperation('row.update', { id: string, expectRev: { type: 'integer', minimum: 1 }, body: { type: 'string', maxLength: 100000 } }, ['id', 'expectRev', 'body']),
  databaseWriteOperation('row.update', { id: string, expectRev: { type: 'integer', minimum: 1 }, values: databaseValues, body: { type: 'string', maxLength: 100000 } }, ['id', 'expectRev', 'values', 'body']),
  databaseWriteOperation('row.delete', { id: string, expectRev: { type: 'integer', minimum: 1 } }, ['id', 'expectRev']),
] } };
const schema = (properties: Record<string, unknown>, required: string[]): MaintenanceToolDefinition['parameters'] =>
  ({ type: 'object', properties, required, additionalProperties: false });
const failure = (error: unknown) => ({
  isError: true,
  content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Maintenance tool failed' }],
});
const success = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value });
function closedArgs(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PageWriteError(400, 'invalid', 'Expected a maintenance tool object');
  const args = raw as Record<string, unknown>;
  if (Object.keys(args).some((key) => !keys.includes(key))) throw new PageWriteError(400, 'invalid', 'Maintenance tool arguments contain unsupported fields');
  return args;
}

function invoke<T>(fn: () => T) {
  try { return success(fn()); } catch (error) { return failure(error); }
}

function assertAuthority(context: MaintenanceExecutionContext, now: number): void {
  assertMaintenanceAuthority({ workspaceId: context.workspaceId, ownerUserId: context.ownerUserId, jobId: context.jobId,
    runId: context.runId, claimedBy: context.claimedBy, configRevision: context.configRevision }, now);
}

function validateSourceChoice(context: MaintenanceExecutionContext, sourceTurnId: unknown) {
  const selected = requireMaintenanceSource(context, sourceTurnId, true);
  return selected;
}

function noChange(context: MaintenanceExecutionContext, args: Record<string, unknown>, now: number) {
  const sourceTurnId = args.sourceTurnId;
  const selected = validateSourceChoice(context, sourceTurnId);
  const kind = args.resourceKind;
  if (kind !== 'page' && kind !== 'database') throw new PageWriteError(400, 'invalid', 'resourceKind must be page or database');
  if (typeof args.resourceId !== 'string') throw new PageWriteError(400, 'invalid', 'resourceId is required');
  const reason = args.reason;
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000) throw new PageWriteError(400, 'invalid', 'A 1-2000 character reason is required');
  const resource = getPlannedMaintenanceResource(context, sourceTurnId as string, kind as MaintenanceResourceKind, args.resourceId, true);
  assertMaintenanceSourceCoverageComplete(context.planId, context.ownerUserId, sourceTurnId as string);
  const plan = getMaintenancePlan(context.planId, context.ownerUserId);
  if (!plan) throw new PageWriteError(409, 'stale_revision', 'Maintenance plan no longer exists');
  const operationKey = maintenanceOperationKey(context.jobId, sourceTurnId as string, kind, args.resourceId, plan.generation);
  const payload = { decision: 'no_change', reason: reason.trim() };
  const assignedIds = {};
  const prior = runInTransaction(() => {
    assertMaintenanceAuthority({ workspaceId: context.workspaceId, ownerUserId: context.ownerUserId, jobId: context.jobId,
      runId: context.runId, claimedBy: context.claimedBy, configRevision: context.configRevision }, now);
    const receipt = getMaintenanceReceipt(operationKey);
    if (!receipt) return null;
    const expectedHash = createHash('sha256').update(JSON.stringify({ payload, assignedIds })).digest('hex');
    if (receipt.planId !== context.planId || receipt.jobId !== context.jobId || receipt.sourceTurnId !== sourceTurnId ||
        receipt.payloadHash !== expectedHash || JSON.stringify(receipt.payload) !== JSON.stringify(payload) ||
        JSON.stringify(receipt.assignedIds) !== JSON.stringify(assignedIds) ||
        JSON.stringify(receipt.evidence) !== JSON.stringify(selected.evidence)) {
      throw new PageWriteError(409, 'stale_revision', 'Maintenance receipt does not match this no-change decision');
    }
    return receipt;
  });
  if (prior) return prior;
  if (!['routing', 'processing'].includes(plan.state)) throw new PageWriteError(409, 'stale_revision', 'Maintenance plan is terminal');
  // Check before freezing: a payload frozen against a moved target could never be recorded or replaced.
  assertMaintenanceResourceCurrent({ workspaceId: context.workspaceId, ownerUserId: context.ownerUserId,
    planId: context.planId, sourceTurnId: sourceTurnId as string, resource });
  const frozen = freezeMaintenanceResourcePayload({ workspaceId: context.workspaceId, ownerUserId: context.ownerUserId,
    jobId: context.jobId, runId: context.runId, claimedBy: context.claimedBy, configRevision: context.configRevision,
    planId: context.planId, sourceTurnId: sourceTurnId as string, kind, resourceId: args.resourceId,
    payload, assignedIds, now });
  const receipt = runInTransaction(() => {
    assertMaintenanceAuthority({ workspaceId: context.workspaceId, ownerUserId: context.ownerUserId, jobId: context.jobId,
      runId: context.runId, claimedBy: context.claimedBy, configRevision: context.configRevision }, now);
    const prior = getMaintenanceReceipt(operationKey);
    if (!prior) assertMaintenanceResourceCurrent({ workspaceId: context.workspaceId, ownerUserId: context.ownerUserId,
      planId: context.planId, sourceTurnId: sourceTurnId as string, resource });
    return persistMaintenanceReceiptInTransaction({
    workspaceId: context.workspaceId, ownerUserId: context.ownerUserId, jobId: context.jobId, runId: context.runId,
    claimedBy: context.claimedBy, configRevision: context.configRevision, planId: context.planId,
    sourceTurnId: sourceTurnId as string, resource, outcome: 'no_change', payloadHash: frozen.payloadHash,
    payload: frozen.payload, assignedIds: frozen.assignedIds,
    result: { decision: 'no_change', reason: reason.trim(), resource: { kind, id: args.resourceId } },
      execution: context.execution, evidence: selected.evidence, now,
    });
  });
  return receipt;
}

/** Build the restricted, closed-schema MCP tool set for one scheduled run. */
export function createMaintenanceTools(
  contextSource: MaintenanceExecutionContext | (() => MaintenanceExecutionContext | null),
  dependencies: MaintenanceToolDependencies = {},
): MaintenanceToolDefinition[] {
  const writer = createMaintenanceWriter();
  const currentTime = dependencies.now ?? Date.now;
  const getContext = typeof contextSource === 'function' ? contextSource : () => contextSource;
  const requireContext = (): MaintenanceExecutionContext => {
    const context = getContext();
    if (!context) throw new PageWriteError(409, 'stale_revision', 'No active maintenance send owns this tool call');
    return context;
  };
  const definitions: MaintenanceToolDefinition[] = [
    {
      name: 'maintenance_read_source',
      description: 'Read full original messages from one source turn in bounded parts. Continue with the returned cursor until coverageComplete is true.',
      parameters: schema({ sourceTurnId: string, afterMessageId: string, afterPartIndex: { type: 'integer', minimum: 0 }, maxParts: { type: 'integer', minimum: 1, maximum: 20 }, acknowledgeParts: { type: 'array', maxItems: 100, items: { type: 'object', properties: { partId: { type: 'string', maxLength: 220 }, partHash: { type: 'string', minLength: 64, maxLength: 64 } }, required: ['partId', 'partHash'], additionalProperties: false } } }, ['sourceTurnId']),
      execute: (raw) => invoke(() => {
        const args = closedArgs(raw, ['sourceTurnId', 'afterMessageId', 'afterPartIndex', 'maxParts', 'acknowledgeParts']);
        const context = requireContext();
        assertAuthority(context, currentTime());
        validateSourceChoice(context, args.sourceTurnId);
        return (dependencies.readSource ?? readMaintenanceSourceMessages)({ planId: context.planId, ownerUserId: context.ownerUserId,
          sourceTurnId: args.sourceTurnId as string, ...(typeof args.afterMessageId === 'string' ? { afterMessageId: args.afterMessageId } : {}),
          ...(typeof args.afterPartIndex === 'number' ? { afterPartIndex: args.afterPartIndex } : {}),
          ...(typeof args.maxParts === 'number' ? { maxParts: args.maxParts } : {}),
          ...(Array.isArray(args.acknowledgeParts) ? { acknowledgeParts: args.acknowledgeParts as Array<{ partId: string; partHash: string }> } : {}), now: currentTime() });
      }),
    },
    {
      name: 'maintenance_list_resources',
      description: 'Page through the complete eligible Pages and Databases manifest for one source turn before routing it. For a source that is already routed (a recovered run) it lists the routed resources instead, each with its decision; it does not refresh anything. Reading a routed resource from its first page refreshes its revision.',
      parameters: schema({ sourceTurnId: string, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['sourceTurnId']),
      execute: (raw) => invoke(() => {
        const args = closedArgs(raw, ['sourceTurnId', 'offset', 'limit']); const context = requireContext(); assertAuthority(context, currentTime());
        validateSourceChoice(context, args.sourceTurnId);
        return listMaintenanceSourceResources(context, args.sourceTurnId as string,
          typeof args.offset === 'number' ? args.offset : 0, typeof args.limit === 'number' ? args.limit : 100);
      }),
    },
    {
      name: 'maintenance_read_page',
      description: 'Read a routed page in bounded block ranges of at most 20 blocks and 64 KB. Continue with nextOffset until null. '
        + 'layoutPreferences.text is the user\'s instruction document for this page only; follow it together with layoutRules when you write the page. A rule with a sectionLimit is applied by Michi itself and remains authoritative.',
      parameters: schema({ sourceTurnId: string, pageId: string, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, ['sourceTurnId', 'pageId']),
      execute: (raw) => invoke(() => {
        const args = closedArgs(raw, ['sourceTurnId', 'pageId', 'offset', 'limit']); const context = requireContext(); assertAuthority(context, currentTime());
        // The first range refreshes a routed page's revision; a continuation must still match the one it started from.
        if (!args.offset) reobserveRoutedResource(context, args.sourceTurnId as string, 'page', args.pageId as string);
        const ref = requireMaintenanceResource(context, args.sourceTurnId as string, 'page', args.pageId as string);
        const page = getMaintenancePageBlocks(ref.id, context.ownerUserId, {
          ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
          ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        });
        if (page.page.workspaceId !== context.workspaceId || page.page.revision !== ref.revision) throw new PageWriteError(409, 'stale_revision', 'Page changed since routing; read it again from the first page; that read refreshes its revision (a continuation read cannot)');
        return withLayoutRules(page, context.ownerUserId);
      }),
    },
    {
      name: 'maintenance_read_database',
      description: 'Read a bounded database page (at most five rows and four selected columns, capped at 64 KB). Each row includes id and rev; use that rev as expectRev in row.update or row.delete. Continue with nextCursor; request specific columnIds and includeBodies only when needed.',
      parameters: schema({ sourceTurnId: string, databaseId: string, cursor: { type: 'string', maxLength: 220 }, limit: { type: 'integer', minimum: 1, maximum: 5 }, columnIds: { type: 'array', maxItems: 4, items: { type: 'string', minLength: 1, maxLength: 200 } }, includeBodies: { type: 'boolean' } }, ['sourceTurnId', 'databaseId']),
      execute: (raw) => invoke(() => {
        const args = closedArgs(raw, ['sourceTurnId', 'databaseId', 'cursor', 'limit', 'columnIds', 'includeBodies']); const context = requireContext(); assertAuthority(context, currentTime());
        if (args.cursor === undefined) reobserveRoutedResource(context, args.sourceTurnId as string, 'database', args.databaseId as string);
        const ref = requireMaintenanceResource(context, args.sourceTurnId as string, 'database', args.databaseId as string);
        const database = getMaintenanceDatabasePage(ref.id, context.ownerUserId, {
          ...(typeof args.cursor === 'string' ? { cursor: args.cursor } : {}),
          ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
          ...(Array.isArray(args.columnIds) ? { columnIds: args.columnIds as string[] } : {}),
          ...(typeof args.includeBodies === 'boolean' ? { includeBodies: args.includeBodies } : {}),
        });
        if (database.database.workspaceId !== context.workspaceId || database.database.revision !== ref.revision) throw new PageWriteError(409, 'stale_revision', 'Database changed since routing; read it again from the first page; that read refreshes its revision (a continuation read cannot)');
        return database;
      }),
    },
    {
      name: 'maintenance_list_tasks',
      description: 'Find tasks in this workspace\'s task database (the database whose role is "tasks") '
        + 'by nodeId (tasks that link that conversation), by words in a task, its next step or its notes (query), and by status values. '
        + 'Route that database for this source with maintenance_route_source first; until then this call fails. '
        + 'Returns at most 20 compact tasks, newest change first: id and rev (for maintenance_write_database), task, status, statusSetBy '
        + '("user": the user set it, so your change to it becomes a suggestion), next, conversationIds, waitingConversationIds (waiting on the user now), '
        + 'goneConversationIds (deleted or moved away: unlink them) and hasNotes. more is true when more tasks match; narrow the search.',
      parameters: schema({
        sourceTurnId: string, nodeId: string, query: { type: 'string', minLength: 1, maxLength: 200 },
        statuses: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 200 } },
        limit: { type: 'integer', minimum: 1, maximum: MAINTENANCE_TASK_LIMIT },
      }, ['sourceTurnId']),
      execute: (raw) => invoke(() => {
        const args = closedArgs(raw, ['sourceTurnId', 'nodeId', 'query', 'statuses', 'limit']); const context = requireContext(); assertAuthority(context, currentTime());
        return listMaintenanceTasks(context, args, currentTime());
      }),
    },
    {
      name: 'maintenance_route_source',
      description: 'Select pages and databases from the immutable eligible manifest for an original source turn. An empty set requires a reason.',
      parameters: schema({ sourceTurnId: string, candidates: { type: 'array', maxItems: 2000, items: { type: 'object', properties: { kind: { enum: ['page', 'database'] }, id: string }, required: ['kind', 'id'], additionalProperties: false } }, reason: { type: 'string', maxLength: 2000 } }, ['sourceTurnId', 'candidates']),
      execute: (raw) => invoke(() => {
        const args = closedArgs(raw, ['sourceTurnId', 'candidates', 'reason']); const context = requireContext(); assertAuthority(context, currentTime());
        return routeMaintenanceSource(context, args.sourceTurnId as string, args.candidates, args.reason as string | undefined);
      }),
    },
    {
      name: 'maintenance_write_page',
      description: 'Make one final write call for this source turn and page: first read the whole page, then include all intended related changes in this 1-50-operation atomic batch. Preserve unrelated blocks and update a matching existing block instead of inserting a duplicate. Existing-block operations require id and its current rev as expectRev. Protected edits appear in result.proposed and remain unchanged; the proposal is durable handling and final for this page in this run. After a successful applied/proposed response, do not call this writer or maintenance_no_change for this page; only an exact retry replays the receipt. Use insert, update, delete, or move. Insert requires after (a block ID or null). Block inputs follow the type-specific forms in the schema and must not include server-owned id, rev, sources, or edit fields.',
      parameters: schema({ sourceTurnId: string, pageId: string, ops: maintenancePageOps }, ['sourceTurnId', 'pageId', 'ops']),
      // An incremental write cites its source turn; block sources belong to a first-time generation.
      execute: (raw) => invoke(() => { const args = closedArgs(raw, ['sourceTurnId', 'pageId', 'ops']); const context = requireContext(); assertAuthority(context, currentTime()); return writer.page(context, args.sourceTurnId as string, args.pageId as string, withoutSources(args.ops).ops); }),
    },
    {
      name: 'maintenance_write_database',
      description: 'Make one final write call for this source turn and database: first read all relevant rows and columns (including bodies when needed), then include all intended related changes in this 1-50-operation atomic batch. Preserve unrelated values and update matching rows instead of adding duplicates. Use row.add (writer assigns ID), row.update with the current row rev as expectRev, or row.delete with the current row rev as expectRev. Protected parts of edits appear in result.proposed and remain unchanged; proposals are durable handling and final for this database in this run. After a successful applied/proposed response, do not call this writer or maintenance_no_change for this database; only an exact retry replays the receipt. Values keys must be exact column IDs from the database read. Example: {"op":"row.update","id":"row-123","expectRev":3,"values":{"column-status":"In progress"}}.',
      parameters: schema({ sourceTurnId: string, databaseId: string, ops: maintenanceDatabaseOps }, ['sourceTurnId', 'databaseId', 'ops']),
      execute: (raw) => invoke(() => { const args = closedArgs(raw, ['sourceTurnId', 'databaseId', 'ops']); const context = requireContext(); assertAuthority(context, currentTime()); return writer.database(context, args.sourceTurnId as string, args.databaseId as string, args.ops); }),
    },
    {
      name: 'maintenance_no_change',
      description: 'Record an explicit no-additional-change decision for a routed page or database resource.',
      parameters: schema({ sourceTurnId: string, resourceKind: { enum: ['page', 'database'] }, resourceId: string, reason: { type: 'string', minLength: 1, maxLength: 2000 } }, ['sourceTurnId', 'resourceKind', 'resourceId', 'reason']),
      execute: (raw) => invoke(() => { const args = closedArgs(raw, ['sourceTurnId', 'resourceKind', 'resourceId', 'reason']); const context = requireContext(); assertAuthority(context, currentTime()); return noChange(context, args, currentTime()); }),
    },
    {
      name: 'list_threads',
      description: 'First-time generation only: page through this workspace\'s conversations from the last 30 days (at most 1,000), newest first, with each one\'s title, last activity, message count and latest overview entries. Continue with nextOffset until null.',
      parameters: schema({ offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, []),
      execute: homeOnly,
    },
    {
      name: 'read_node_overview',
      description: 'First-time generation only: read one listed conversation\'s overview journal (a dated summary of each turn).',
      parameters: schema({ nodeId: string }, ['nodeId']),
      execute: homeOnly,
    },
    {
      name: 'read_node',
      description: 'First-time generation only: read one listed conversation\'s messages, at most 50 per call and 12 KB. from "tail" (default) starts at the newest message, "head" at the oldest; offset is 1-based in that direction.',
      parameters: schema({ nodeId: string, role: { type: 'string', enum: ['user', 'assistant'] }, from: { type: 'string', enum: ['head', 'tail'] },
        offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, ['nodeId']),
      execute: homeOnly,
    },
    {
      name: 'maintenance_read_workspace_home',
      description: 'Spaces Home summary only: without workspaceId, list the workspace homes and each first-time generation state; with workspaceId, read that home in block ranges of at most 20 blocks. Continue with nextOffset until null.',
      parameters: schema({ workspaceId: string, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, []),
      execute: homeOnly,
    },
  ];
  if (definitions.map((tool) => tool.name).join('|') !== META_AGENT_MAINTENANCE_TOOL_NAMES.join('|')) {
    throw new Error('Maintenance tools differ from the approved maintenance profile');
  }
  return definitions.map((tool) => ({ ...tool, execute: (raw: unknown) => {
    const context = getContext();
    let homeRun: ReturnType<typeof homeRunFor>;
    try { homeRun = context ? homeRunFor(context) : null; } catch (error) { return failure(error); }
    if (!homeRun) return tool.execute(raw);
    const handler = HOME_RUN_TOOLS[tool.name];
    if (!handler) return failure(new PageWriteError(409, 'invalid', `${tool.name} is not used while the Meta agent writes a home page`));
    return invoke(() => handler(context!, closedArgs(raw, Object.keys(tool.parameters.properties)), currentTime()));
  } }));
}

/** A page read carries the page's layout rules, within the same 64 KB bound. */
function withLayoutRules<T extends { page: { id: string } }>(read: T, ownerUserId: string): T & ReturnType<typeof pageLayoutContext> {
  const result = { ...read, ...pageLayoutContext(read.page.id, ownerUserId) };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAINTENANCE_READ_MAX_BYTES) {
    throw new PageWriteError(400, 'invalid', 'Requested page block range exceeds the 64 KB maintenance read limit; request a smaller block range');
  }
  return result;
}

const homeOnly = () => failure(new PageWriteError(409, 'invalid', 'This tool is only available while the Meta agent writes a home page'));

/** The tools a first-time generation or Spaces Home summary run uses, bound to its home run. */
const HOME_RUN_TOOLS: Record<string, (context: HomeToolContext, args: Record<string, unknown>, now: number) => unknown> = {
  maintenance_read_page: (context, args, now) => withLayoutRules(readTargetPage(context, args, now), context.ownerUserId),
  maintenance_write_page: writeTargetPage,
  maintenance_no_change: recordTargetNoChange,
  list_threads: listHistory,
  read_node_overview: readHistoryOverview,
  read_node: readHistoryNode,
  maintenance_read_workspace_home: readWorkspaceHome,
};

/** The routed task database's tasks for one source: compact, at most 20, within the 64 KB read bound. */
function listMaintenanceTasks(context: MaintenanceExecutionContext, args: Record<string, unknown>, now: number) {
  const words = (value: unknown, name: string): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new PageWriteError(400, 'invalid', `Invalid ${name}`);
    return value;
  };
  const nodeId = words(args.nodeId, 'nodeId');
  const query = words(args.query, 'query');
  if (args.statuses !== undefined && (!Array.isArray(args.statuses) || args.statuses.length > 10
      || args.statuses.some((status) => typeof status !== 'string' || !status || status.length > 200))) {
    throw new PageWriteError(400, 'invalid', 'statuses must be up to 10 status values');
  }
  const limit = args.limit ?? MAINTENANCE_TASK_LIMIT;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAINTENANCE_TASK_LIMIT) {
    throw new PageWriteError(400, 'invalid', `limit must be between 1 and ${MAINTENANCE_TASK_LIMIT}`);
  }
  const databaseId = liveTaskDatabaseId(context.workspaceId, context.ownerUserId);
  if (!databaseId) throw new PageWriteError(404, 'not_found', 'This workspace has no task database');
  const source = requireMaintenanceSource(context, args.sourceTurnId);
  if (!source.manifest.some((entry) => entry.kind === 'database' && entry.id === databaseId)) {
    throw new PageWriteError(404, 'not_found', 'This run does not include the task database, so there are no tasks to list for this source');
  }
  if (!source.routingComplete) {
    throw new PageWriteError(404, 'not_found', `The task database is not routed for this source turn. Route this source first: call maintenance_route_source once with every resource this source should change, including {kind:"database", id:"${databaseId}"}. Routing is final for the source. Then call maintenance_list_tasks again.`);
  }
  if (!source.candidates.some((entry) => entry.kind === 'database' && entry.id === databaseId)) {
    throw new PageWriteError(404, 'not_found', 'The task database was not routed for this source, and routing is final; this source has no tasks to list');
  }
  reobserveRoutedResource(context, args.sourceTurnId as string, 'database', databaseId);
  const ref = requireMaintenanceResource(context, args.sourceTurnId as string, 'database', databaseId);
  const database = getDatabase(databaseId, context.ownerUserId);
  if (database.workspaceId !== context.workspaceId || database.revision !== ref.revision) throw new PageWriteError(409, 'stale_revision', 'Database changed since routing; read it again from the first page; that read refreshes its revision (a continuation read cannot)');
  const found = listTasks({
    ownerUserId: context.ownerUserId, scope: { kind: 'workspace', workspaceId: context.workspaceId }, now, limit: limit as number,
    ...(nodeId ? { nodeId } : {}), ...(query ? { query } : {}), ...(args.statuses ? { statuses: args.statuses as string[] } : {}),
  });
  // At most 20 tasks of at most 20 conversations each: one state read.
  const linked = [...new Set(found.items.flatMap((item) => item.conversationIds))];
  const here = new Set(threadStates({ ownerUserId: context.ownerUserId, nodeIds: linked, now })
    .filter((card) => card.workspaceId === context.workspaceId).map((card) => card.nodeId));
  const tasks = found.items.map((item) => ({
    id: item.rowId, rev: item.rev, task: item.task, status: item.status, statusSetBy: item.statusSetBy, next: item.next,
    conversationIds: item.conversationIds, waitingConversationIds: item.waitingConversationIds,
    goneConversationIds: item.conversationIds.filter((id) => !here.has(id)), hasNotes: item.hasNotes, updatedAt: item.updatedAt,
  }));
  let result = { databaseId, revision: database.revision, columns: TASK_COLUMN, tasks, more: found.nextCursor !== null };
  while (result.tasks.length && Buffer.byteLength(JSON.stringify(result), 'utf8') > MAINTENANCE_READ_MAX_BYTES) {
    result = { ...result, tasks: result.tasks.slice(0, -1), more: true };
  }
  return result;
}

export function maintenanceToolResult<T>(result: T) { return success(result); }
