import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import { MEMORY_KINDS, type MemoryExtractionScopeHint, type MemoryKind } from 'michi-shared';
import type { MaintenanceExecutionContext } from '../../agents/types';
import { getDb } from '../db';
import { MEMORY_EXTRACTION_TOOL_NAMES, type MemoryExtractionToolName } from './extractionProfile';
import {
  chargeExtractionCall, extractionIdempotencyKey, findSameBodyMemory, getCommittedProposal, getExtractionCandidate, getExtractionRun,
  getExtractionSource, insertExtractionCandidate, markExtractionSourceRead, memoryBodyHash, recordExtractionDecision,
  recordExtractionInvalidCall, stopExtractionRun, tombstoneBlocks, type ExtractionCandidateRecord, type ExtractionRunRecord,
  type ExtractionSourceRecord,
} from './extractionRepository';
import { EXTRACTION_RUN_ID_PREFIX, estimateTokens, MEMORY_EXTRACTION_LIMITS, readExtractionSourceMessages } from './extractionRun';
import { findMemory } from './memoryRepository';
import { getMemorySettings, MemoryError, searchMemories } from './memoryService';

/**
 * The closed tools of an automatic memory extraction session. Every call is
 * bound to the run the scheduler claimed (the context's planId), rechecks
 * that run's authority, and is validated against a strict schema here, so an
 * invalid call is a tool error the model can repair and is counted: after
 * MEMORY_EXTRACTION_LIMITS.maxRepairs repairs the next invalid call fails the
 * run. Proposals are staged; only the settling run commits them as pending
 * memories (extractionRun.ts). Nothing here can write an active memory, run
 * a command or reach outside Michi.
 */

export interface ExtractionToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  details?: unknown;
}

export interface ExtractionToolDefinition {
  name: MemoryExtractionToolName;
  description: string;
  /**
   * What the runtime lists: field names, types and descriptions, nothing it
   * would enforce itself. Required fields, enums and lengths are checked
   * here against `schema`, so a malformed call reaches the host and counts.
   */
  parameters: { type: 'object'; properties: Record<string, unknown>; required: string[] };
  /** The strict schema every call must satisfy. */
  schema: Record<string, unknown>;
  execute(args: unknown): ExtractionToolResult;
}

class InvalidCall extends Error {}
class BudgetReached extends Error {}

const text = (value: unknown) => JSON.stringify(value);
const success = (value: unknown): ExtractionToolResult => ({ content: [{ type: 'text', text: text(value) }], details: value });
const failure = (message: string): ExtractionToolResult => ({ isError: true, content: [{ type: 'text', text: message }] });

const validator = new AjvJsonSchemaValidator();
const strict = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const id = { type: 'string', minLength: 1, maxLength: 200 };
const BODY_MAX = 500;
const REASON_MAX = 500;

/** The listed form of a strict schema: the same fields and types, nothing enforced. */
function listed(schema: { properties: Record<string, Record<string, unknown>> }, describe: Record<string, string>): ExtractionToolDefinition['parameters'] {
  return {
    type: 'object',
    properties: Object.fromEntries(Object.entries(schema.properties).map(([key, field]) =>
      [key, { type: field.type, description: describe[key] }])),
    required: [],
  };
}

/** The run the context is bound to, if it still owns its scheduler run. Not a counted error: the model cannot fix it. */
function authorize(context: MaintenanceExecutionContext, now: number): ExtractionRunRecord {
  if (!context.planId.startsWith(EXTRACTION_RUN_ID_PREFIX)) throw new Error('This session is not bound to an automatic memory run');
  const run = getExtractionRun(context.planId, context.ownerUserId);
  if (!run || run.workspaceId !== context.workspaceId || run.jobId !== context.jobId || run.runId !== context.runId) {
    throw new Error('This automatic memory run no longer owns the tool call; stop');
  }
  const row = getDb().prepare(`SELECT r.status, r.claimed_by, r.attention, l.holder, l.expires_at, x.run_id AS claim, c.job_id AS cursor_job
      FROM scheduled_job_runs r JOIN scheduler_lease l ON l.id = 1
      LEFT JOIN scheduler_execution_claims x ON x.run_id = r.id AND x.holder = l.holder AND x.generation = l.generation
      LEFT JOIN memory_extraction_cursors c ON c.workspace_id = ? AND c.owner_user_id = ?
      WHERE r.id = ? AND r.job_id = ?`).get(run.workspaceId, run.ownerUserId, run.runId, run.jobId) as
    { status: string; claimed_by: string; attention: string | null; holder: string; expires_at: number; claim: string | null; cursor_job: string | null } | undefined;
  if (!row || run.state !== 'active' || row.status !== 'running' || row.attention !== null || !row.claim || row.cursor_job !== run.jobId
    || row.claimed_by !== context.claimedBy || row.holder !== context.claimedBy || row.expires_at <= now) {
    throw new Error('This automatic memory run was stopped or lost its scheduler ownership; stop calling tools');
  }
  if (getMemorySettings(run.ownerUserId).mode !== 'auto') throw new Error('Automatic memory was turned off; stop calling tools');
  return run;
}

