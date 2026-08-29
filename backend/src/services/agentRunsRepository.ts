import { createHash, randomUUID } from 'node:crypto';
import {
  AgentRunCompletionMode,
  AgentRunEventType,
  AgentRunStatus,
  parseAgentRunDtoV1,
  parseAgentRunEventV1,
  parseAgentRunWatchDtoV1,
  type AgentAttemptStatus,
  type AgentInteractionKind,
  type AgentInteractionStatus,
  type AgentRunContextManifestV1,
  type AgentRunDtoV1,
  type AgentRunAttemptDtoV1,
  type AgentRunEventV1,
  type AgentRunInteractionDtoV1,
  type AgentRunListQueryV1,
  type AgentRunWatchDtoV1,
  type EffectiveAgentDefinitionV1,
  type ExecutionEnvironmentSnapshotV1,
  type ExpectedResultContractV1,
  type JsonValue,
  type RecoveryEnvelopeV1,
  type ResultBundleV1,
  type RuntimeProfileV1,
  type StructuredRunErrorV1,
  type WatchConditionV1,
} from 'michi-shared';
import { getDb, runInTransaction } from './db';
import { workspaceOwnerMatches } from './agentOwner';
import { assertAgentOwnerWritable } from './agentOwnerDeletionGate';

export interface AgentRunsRepositoryDeps {
  now?: () => number;
  createId?: (kind: 'run' | 'attempt' | 'interaction' | 'watch') => string;
}

export interface CreateAgentRunInput {
  operationId: string;
  ownerUserId: string;
  workspaceId: string;
  definitionId: string | null;
  definitionRevision: number | null;
  effectiveDefinition: EffectiveAgentDefinitionV1;
  invocationMode: 'delegated' | 'manual';
  completionMode: AgentRunCompletionMode;
  parentRunId: string | null;
  parentAttemptId: string | null;
  parentNodeId: string | null;
  parentTurnId: string | null;
  parentMessageId: string | null;
  parentToolCallId: string | null;
  task: string;
  contextManifest: AgentRunContextManifestV1;
  expectedResult: ExpectedResultContractV1 | null;
  executionEnvironment: ExecutionEnvironmentSnapshotV1;
  expiresAt: number | null;
  initialEvent: { type: AgentRunEventType; payload: JsonValue };
}

export interface CreateAttemptInput {
  operationId: string;
  ownerUserId: string;
  runId: string;
  profileIndex: number;
  runtimeProfile: RuntimeProfileV1;
  publicSessionId: string;
  recoveryEnvelope: RecoveryEnvelopeV1 | null;
}

export interface AgentRunProjectionPatch {
  status?: AgentRunStatus;
  waitingReason?: string | null;
  activeAttemptId?: string | null;
  resultBundle?: ResultBundleV1 | null;
  startedAt?: number | null;
  completedAt?: number | null;
  archivedAt?: number | null;
  leaseToken?: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: number | null;
  heartbeatAt?: number | null;
  checkpointAt?: number | null;
  handoffSearchText?: string;
}

type RunRow = Record<string, any>;
type AttemptRow = Record<string, any>;

function requireOwner(ownerUserId: string): void {
  if (!ownerUserId?.trim()) throw new Error('ownerUserId is required');
}

function hash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function normalized(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ').slice(0, 8_000);
}

function terminal(status: AgentRunStatus): boolean {
  return status === AgentRunStatus.Completed || status === AgentRunStatus.Failed || status === AgentRunStatus.Cancelled;
}

export class AgentRunsRepository {
  private readonly now: () => number;
  private readonly createId: (kind: 'run' | 'attempt' | 'interaction' | 'watch') => string;

  constructor(deps: AgentRunsRepositoryDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.createId = deps.createId ?? ((kind) => `${kind}-${randomUUID()}`);
  }

  private assertWorkspaceOwner(ownerUserId: string, workspaceId: string): void {
    const row = getDb().prepare('SELECT owner_user_id FROM workspaces WHERE id = ?').get(workspaceId) as { owner_user_id: string | null } | undefined;
    if (!row || !workspaceOwnerMatches(row.owner_user_id, ownerUserId)) throw new Error('workspace not found');
  }