function requireSource(run: ExtractionRunRecord, sourceTurnId: string): ExtractionSourceRecord {
  const source = getExtractionSource(run.id, sourceTurnId);
  if (!source) throw new InvalidCall(`sourceTurnId "${sourceTurnId}" is not in this batch; use an id from the source index`);
  return source;
}

function requireRead(source: ExtractionSourceRecord, tool: string): void {
  if (source.readAt === null) throw new InvalidCall(`read source turn "${source.sourceTurnId}" with memory_read_source before ${tool}`);
}

function requireBudget(run: ExtractionRunRecord): void {
  if (run.stoppedReason === 'budget' || run.estimatedTokens >= run.tokenBudget) {
    stopExtractionRun(run.id, 'budget');
    throw new BudgetReached(`This run reached its token budget (about ${run.tokenBudget} tokens). Record receipts only for turns you already read; the rest are retried in a smaller batch.`);
  }
}

function candidateResult(candidate: ExtractionCandidateRecord, replayed: boolean) {
  const staged = candidate.state !== 'dropped';
  return {
    status: staged ? 'staged' : 'dropped',
    receipt: 'proposed',
    ...(staged ? { note: 'Staged: it is saved as a pending memory for the user\'s approval when this run finishes.' }
      : { reason: dropMessage(candidate.dropReason) }),
    ...(replayed ? { replayed: true } : {}),
  };
}

function dropMessage(reason: string | null): string {
  switch (reason) {
    case 'tombstoned': return 'The user removed this memory before; it is not proposed again. This still counts as the turn\'s receipt.';
    case 'already_proposed': return 'This turn already proposed this memory in an earlier run. This still counts as the turn\'s receipt.';
    case 'duplicate': return 'The same memory is already stored. This still counts as the turn\'s receipt.';
    default: return 'Not proposed. This still counts as the turn\'s receipt.';
  }
}

function readSource(run: ExtractionRunRecord, args: { sourceTurnId: string }, now: number) {
  const source = requireSource(run, args.sourceTurnId);
  requireBudget(run);
  const messages = readExtractionSourceMessages(source);
  markExtractionSourceRead(run.id, source.sourceTurnId, now);
  if (!messages) {
    // Deleted or rewritten since the batch was claimed: nothing to extract, and it must not hold the cursor.
    recordExtractionDecision(run.id, source.sourceTurnId, 'no_change', 'source_unavailable', now);
    return { sourceTurnId: source.sourceTurnId, unavailable: true, receipt: 'no_change',
      note: 'This turn can no longer be read; Michi recorded no change for it. Continue with the next source turn.' };
  }
  return {
    sourceTurnId: source.sourceTurnId,
    completedAt: new Date(source.completedAt).toISOString(),
    ...(source.untrusted ? { readUntrustedContent: true, note: 'This turn also read web pages, files or tool output. Only the user\'s own words can become a memory; Michi marks its candidates with the source risk.' } : {}),
    messages,
    receipt: source.decision,
  };
}

function search(run: ExtractionRunRecord, args: { query: string; includePending?: boolean; limit?: number }) {
  requireBudget(run);
  try {
    const found = searchMemories({ ownerUserId: run.ownerUserId }, {
      query: args.query, workspaceId: run.workspaceId, includeUser: true,
      status: args.includePending === false ? ['active'] : ['active', 'pending'], limit: args.limit ?? 10,
    });
    return { memories: found.map((memory) => ({ id: memory.id, scope: memory.scope.kind, kind: memory.kind, status: memory.status, body: memory.body })) };
  } catch (error) {
    if (error instanceof MemoryError && error.code === 'invalid_argument') throw new InvalidCall(error.message);
    throw error;
  }
}

function propose(run: ExtractionRunRecord, args: { sourceTurnId: string; kind: MemoryKind; body: string; scopeHint?: MemoryExtractionScopeHint; supersedesId?: string }, now: number) {
  const source = requireSource(run, args.sourceTurnId);
  requireRead(source, 'memory_propose');
  if (source.decision === 'no_change') throw new InvalidCall('this source turn already has a no-change receipt; a turn gets proposals or one no-change, not both');
  const body = args.body.trim();
  if (!body) throw new InvalidCall('body must not be blank');
  const bodyHash = memoryBodyHash(body);
  const key = extractionIdempotencyKey({ ownerUserId: run.ownerUserId, workspaceId: run.workspaceId, sourceTurnId: source.sourceTurnId, bodyHash });
  const existing = getExtractionCandidate(run.id, key);
  if (existing) return candidateResult(existing, true);
  const count = (getDb().prepare('SELECT COUNT(*) AS n FROM memory_extraction_candidates WHERE run_id = ? AND source_turn_id = ?')
    .get(run.id, source.sourceTurnId) as { n: number }).n;
  if (count >= MEMORY_EXTRACTION_LIMITS.maxCandidatesPerSource) {
    throw new InvalidCall(`a source turn yields at most ${MEMORY_EXTRACTION_LIMITS.maxCandidatesPerSource} candidates`);
  }
  if (args.supersedesId !== undefined) {
    const old = findMemory(run.ownerUserId, args.supersedesId);
    const inScope = old && (old.scope.kind === 'user' || old.scope.workspaceId === run.workspaceId);
    if (!old || !inScope || (old.status !== 'active' && old.status !== 'pending')) {
      throw new InvalidCall('supersedesId must be the id of an active or pending memory that memory_search returned');
    }
  }
  const dropReason = tombstoneBlocks({ ownerUserId: run.ownerUserId, workspaceId: run.workspaceId, sourceTurnId: source.sourceTurnId,
    bodyHash, completedAt: source.completedAt }) ? 'tombstoned'
    : getCommittedProposal(key) ? 'already_proposed'
      : findSameBodyMemory(run.ownerUserId, run.workspaceId, bodyHash) ? 'duplicate' : null;
  insertExtractionCandidate({ runId: run.id, idempotencyKey: key, sourceTurnId: source.sourceTurnId, body, bodyHash, kind: args.kind,
    scopeHint: args.scopeHint ?? 'workspace', supersedesId: args.supersedesId ?? null, sourceRisk: source.untrusted ? 'untrusted' : null,
    state: dropReason ? 'dropped' : 'staged', dropReason, now });
  recordExtractionDecision(run.id, source.sourceTurnId, 'proposed', null, now);
  return candidateResult(getExtractionCandidate(run.id, key)!, false);
}

function noChange(run: ExtractionRunRecord, args: { sourceTurnId: string; reason: string }, now: number) {
  const source = requireSource(run, args.sourceTurnId);
  requireRead(source, 'memory_no_change');
  if (source.decision === 'proposed') throw new InvalidCall('this source turn already has proposals; do not also record no change for it');
  if (source.decision === 'no_change') return { receipt: 'no_change', reason: source.reason, replayed: true };
  const reason = args.reason.trim();
  if (!reason) throw new InvalidCall('reason must not be blank');
  recordExtractionDecision(run.id, source.sourceTurnId, 'no_change', reason, now);
  return { receipt: 'no_change' };
}

const SCHEMAS = {
  memory_read_source: strict({ sourceTurnId: id }, ['sourceTurnId']),
  memory_search: strict({
    query: { type: 'string', minLength: 1, maxLength: 200 },
    includePending: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: 20 },
  }, ['query']),
  memory_propose: strict({
    sourceTurnId: id,
    kind: { type: 'string', enum: [...MEMORY_KINDS] },
    body: { type: 'string', minLength: 1, maxLength: BODY_MAX },
    scopeHint: { type: 'string', enum: ['workspace', 'maybe_global'] },
    supersedesId: id,
  }, ['sourceTurnId', 'kind', 'body']),
  memory_no_change: strict({ sourceTurnId: id, reason: { type: 'string', minLength: 1, maxLength: REASON_MAX } }, ['sourceTurnId', 'reason']),
} as const;