  private idempotent<T>(workspaceId: string, operationId: string, payload: unknown, fn: () => T): T {
    if (!operationId?.trim()) throw new Error('operationId is required');
    const key = `agent-run:${operationId}`;
    const payloadHash = hash(payload);
    const prior = getDb().prepare('SELECT payload_hash, result_json FROM command_receipts WHERE workspace_id = ? AND operation_id = ?')
      .get(workspaceId, key) as { payload_hash: string; result_json: string } | undefined;
    if (prior) {
      if (prior.payload_hash !== payloadHash) throw new Error(`operation ${operationId} was reused with a different payload`);
      return JSON.parse(prior.result_json) as T;
    }
    const result = fn();
    getDb().prepare('INSERT INTO command_receipts (workspace_id, operation_id, payload_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(workspaceId, key, payloadHash, JSON.stringify(result), this.now());
    return result;
  }

  private rowToRun(row: RunRow): AgentRunDtoV1 {
    const definitionId = row.definition_id as string | null;
    const definitionRevision = row.definition_revision as number | null;
    return parseAgentRunDtoV1({
      version: 1, id: row.id, ownerUserId: row.owner_user_id, workspaceId: row.workspace_id,
      definitionId, definitionRevision, effectiveDefinition: JSON.parse(row.effective_definition),
      invocationMode: row.invocation_mode, completionMode: row.completion_mode,
      parentRunId: row.parent_run_id, parentAttemptId: row.parent_attempt_id ?? null, parentNodeId: row.parent_node_id,
      parentTurnId: row.parent_turn_id, parentMessageId: row.parent_message_id,
      parentToolCallId: row.parent_tool_call_id, task: row.task,
      contextManifest: JSON.parse(row.context_manifest),
      expectedResult: row.expected_result ? JSON.parse(row.expected_result) : null,
      executionEnvironment: JSON.parse(row.execution_environment), status: row.status,
      waitingReason: row.waiting_reason, activeAttemptId: row.active_attempt_id,
      resultBundle: row.result_bundle ? JSON.parse(row.result_bundle) : null,
      latestEventSeq: row.latest_event_seq, createdAt: row.created_at, startedAt: row.started_at,
      completedAt: row.completed_at, archivedAt: row.archived_at, expiresAt: row.expires_at,
    });
  }

  createRun(input: CreateAgentRunInput): AgentRunDtoV1 {
    requireOwner(input.ownerUserId);
    return runInTransaction(() => {
      assertAgentOwnerWritable(input.ownerUserId, this.now());
      this.assertWorkspaceOwner(input.ownerUserId, input.workspaceId);
      return this.idempotent(input.workspaceId, input.operationId, input, () => {
      if ((input.definitionId === null) !== (input.definitionRevision === null)) {
        throw new Error('definitionId and definitionRevision must have matching nullability');
      }
      if (input.definitionId) {
        const definition = getDb().prepare(`SELECT revision FROM agent_definitions
          WHERE id = ? AND owner_user_id = ? AND status = 'enabled'
            AND (workspace_id IS NULL OR workspace_id = ?)`).get(
          input.definitionId, input.ownerUserId, input.workspaceId,
        ) as { revision: number } | undefined;
        if (!definition || definition.revision !== input.definitionRevision) {
          throw new Error('enabled Agent Definition revision not found');
        }
      }
      if ((input.parentRunId === null) !== (input.parentAttemptId === null)) {
        throw new Error('parentRunId and parentAttemptId must have matching nullability');
      }
      if (input.parentRunId && input.parentAttemptId) {
        const parent = getDb().prepare(`SELECT 1 FROM agent_run_attempts a
          JOIN agent_runs r ON r.id = a.run_id
          WHERE r.id = ? AND a.id = ? AND r.owner_user_id = ? AND r.workspace_id = ?`)
          .get(input.parentRunId, input.parentAttemptId, input.ownerUserId, input.workspaceId);
        if (!parent) throw new Error('parent Run not found');
      }
      if (input.parentNodeId) {
        const parentNode = getDb().prepare(`SELECT w.owner_user_id FROM nodes n JOIN workspaces w ON w.id = n.workspace_id
          WHERE n.id = ? AND n.workspace_id = ?`).get(
          input.parentNodeId, input.workspaceId,
        ) as { owner_user_id: string | null } | undefined;
        if (!parentNode || !workspaceOwnerMatches(parentNode.owner_user_id, input.ownerUserId)) throw new Error('parent Node not found');
      }
      const now = this.now();
      const runId = this.createId('run');
      getDb().prepare(`INSERT INTO agent_runs (
        id, owner_user_id, workspace_id, definition_id, definition_revision,
        effective_definition, invocation_mode, completion_mode, parent_run_id, parent_attempt_id, parent_node_id,
        parent_turn_id, parent_message_id, parent_tool_call_id, task, task_search_text,
        agent_name_snapshot, handoff_search_text, context_manifest, expected_result,
        execution_environment, status, waiting_reason, latest_event_seq,
        created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, 'queued', NULL, -1, ?, ?, ?)`).run(
        runId, input.ownerUserId, input.workspaceId, input.definitionId, input.definitionRevision,
        JSON.stringify(input.effectiveDefinition), input.invocationMode, input.completionMode, input.parentRunId,
        input.parentAttemptId, input.parentNodeId, input.parentTurnId, input.parentMessageId, input.parentToolCallId,
        input.task, normalized(input.task), normalized(input.effectiveDefinition.name),
        JSON.stringify(input.contextManifest), input.expectedResult ? JSON.stringify(input.expectedResult) : null,
        JSON.stringify(input.executionEnvironment), now, now, input.expiresAt,
      );
      this.appendEventAndProjectInternal(input.ownerUserId, runId, -1, input.initialEvent, {});
        return this.getRun(input.ownerUserId, runId)!;
      });
    });
  }

  getRun(ownerUserId: string, runId: string): AgentRunDtoV1 | null {
    requireOwner(ownerUserId);
    const row = getDb().prepare('SELECT * FROM agent_runs WHERE id = ? AND owner_user_id = ?')
      .get(runId, ownerUserId) as RunRow | undefined;
    return row ? this.rowToRun(row) : null;
  }

  listAttempts(ownerUserId: string, runId: string): AgentRunAttemptDtoV1[] {
    requireOwner(ownerUserId);
    if (!this.getRun(ownerUserId, runId)) return [];
    const rows = getDb().prepare('SELECT * FROM agent_run_attempts WHERE run_id = ? ORDER BY attempt_index')
      .all(runId) as AttemptRow[];
    return rows.map((row): AgentRunAttemptDtoV1 => ({
      version: 1, id: row.id, runId: row.run_id, attemptIndex: row.attempt_index,
      profileIndex: row.profile_index, runtimeProfile: JSON.parse(row.runtime_profile),
      status: row.status, publicSessionId: row.public_session_id,
      recoveryEnvelope: row.recovery_envelope ? JSON.parse(row.recovery_envelope) : null,
      startedAt: row.started_at, checkpointAt: row.checkpoint_at,
      completedAt: row.completed_at, error: row.error ? JSON.parse(row.error) : null,
    }));
  }

  getLatestAttemptRecovery(ownerUserId: string, runId: string): {
    attemptId: string;
    profileIndex: number;
    recoveryEnvelope: RecoveryEnvelopeV1 | null;
    nativeResumeToken: JsonValue | null;
  } | null {
    requireOwner(ownerUserId);
    const row = getDb().prepare(`SELECT a.id, a.profile_index, a.recovery_envelope, a.native_resume_token
      FROM agent_run_attempts a JOIN agent_runs r ON r.id = a.run_id
      WHERE a.run_id = ? AND r.owner_user_id = ?
      ORDER BY a.attempt_index DESC LIMIT 1`).get(runId, ownerUserId) as {
        id: string;
        profile_index: number;
        recovery_envelope: string | null;
        native_resume_token: string | null;
      } | undefined;
    if (!row) return null;
    return {
      attemptId: row.id,
      profileIndex: row.profile_index,
      recoveryEnvelope: row.recovery_envelope ? JSON.parse(row.recovery_envelope) : null,
      nativeResumeToken: row.native_resume_token ? JSON.parse(row.native_resume_token) : null,
    };
  }

  listEvents(ownerUserId: string, runId: string, afterSeq = -1, limit = 500): AgentRunEventV1[] {
    requireOwner(ownerUserId);
    if (!this.getRun(ownerUserId, runId)) return [];
    const rows = getDb().prepare(`SELECT * FROM agent_run_events WHERE run_id = ? AND seq > ?
      ORDER BY seq LIMIT ?`).all(runId, afterSeq, Math.max(1, Math.min(limit, 1000))) as Array<Record<string, any>>;
    return rows.map((row) => parseAgentRunEventV1({
      version: 1, runId: row.run_id, seq: row.seq, attemptId: row.attempt_id,
      type: row.type, payload: JSON.parse(row.payload), createdAt: row.created_at,
    }));
  }

  getInteraction(ownerUserId: string, interactionId: string): AgentRunInteractionDtoV1 | null {
    requireOwner(ownerUserId);
    const row = getDb().prepare(`SELECT i.* FROM agent_run_interactions i
      JOIN agent_runs r ON r.id = i.run_id WHERE i.id = ? AND r.owner_user_id = ?`)
      .get(interactionId, ownerUserId) as Record<string, any> | undefined;
    if (!row) return null;
    return {
      version: 1, id: row.id, runId: row.run_id, attemptId: row.attempt_id,
      kind: row.type, status: row.status, request: JSON.parse(row.request_payload).value,
      response: row.response_payload ? JSON.parse(row.response_payload).value : null,
      createdAt: row.created_at, resolvedAt: row.resolved_at,
    };
  }

  listInteractions(ownerUserId: string, runId: string): AgentRunInteractionDtoV1[] {
    requireOwner(ownerUserId);
    if (!this.getRun(ownerUserId, runId)) return [];
    const rows = getDb().prepare('SELECT id FROM agent_run_interactions WHERE run_id = ? ORDER BY created_at, id')
      .all(runId) as Array<{ id: string }>;
    return rows.map((row) => this.getInteraction(ownerUserId, row.id)).filter((value): value is AgentRunInteractionDtoV1 => value !== null);
  }

  getWatch(ownerUserId: string, watchId: string): AgentRunWatchDtoV1 | null {
    requireOwner(ownerUserId);
    const row = getDb().prepare('SELECT * FROM agent_run_watches WHERE id = ? AND owner_user_id = ?')
      .get(watchId, ownerUserId) as Record<string, any> | undefined;
    if (!row || !['active', 'fired', 'cancelled'].includes(row.status)) return null;
    const runIds = (getDb().prepare('SELECT run_id FROM agent_run_watch_members WHERE watch_id = ? ORDER BY added_at, run_id')
      .all(watchId) as Array<{ run_id: string }>).map((member) => member.run_id);
    return parseAgentRunWatchDtoV1({
      version: 1, id: row.id, ownerUserId: row.owner_user_id, workspaceId: row.workspace_id,
      runIds, condition: JSON.parse(row.condition), completionMode: row.completion_behavior,
      status: row.status, deliveryId: row.delivery_id, requestedTurnId: row.requested_turn_id,
      parentRunId: row.parent_run_id, parentNodeId: row.parent_node_id,
      parentTurnId: row.parent_turn_id, createdAt: row.created_at, firedAt: row.fired_at,
    });
  }

  listActiveWatchesForRecovery(afterId: string | null = null, limit = 100): AgentRunWatchDtoV1[] {
    return this.listWatchesForRecovery('active', afterId, limit);
  }

  listFiredWatchesPendingDelivery(afterId: string | null = null, limit = 100): AgentRunWatchDtoV1[] {
    return this.listWatchesForRecovery('fired_pending', afterId, limit);
  }

  private listWatchesForRecovery(kind: 'active' | 'fired_pending', afterId: string | null,
    limit: number): AgentRunWatchDtoV1[] {
    const clauses = [kind === 'active' ? "status = 'active'" : "status = 'fired' AND delivery_status = 'pending'"];
    const params: Array<string | number> = [];
    if (afterId) { clauses.push('id > ?'); params.push(afterId); }
    params.push(Math.max(1, Math.min(limit, 100)));
    const rows = getDb().prepare(`SELECT id, owner_user_id FROM agent_run_watches
      WHERE ${clauses.join(' AND ')} ORDER BY id LIMIT ?`).all(...params) as Array<{ id: string; owner_user_id: string }>;
    return rows.map((row) => this.getWatch(row.owner_user_id, row.id))
      .filter((watch): watch is AgentRunWatchDtoV1 => watch !== null);
  }

  listRuns(ownerUserId: string, query: AgentRunListQueryV1): AgentRunDtoV1[] {
    requireOwner(ownerUserId);
    this.assertWorkspaceOwner(ownerUserId, query.workspaceId);
    const clauses = ['owner_user_id = ?', 'workspace_id = ?'];
    const params: any[] = [ownerUserId, query.workspaceId];
    if (query.statuses?.length) {
      clauses.push(`status IN (${query.statuses.map(() => '?').join(',')})`);
      params.push(...query.statuses);
    }
    if (!query.includeArchived) clauses.push('archived_at IS NULL');
    if (query.q?.trim()) {
      const q = `%${normalized(query.q)}%`;
      clauses.push('(task_search_text LIKE ? OR agent_name_snapshot LIKE ? OR handoff_search_text LIKE ?)');
      params.push(q, q, q);
    }
    if (query.cursor) { clauses.push('id > ?'); params.push(query.cursor); }
    const limit = Math.max(1, Math.min(query.limit ?? 50, 100));
    params.push(limit);
    const rows = getDb().prepare(`SELECT * FROM agent_runs WHERE ${clauses.join(' AND ')} ORDER BY id LIMIT ?`)
      .all(...params) as RunRow[];
    return rows.map((row) => this.rowToRun(row));
  }

  listTtlCandidates(ownerUserId: string, workspaceId: string, now: number, limit = 100): AgentRunDtoV1[] {
    requireOwner(ownerUserId);
    this.assertWorkspaceOwner(ownerUserId, workspaceId);
    const rows = getDb().prepare(`SELECT * FROM agent_runs WHERE owner_user_id = ? AND workspace_id = ?
      AND expires_at IS NOT NULL AND expires_at <= ? AND status IN ('completed','failed','cancelled')
      ORDER BY expires_at, id LIMIT ?`).all(ownerUserId, workspaceId, now, Math.max(1, Math.min(limit, 100))) as RunRow[];
    return rows.map((row) => this.rowToRun(row));
  }

  archiveRun(ownerUserId: string, runId: string, archivedAt = this.now()): boolean {
    requireOwner(ownerUserId);
    return Number(getDb().prepare(`UPDATE agent_runs SET archived_at = ?, updated_at = ?
      WHERE id = ? AND owner_user_id = ? AND status IN ('completed','failed','cancelled')`)
      .run(archivedAt, this.now(), runId, ownerUserId).changes) === 1;
  }

  deleteRun(ownerUserId: string, runId: string): boolean {
    requireOwner(ownerUserId);
    return runInTransaction(() => {
      const row = getDb().prepare('SELECT workspace_id FROM agent_runs WHERE id = ? AND owner_user_id = ?')
        .get(runId, ownerUserId) as { workspace_id: string } | undefined;
      if (!row) return false;
      const deleted = getDb().prepare('DELETE FROM agent_runs WHERE id = ? AND owner_user_id = ?').run(runId, ownerUserId);
      return Number(deleted.changes) === 1;
    });
  }

  claimRun(ownerUserId: string, runId: string, leaseOwner: string, leaseToken: string,
    leaseExpiresAt: number, expectedLatestSeq: number): AgentRunEventV1 | null {
    requireOwner(ownerUserId);
    const now = this.now();
    return runInTransaction(() => {
      assertAgentOwnerWritable(ownerUserId, now);
      const current = getDb().prepare(`SELECT status FROM agent_runs WHERE id = ? AND owner_user_id = ?
        AND status IN ('queued','recovering') AND latest_event_seq = ?
        AND (lease_token IS NULL OR lease_expires_at <= ?)`).get(
        runId, ownerUserId, expectedLatestSeq, now,
      ) as { status: AgentRunStatus.Queued | AgentRunStatus.Recovering } | undefined;
      if (!current) return null;
      const claimed = getDb().prepare(`UPDATE agent_runs SET
      lease_owner = ?, lease_token = ?, lease_expires_at = ?,
      heartbeat_at = ?, updated_at = ?
      WHERE id = ? AND owner_user_id = ? AND status IN ('queued','recovering')
        AND latest_event_seq = ? AND (lease_token IS NULL OR lease_expires_at <= ?)`).run(
      leaseOwner, leaseToken, leaseExpiresAt, now, now, runId, ownerUserId, expectedLatestSeq, now,
      );
      if (Number(claimed.changes) !== 1) return null;
      return this.appendEventAndProjectInternal(ownerUserId, runId, expectedLatestSeq, {
        type: 'run_status_changed' as AgentRunEventType,
        payload: { version: 1, from: current.status, to: AgentRunStatus.Preparing },
      }, { status: AgentRunStatus.Preparing });
    });
  }

  heartbeat(ownerUserId: string, runId: string, leaseToken: string, leaseExpiresAt: number): boolean {
    requireOwner(ownerUserId);
    const now = this.now();
    return Number(getDb().prepare(`UPDATE agent_runs SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
      WHERE id = ? AND owner_user_id = ? AND lease_token = ? AND status IN ('preparing','running','recovering')`)
      .run(leaseExpiresAt, now, now, runId, ownerUserId, leaseToken).changes) === 1;
  }

  createAttempt(input: CreateAttemptInput): { id: string; attemptIndex: number } {
    requireOwner(input.ownerUserId);
    const run = this.getRun(input.ownerUserId, input.runId);
    if (!run) throw new Error('run not found');
    return runInTransaction(() => this.idempotent(run.workspaceId, input.operationId, input, () => {
      const raw = getDb().prepare('SELECT next_attempt_index FROM agent_runs WHERE id = ? AND owner_user_id = ?')
        .get(input.runId, input.ownerUserId) as { next_attempt_index: number } | undefined;
      if (!raw) throw new Error('run not found');
      const id = this.createId('attempt');
      getDb().prepare(`INSERT INTO agent_run_attempts (
        id, run_id, attempt_index, profile_index, runtime_profile, status,
        public_session_id, recovery_envelope, started_at
      ) VALUES (?, ?, ?, ?, ?, 'preparing', ?, ?, ?)`).run(
        id, input.runId, raw.next_attempt_index, input.profileIndex,
        JSON.stringify(input.runtimeProfile), input.publicSessionId,
        input.recoveryEnvelope ? JSON.stringify(input.recoveryEnvelope) : null, this.now(),
      );
      getDb().prepare('UPDATE agent_runs SET active_attempt_id = ?, next_attempt_index = next_attempt_index + 1, updated_at = ? WHERE id = ? AND owner_user_id = ?')
        .run(id, this.now(), input.runId, input.ownerUserId);
      return { id, attemptIndex: raw.next_attempt_index };
    }));
  }

  checkpointAttempt(ownerUserId: string, runId: string, attemptId: string, leaseToken: string, nativeResumeToken: JsonValue | null): boolean {
    requireOwner(ownerUserId);
    const now = this.now();
    return runInTransaction(() => {
      const owned = getDb().prepare('SELECT 1 FROM agent_runs WHERE id = ? AND owner_user_id = ? AND active_attempt_id = ? AND lease_token = ?')
        .get(runId, ownerUserId, attemptId, leaseToken);
      if (!owned) return false;
      const attempt = getDb().prepare('UPDATE agent_run_attempts SET checkpoint_at = ?, native_resume_token = ? WHERE id = ? AND run_id = ?')
        .run(now, nativeResumeToken === null ? null : JSON.stringify(nativeResumeToken), attemptId, runId);
      if (Number(attempt.changes) !== 1) return false;
      getDb().prepare('UPDATE agent_runs SET checkpoint_at = ?, heartbeat_at = ?, updated_at = ? WHERE id = ?')
        .run(now, now, now, runId);
      return true;
    });
  }

  appendEventAndProject(ownerUserId: string, runId: string, expectedLatestSeq: number,
    event: { type: AgentRunEventType; payload: JsonValue; attemptId?: string | null }, patch: AgentRunProjectionPatch = {}): AgentRunEventV1 {
    requireOwner(ownerUserId);
    return runInTransaction(() => this.appendEventAndProjectInternal(ownerUserId, runId, expectedLatestSeq, event, patch));
  }

  private appendEventAndProjectInternal(ownerUserId: string, runId: string, expectedLatestSeq: number,
    event: { type: AgentRunEventType; payload: JsonValue; attemptId?: string | null }, patch: AgentRunProjectionPatch): AgentRunEventV1 {
    const row = getDb().prepare('SELECT latest_event_seq, status FROM agent_runs WHERE id = ? AND owner_user_id = ?')
      .get(runId, ownerUserId) as { latest_event_seq: number; status: AgentRunStatus } | undefined;
    if (!row) throw new Error('run not found');
    if (row.latest_event_seq !== expectedLatestSeq) throw new Error('event sequence conflict');
    const seq = expectedLatestSeq + 1;
    const createdAt = this.now();
    const persisted = parseAgentRunEventV1({
      version: 1, runId, seq, attemptId: event.attemptId ?? null,
      type: event.type, payload: event.payload, createdAt,
    });
    getDb().prepare('INSERT INTO agent_run_events (run_id, seq, attempt_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(runId, seq, persisted.attemptId, persisted.type, JSON.stringify(persisted.payload), createdAt);

    const sets = ['latest_event_seq = ?', 'updated_at = ?'];
    const values: any[] = [seq, createdAt];
    const columns: Record<keyof AgentRunProjectionPatch, string> = {
      status: 'status', waitingReason: 'waiting_reason', activeAttemptId: 'active_attempt_id',
      resultBundle: 'result_bundle', startedAt: 'started_at', completedAt: 'completed_at',
      archivedAt: 'archived_at', leaseToken: 'lease_token', leaseOwner: 'lease_owner',
      leaseExpiresAt: 'lease_expires_at', heartbeatAt: 'heartbeat_at', checkpointAt: 'checkpoint_at',
      handoffSearchText: 'handoff_search_text',
    };
    for (const [key, column] of Object.entries(columns) as Array<[keyof AgentRunProjectionPatch, string]>) {
      if (!(key in patch)) continue;
      sets.push(`${column} = ?`);
      const value = patch[key];
      values.push(key === 'resultBundle' && value != null ? JSON.stringify(value)
        : key === 'handoffSearchText' && typeof value === 'string' ? normalized(value) : value ?? null);
    }
    values.push(runId, ownerUserId, expectedLatestSeq);
    const result = getDb().prepare(`UPDATE agent_runs SET ${sets.join(', ')} WHERE id = ? AND owner_user_id = ? AND latest_event_seq = ?`)
      .run(...values);
    if (Number(result.changes) !== 1) throw new Error('event sequence conflict');
    return persisted;
  }

  finalizeAttempt(ownerUserId: string, runId: string, attemptId: string, leaseToken: string,
    attemptStatus: Extract<AgentAttemptStatus, 'completed' | 'failed' | 'cancelled'>,
    runStatus: Extract<AgentRunStatus, AgentRunStatus.Completed | AgentRunStatus.Failed | AgentRunStatus.Cancelled>,
    resultBundle: ResultBundleV1 | null, error: StructuredRunErrorV1 | null,
    expectedLatestSeq: number, event: { type: AgentRunEventType; payload: JsonValue }): AgentRunDtoV1 {
    requireOwner(ownerUserId);
    return runInTransaction(() => {
      const run = getDb().prepare('SELECT lease_token FROM agent_runs WHERE id = ? AND owner_user_id = ? AND active_attempt_id = ?')
        .get(runId, ownerUserId, attemptId) as { lease_token: string | null } | undefined;
      if (!run || run.lease_token !== leaseToken) throw new Error('run lease lost');
      const now = this.now();
      const attempt = getDb().prepare(`UPDATE agent_run_attempts SET status = ?, completed_at = ?, error = ?
        WHERE id = ? AND run_id = ? AND status NOT IN ('completed','failed','cancelled')`).run(
        attemptStatus, now, error ? JSON.stringify(error) : null, attemptId, runId,
      );
      if (Number(attempt.changes) !== 1) throw new Error('attempt is already terminal');
      this.appendEventAndProjectInternal(ownerUserId, runId, expectedLatestSeq,
        { ...event, attemptId }, {
          status: runStatus, waitingReason: null, resultBundle, completedAt: now,
          leaseToken: null, leaseOwner: null, leaseExpiresAt: null,
          handoffSearchText: resultBundle ? `${resultBundle.handoff.conclusion} ${resultBundle.handoff.artifactsOrChanges} ${resultBundle.handoff.unresolvedIssues}` : '',
        });
      return this.getRun(ownerUserId, runId)!;
    });
  }

  finishAttemptForRecovery(ownerUserId: string, runId: string, attemptId: string,
    leaseToken: string, error: StructuredRunErrorV1, expectedLatestSeq: number,
    recoveryEnvelope: RecoveryEnvelopeV1 | null = null): AgentRunEventV1 {
    requireOwner(ownerUserId);
    return runInTransaction(() => {
      const run = getDb().prepare(`SELECT lease_token FROM agent_runs
        WHERE id = ? AND owner_user_id = ? AND active_attempt_id = ?`)
        .get(runId, ownerUserId, attemptId) as { lease_token: string | null } | undefined;
      if (!run || run.lease_token !== leaseToken) throw new Error('run lease lost');
      const now = this.now();
      const attempt = getDb().prepare(`UPDATE agent_run_attempts SET
        status = 'failed', completed_at = ?, error = ?,
        recovery_envelope = COALESCE(?, recovery_envelope)
        WHERE id = ? AND run_id = ? AND status NOT IN ('completed','failed','cancelled')`)
        .run(now, JSON.stringify(error), recoveryEnvelope ? JSON.stringify(recoveryEnvelope) : null, attemptId, runId);
      if (Number(attempt.changes) !== 1) throw new Error('attempt is already terminal');
      return this.appendEventAndProjectInternal(ownerUserId, runId, expectedLatestSeq, {
        type: 'recovery_started' as AgentRunEventType,
        attemptId,
        payload: { version: 1, attemptId, error: JSON.parse(JSON.stringify(error)) as JsonValue },
      }, {
        status: AgentRunStatus.Recovering,
        waitingReason: null,
        leaseToken: null,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
    });
  }

  releaseLease(ownerUserId: string, runId: string, leaseToken: string): boolean {
    requireOwner(ownerUserId);
    return Number(getDb().prepare(`UPDATE agent_runs SET
      lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND owner_user_id = ? AND lease_token = ?`)
      .run(this.now(), runId, ownerUserId, leaseToken).changes) === 1;
  }

  administrativelyCancelRun(ownerUserId: string, runId: string,
    leaseToken: string | null, reason: string): AgentRunEventV1 | null {
    requireOwner(ownerUserId);
    const now = this.now();
    return runInTransaction(() => {
      const run = getDb().prepare(`SELECT status, active_attempt_id, lease_token, lease_expires_at,
        latest_event_seq FROM agent_runs WHERE id = ? AND owner_user_id = ?`).get(
        runId, ownerUserId,
      ) as {
        status: AgentRunStatus;
        active_attempt_id: string | null;
        lease_token: string | null;
        lease_expires_at: number | null;
        latest_event_seq: number;
      } | undefined;
      if (!run) return null;
      if (terminal(run.status)) {
        if (run.lease_token !== null) throw new Error('terminal Run still has a live lease');
        return null;
      }
      if (leaseToken !== null) {
        if (run.lease_token !== leaseToken) throw new Error('run lease lost');
      } else if (run.lease_token !== null && (run.lease_expires_at ?? Number.POSITIVE_INFINITY) > now) {
        throw new Error('Run is leased by another live instance');
      }

      const error: StructuredRunErrorV1 = {
        version: 1,
        code: 'administrative_delete',
        category: 'terminal',
        message: reason,
        retryable: false,
      };
      if (run.active_attempt_id) {
        getDb().prepare(`UPDATE agent_run_attempts SET status = 'cancelled', completed_at = ?, error = ?
          WHERE id = ? AND run_id = ? AND status NOT IN ('completed','failed','cancelled')`).run(
          now, JSON.stringify(error), run.active_attempt_id, runId,
        );
      }
      getDb().prepare(`UPDATE agent_run_interactions SET
        status = 'cancelled', response_payload = ?, resolved_at = ?
        WHERE run_id = ? AND status = 'pending'`).run(
        JSON.stringify({ version: 1, value: { version: 1, reason } }), now, runId,
      );
      return this.appendEventAndProjectInternal(ownerUserId, runId, run.latest_event_seq, {
        type: AgentRunEventType.RunStatusChanged,
        attemptId: run.active_attempt_id,
        payload: {
          version: 1,
          from: run.status,
          to: AgentRunStatus.Cancelled,
          reason: 'administrative_delete',
        },
      }, {
        status: AgentRunStatus.Cancelled,
        waitingReason: null,
        completedAt: now,
        leaseToken: null,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
    });
  }

  createInteraction(ownerUserId: string, runId: string, attemptId: string | null,
    kind: AgentInteractionKind, request: JsonValue, operationId: string): AgentRunInteractionDtoV1 {
    requireOwner(ownerUserId);
    const run = this.getRun(ownerUserId, runId);
    if (!run) throw new Error('run not found');
    return runInTransaction(() => this.idempotent(run.workspaceId, operationId,
      { runId, attemptId, kind, request }, () => {
        const dto: AgentRunInteractionDtoV1 = {
          version: 1, id: this.createId('interaction'), runId, attemptId, kind,
          status: 'pending', request, response: null, createdAt: this.now(), resolvedAt: null,
        };
        getDb().prepare(`INSERT INTO agent_run_interactions
          (id, run_id, attempt_id, type, status, request_payload, response_payload, created_at, resolved_at)
          VALUES (?, ?, ?, ?, 'pending', ?, NULL, ?, NULL)`).run(
          dto.id, runId, attemptId, kind, JSON.stringify({ version: 1, value: request }), dto.createdAt,
        );
        return dto;
      }));
  }

  resolveInteraction(ownerUserId: string, interactionId: string, status: Exclude<AgentInteractionStatus, 'pending'>,
    response: JsonValue, operationId: string): AgentRunInteractionDtoV1 | null {
    requireOwner(ownerUserId);
    const row = getDb().prepare(`SELECT i.*, r.workspace_id FROM agent_run_interactions i
      JOIN agent_runs r ON r.id = i.run_id WHERE i.id = ? AND r.owner_user_id = ?`)
      .get(interactionId, ownerUserId) as Record<string, any> | undefined;
    if (!row) return null;
    return runInTransaction(() => this.idempotent(row.workspace_id, operationId,
      { interactionId, status, response }, () => {
        const now = this.now();
        const result = getDb().prepare(`UPDATE agent_run_interactions SET status = ?, response_payload = ?, resolved_at = ?
          WHERE id = ? AND run_id IN (SELECT id FROM agent_runs WHERE owner_user_id = ?) AND status = 'pending'`)
          .run(status, JSON.stringify({ version: 1, value: response }), now, interactionId, ownerUserId);
        if (Number(result.changes) !== 1) throw new Error('interaction is already resolved');
        return { version: 1, id: interactionId, runId: row.run_id, attemptId: row.attempt_id,
          kind: row.type, status, request: JSON.parse(row.request_payload).value,
          response, createdAt: row.created_at, resolvedAt: now } as AgentRunInteractionDtoV1;
      }));
  }

  createWatch(ownerUserId: string, workspaceId: string, runIds: readonly string[], condition: WatchConditionV1,
    completionMode: 'notify' | 'wake', parent: { parentRunId: string | null; parentNodeId: string | null; parentTurnId: string | null },
    operationId: string): AgentRunWatchDtoV1 {
    requireOwner(ownerUserId);
    return runInTransaction(() => this.idempotent(workspaceId, operationId,
      { runIds, condition, completionMode, parent }, () => {
        this.assertWorkspaceOwner(ownerUserId, workspaceId);
        const uniqueRunIds = [...new Set(runIds)];
        if (!uniqueRunIds.length) throw new Error('watch requires at least one Run');
        const placeholders = uniqueRunIds.map(() => '?').join(',');
        const count = (getDb().prepare(`SELECT COUNT(*) AS count FROM agent_runs WHERE owner_user_id = ? AND workspace_id = ? AND id IN (${placeholders})`)
          .get(ownerUserId, workspaceId, ...uniqueRunIds) as { count: number }).count;
        if (count !== uniqueRunIds.length) throw new Error('watch Run not found');
        const id = this.createId('watch');
        const deliveryId = `delivery-${id}`;
        const requestedTurnId = `agent-watch-${id}`;
        const now = this.now();
        getDb().prepare(`INSERT INTO agent_run_watches (
          id, owner_user_id, workspace_id, parent_run_id, parent_node_id, parent_turn_id,
          condition, completion_behavior, status, delivery_id, requested_turn_id,
          delivery_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 'pending', ?, ?)`).run(
          id, ownerUserId, workspaceId, parent.parentRunId, parent.parentNodeId,
          parent.parentTurnId, JSON.stringify(condition), completionMode,
          deliveryId, requestedTurnId, now, now,
        );
        const insert = getDb().prepare('INSERT INTO agent_run_watch_members (watch_id, run_id, added_at) VALUES (?, ?, ?)');
        for (const runId of uniqueRunIds) insert.run(id, runId, now);
        return parseAgentRunWatchDtoV1({ version: 1, id, ownerUserId, workspaceId,
          runIds: uniqueRunIds, condition, completionMode, status: 'active', deliveryId,
          requestedTurnId, ...parent, createdAt: now, firedAt: null });
      }));
  }

  addWatchMembers(ownerUserId: string, watchId: string, runIds: readonly string[]): number {
    requireOwner(ownerUserId);
    return runInTransaction(() => {
      const watch = getDb().prepare('SELECT workspace_id FROM agent_run_watches WHERE id = ? AND owner_user_id = ? AND status = \'active\'')
        .get(watchId, ownerUserId) as { workspace_id: string } | undefined;
      if (!watch) throw new Error('active watch not found');
      const insert = getDb().prepare('INSERT OR IGNORE INTO agent_run_watch_members (watch_id, run_id, added_at) SELECT ?, id, ? FROM agent_runs WHERE id = ? AND owner_user_id = ? AND workspace_id = ?');
      let added = 0;
      for (const runId of new Set(runIds)) added += Number(insert.run(watchId, this.now(), runId, ownerUserId, watch.workspace_id).changes);
      return added;
    });
  }

  updateWatchCondition(ownerUserId: string, watchId: string, condition: WatchConditionV1): boolean {
    requireOwner(ownerUserId);
    return Number(getDb().prepare(`UPDATE agent_run_watches SET condition = ?, updated_at = ?
      WHERE id = ? AND owner_user_id = ? AND status = 'active'`).run(
      JSON.stringify(condition), this.now(), watchId, ownerUserId,
    ).changes) === 1;
  }

  updateWatch(ownerUserId: string, watchId: string, addRunIds: readonly string[], condition?: WatchConditionV1): AgentRunWatchDtoV1 | null {
    requireOwner(ownerUserId);
    return runInTransaction(() => {
      const watch = getDb().prepare(`SELECT workspace_id FROM agent_run_watches
        WHERE id = ? AND owner_user_id = ? AND status = 'active'`).get(
        watchId, ownerUserId,
      ) as { workspace_id: string } | undefined;
      if (!watch) return null;
      const unique = [...new Set(addRunIds)];
      for (const runId of unique) {
        const run = getDb().prepare('SELECT workspace_id FROM agent_runs WHERE id = ? AND owner_user_id = ?')
          .get(runId, ownerUserId) as { workspace_id: string } | undefined;
        if (!run || run.workspace_id !== watch.workspace_id) throw new Error('watch Run not found');
      }
      const existingCount = (getDb().prepare('SELECT COUNT(*) AS count FROM agent_run_watch_members WHERE watch_id = ?')
        .get(watchId) as { count: number }).count;
      const existingIds = new Set((getDb().prepare('SELECT run_id FROM agent_run_watch_members WHERE watch_id = ?')
        .all(watchId) as Array<{ run_id: string }>).map((row) => row.run_id));
      const newCount = unique.filter((runId) => !existingIds.has(runId)).length;
      if (condition?.kind === 'quorum' && condition.count > existingCount + newCount) throw new Error('watch quorum exceeds member count');
      const now = this.now();
      const insert = getDb().prepare('INSERT OR IGNORE INTO agent_run_watch_members (watch_id, run_id, added_at) VALUES (?, ?, ?)');
      for (const runId of unique) insert.run(watchId, runId, now);
      if (condition) getDb().prepare('UPDATE agent_run_watches SET condition = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(condition), now, watchId);
      return this.getWatch(ownerUserId, watchId);
    });
  }

  fireWatch(ownerUserId: string, watchId: string): boolean {
    requireOwner(ownerUserId);
    const now = this.now();
    return Number(getDb().prepare(`UPDATE agent_run_watches SET status = 'fired', fired_at = ?, updated_at = ?
      WHERE id = ? AND owner_user_id = ? AND status = 'active'`).run(now, now, watchId, ownerUserId).changes) === 1;
  }

  markWatchDelivery(ownerUserId: string, watchId: string,
    status: 'pending' | 'delivered' | 'undeliverable'): boolean {
    requireOwner(ownerUserId);
    const now = this.now();
    return Number(getDb().prepare(`UPDATE agent_run_watches SET delivery_status = ?, delivered_at = ?, updated_at = ?
      WHERE id = ? AND owner_user_id = ? AND status = 'fired'`).run(
      status, status === 'delivered' || status === 'undeliverable' ? now : null,
      now, watchId, ownerUserId,
    ).changes) === 1;
  }
}