const DEFINITIONS: Array<Omit<ExtractionToolDefinition, 'execute' | 'parameters'> & {
  describe: Record<string, string>;
  run(run: ExtractionRunRecord, args: any, now: number): unknown;
}> = [
  {
    name: 'memory_read_source',
    description: 'Read one source turn of this batch: the user\'s messages (with a correctionHint where a message corrects an earlier statement) and the assistant\'s reply, cut to its start and end. Read every source turn before recording its receipt.',
    schema: SCHEMAS.memory_read_source,
    describe: { sourceTurnId: 'Required. A sourceTurnId from the source index.' },
    run: (run, args, now) => readSource(run, args, now),
  },
  {
    name: 'memory_search',
    description: 'Read-only search of the existing memories of this workspace and of the user\'s global scope, active and pending by default. Search before every proposal: an equivalent memory means no change, a conflicting one means a superseding proposal.',
    schema: SCHEMAS.memory_search,
    describe: {
      query: 'Required. 1-200 characters: key terms in the user\'s language.',
      includePending: 'Optional. false searches active memories only (default true).',
      limit: 'Optional. 1-20 results (default 10).',
    },
    run: (run, args) => search(run, args),
  },
  {
    name: 'memory_propose',
    description: 'Propose one memory from one source turn. It is staged and saved only as a pending candidate in this workspace when the run finishes; the user approves it. Never writes an active memory or the user\'s global scope.',
    schema: SCHEMAS.memory_propose,
    describe: {
      sourceTurnId: 'Required. The source turn this memory comes from.',
      kind: 'Required. One of preference, fact, decision, convention.',
      body: `Required. 1-${BODY_MAX} characters: the memory itself, self-contained, in the user's language.`,
      scopeHint: 'Optional. workspace (default) or maybe_global for a preference that seems to apply to all of the user\'s work.',
      supersedesId: 'Optional. For a correction: the id of the active or pending memory (from memory_search) this one replaces.',
    },
    run: (run, args, now) => propose(run, args, now),
  },
  {
    name: 'memory_no_change',
    description: 'Record that a source turn yields nothing worth saving, with a short specific reason. One call per such turn; a turn with proposals needs none.',
    schema: SCHEMAS.memory_no_change,
    describe: {
      sourceTurnId: 'Required. The source turn.',
      reason: `Required. 1-${REASON_MAX} characters: why nothing is saved (for example "temporary task" or "already stored as <id>").`,
    },
    run: (run, args, now) => noChange(run, args, now),
  },
];

/** Builds the four tools, bound to whatever extraction run the session's current turn carries. */
export function createMemoryExtractionTools(
  contextSource: MaintenanceExecutionContext | (() => MaintenanceExecutionContext | null),
  dependencies: { now?: () => number } = {},
): ExtractionToolDefinition[] {
  const currentTime = dependencies.now ?? Date.now;
  const getContext = typeof contextSource === 'function' ? contextSource : () => contextSource;
  const tools = DEFINITIONS.map(({ describe, run: handler, ...definition }): ExtractionToolDefinition => ({
    ...definition,
    parameters: listed(definition.schema as unknown as { properties: Record<string, Record<string, unknown>> }, describe),
    execute: (raw: unknown) => {
      const context = getContext();
      if (!context) return failure('No automatic memory run owns this tool call');
      const now = currentTime();
      let run: ExtractionRunRecord;
      try { run = authorize(context, now); } catch (error) { return failure(error instanceof Error ? error.message : String(error)); }
      if (run.stoppedReason === 'invalid_limit') {
        return failure(`This automatic memory run already failed after ${run.invalidCalls} invalid tool calls; nothing will be saved. Stop calling tools.`);
      }
      try {
        const validation = validator.getValidator(definition.schema as Record<string, unknown>)(raw);
        if (!validation.valid) throw new InvalidCall(`arguments do not match the schema: ${validation.errorMessage}`);
        const result = handler(run, raw, now);
        chargeExtractionCall(run.id, estimateTokens(text(raw)) + estimateTokens(text(result)));
        return success(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof BudgetReached) return failure(message);
        if (!(error instanceof InvalidCall)) return failure(message);
        const { invalidCalls, stopped } = recordExtractionInvalidCall(run.id, MEMORY_EXTRACTION_LIMITS.maxRepairs);
        if (stopped) {
          return failure(`Invalid ${definition.name} call: ${message}. That was invalid call ${invalidCalls}, past the ${MEMORY_EXTRACTION_LIMITS.maxRepairs} repairs this run allows, so the run failed and nothing will be saved. Stop calling tools.`);
        }
        const left = MEMORY_EXTRACTION_LIMITS.maxRepairs - invalidCalls + 1;
        return failure(`Invalid ${definition.name} call: ${message}. Fix the arguments and call again (${left} repair${left === 1 ? '' : 's'} left in this run).`);
      }
    },
  }));
  if (tools.map((tool) => tool.name).join('|') !== MEMORY_EXTRACTION_TOOL_NAMES.join('|')) {
    throw new Error('Memory extraction tools differ from the approved extraction profile');
  }
  return tools;
}
