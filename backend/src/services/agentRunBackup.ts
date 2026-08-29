import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  AgentRunEventType,
  AgentRunStatus,
  parseAgentDefinitionDtoV1,
  parseAgentRunAttemptDtoV1,
  parseAgentRunBackupFragmentV2,
  parseAgentRunEventV1,
  parseAgentRunInteractionDtoV1,
  parseAgentRunWatchDtoV1,
  type AgentDefinitionDtoV1,
  type AgentRunBackupFragmentV2,
  type AgentRunDtoV1,
  type AgentRunWatchDtoV1,
  type EffectiveAgentDefinitionV1,
  type JsonValue,
  type ParentDeliveryDtoV1,
  type PortableContextEntryV1,
  type StructuredRunErrorV1,
} from 'michi-shared';
import { getDb, runInTransaction } from './db';
import { AgentDefinitionsRepository } from './agentDefinitionsRepository';
import { AgentRunsRepository } from './agentRunsRepository';

const SECRET_KEY = /(?:^|_)(?:token|auth|api_key|access_token|refresh_token|bearer_token|session_token|auth_token|authorization|password|secret|provider_key|native_resume_token|credential|credentials|private_key)(?:$|_)/i;
function normalizedKey(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`).replace(/[-\s]+/g, '_');
}

function isHostAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)
    || /^file:(?:\/\/)?[\\/]/i.test(value);
}

function portableText(value: string): string {
  return isHostAbsolutePath(value) ? 'not-exported' : value;
}

export function portableBackupRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  if (!isHostAbsolutePath(value) && !normalized.split('/').includes('..')) return normalized;
  const label = path.posix.basename(normalized);
  return label && label !== '.' && label !== '..' ? label : 'not-exported';
}

function portableJson(value: unknown, key = ''): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    const normalized = normalizedKey(key);
    if (typeof value === 'string' && isHostAbsolutePath(value)) {
      if (normalized === 'cwd') return null;
      if (normalized.endsWith('_files') || normalized.endsWith('_paths') || normalized === 'workspace_path') {
        return portableBackupRelativePath(value);
      }
      return 'not-exported';
    }
    return value as JsonValue;
  }
  if (Array.isArray(value)) return value.map((entry) => portableJson(entry, key));
  if (!value || typeof value !== 'object') return String(value);
  const out: Record<string, JsonValue> = {};
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizedKey(childKey);
    if (SECRET_KEY.test(normalized) || childKey === 'snapshotPath' || childKey === 'startupBinding') continue;
    if (childKey === 'cwd') { out[childKey] = null; continue; }
    out[childKey] = portableJson(child, childKey);
  }
  return out;
}

export function sanitizePortableBackupJson(value: unknown): JsonValue {
  return portableJson(value);
}

function assertPortableJson(value: unknown, location: string): void {
  if (typeof value === 'string') {
    if (isHostAbsolutePath(value)) throw new Error(`${location} contains a source-machine absolute path`);
    return;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPortableJson(entry, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') throw new Error(`${location} is not portable JSON`);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizedKey(key);
    const allowedEmptyBindings = key === 'credentialBindingIds' && Array.isArray(child) && child.length === 0;
    if (!allowedEmptyBindings && SECRET_KEY.test(normalized)) {
      throw new Error(`${location}.${key} contains secret-bearing data`);
    }
    if (key === 'snapshotPath' || key === 'startupBinding') {
      throw new Error(`${location}.${key} contains non-portable Run state`);
    }
    assertPortableJson(child, `${location}.${key}`);
  }
}

export function assertPortableAgentRunBackup(fragment: AgentRunBackupFragmentV2): void {
  assertPortableJson(fragment, 'agents');
  for (const [runIndex, run] of fragment.runs.entries()) {
    for (const [entryIndex, entry] of run.contextManifest.entries.entries()) {
      if (entry.kind === 'file' && portableBackupRelativePath(entry.workspacePath) !== entry.workspacePath) {
        throw new Error(`agents.runs[${runIndex}].contextManifest.entries[${entryIndex}].workspacePath is not portable`);
      }
    }
  }
}

function portableEffectiveDefinition(definition: EffectiveAgentDefinitionV1): EffectiveAgentDefinitionV1 {
  return {
    ...definition,
    name: portableText(definition.name),
    description: portableText(definition.description),
    instructions: portableText(definition.instructions),
    runtimeProfile: portableJson(definition.runtimeProfile) as unknown as EffectiveAgentDefinitionV1['runtimeProfile'],
    fallbackChain: definition.fallbackChain.map((profile) =>
      portableJson(profile) as unknown as EffectiveAgentDefinitionV1['runtimeProfile']),
    capabilitySnapshot: {
      version: 1,
      entries: definition.capabilitySnapshot.entries.map((entry) => {
        const { startupBinding: _startupBinding, ...portable } = entry;
        const sanitized = {
          ...portable,
          publicConfig: portableJson(portable.publicConfig),
          credentialBindingIds: [],
        };
        return portable.publicSchema === undefined
          ? sanitized
          : { ...sanitized, publicSchema: portableJson(portable.publicSchema) };
      }),
    },
  };
}

/** Sanitizes the Custom-Agent fields embedded in legacy workspace node rows. */
export function sanitizeAgentNodeForBackup<T extends Record<string, unknown>>(node: T): T {
  const copy: Record<string, unknown> = { ...node };
  copy.acp_session_id = null;
  copy.external_session_id = null;
  const encoded = copy.agent_effective_definition;
  if (typeof encoded === 'string') {
    try {
      copy.agent_effective_definition = JSON.stringify(
        portableEffectiveDefinition(JSON.parse(encoded) as EffectiveAgentDefinitionV1),
      );
    } catch {
      copy.agent_effective_definition = null;
      copy.agent_definition_id = null;
      copy.agent_definition_revision = null;
    }
  }
  for (const field of ['digest', 'follow_ups', 'trim_snapshot'] as const) {
    const value = copy[field];
    if (typeof value !== 'string') continue;
    try { copy[field] = JSON.stringify(portableJson(JSON.parse(value))); }
    catch { copy[field] = null; }
  }
  return copy as T;
}

function portableContext(run: AgentRunDtoV1): AgentRunBackupFragmentV2['runs'][number]['contextManifest'] {
  const entries = run.contextManifest.entries.map((entry): PortableContextEntryV1 => {
    if (entry.kind === 'artifact') {
      return { kind: 'artifact', artifactId: entry.artifactId, name: entry.name, size: entry.size,
        sha256: entry.sha256, contentAvailability: 'not_exported' };
    }
    if (entry.kind === 'file') {
      return { kind: 'file', workspacePath: portableBackupRelativePath(entry.workspacePath), size: entry.size,
        sha256: entry.sha256, contentAvailability: 'not_exported' };
    }
    return portableJson(entry) as unknown as PortableContextEntryV1;
  });
  return { ...run.contextManifest, entries };
}

function portableRun(run: AgentRunDtoV1): AgentRunBackupFragmentV2['runs'][number] {
  const resultBundle = run.resultBundle ? portableJson(run.resultBundle) as unknown as AgentRunDtoV1['resultBundle'] : null;
  const effectiveDefinition = portableEffectiveDefinition(run.effectiveDefinition);
  return {
    ...run,
    task: portableText(run.task),
    effectiveDefinition,
    contextManifest: portableContext(run),
    executionEnvironment: { ...run.executionEnvironment, cwd: null },
    expectedResult: run.expectedResult === null
      ? null
      : portableJson(run.expectedResult) as unknown as typeof run.expectedResult,
    resultBundle,
  };
}

function requiredId(map: ReadonlyMap<string, string>, sourceId: string, kind: string): string {
  const id = map.get(sourceId);
  if (!id) throw new Error(`Missing imported ${kind} ID for ${sourceId}`);
  return id;
}

function listAllEvents(runs: AgentRunsRepository, ownerUserId: string, runId: string) {
  const events: ReturnType<AgentRunsRepository['listEvents']> = [];
  let afterSeq = -1;
  for (;;) {
    const page = runs.listEvents(ownerUserId, runId, afterSeq, 1000);
    events.push(...page);
    if (page.length < 1000) return events;
    afterSeq = page[page.length - 1].seq;
  }
}

function watchDelivery(watch: AgentRunWatchDtoV1, deliveryStatus: string | null,
  deliveredAt: number | null): ParentDeliveryDtoV1 {
  const status: ParentDeliveryDtoV1['status'] = deliveryStatus === 'delivered'
    ? 'delivered'
    : deliveryStatus === 'undeliverable' ? 'undeliverable' : 'pending';
  return {
    version: 1,
    deliveryId: watch.deliveryId,
    requestedTurnId: watch.requestedTurnId,
    watchId: watch.id,
    parentNodeId: watch.parentNodeId ?? '',
    parentTurnId: watch.parentTurnId ?? '',
    runIds: [...watch.runIds],
    status,
    createdAt: watch.createdAt,
    deliveredAt: status === 'delivered' ? deliveredAt : null,
    error: null,
  };
}

export interface ExportAgentRunBackupOptions {
  /** Limits owner-full backup exports to the Workspaces present in the surrounding backup. */
  workspaceIds?: ReadonlySet<string>;
}

export function exportAgentRunBackup(ownerUserId: string, workspaceId: string | null,
  options: ExportAgentRunBackupOptions = {}): AgentRunBackupFragmentV2 {
  const db = getDb();
  const definitions = new AgentDefinitionsRepository();
  const runs = new AgentRunsRepository();
  const definitionRows = workspaceId === null
    ? db.prepare('SELECT id FROM agent_definitions WHERE owner_user_id = ? ORDER BY id').all(ownerUserId)
    : db.prepare('SELECT id FROM agent_definitions WHERE owner_user_id = ? AND workspace_id = ? ORDER BY id').all(ownerUserId, workspaceId);
  const definitionDtos = (definitionRows as Array<{ id: string }>).map((row) => definitions.get(ownerUserId, row.id))
    .filter((value): value is AgentDefinitionDtoV1 => value !== null)
    .filter((definition) => workspaceId !== null || !options.workspaceIds
      || definition.scope === 'global'
      || (definition.workspaceId !== null && options.workspaceIds.has(definition.workspaceId)));
  const runRows = workspaceId === null
    ? db.prepare('SELECT id FROM agent_runs WHERE owner_user_id = ? ORDER BY id').all(ownerUserId)
    : db.prepare('SELECT id FROM agent_runs WHERE owner_user_id = ? AND workspace_id = ? ORDER BY id').all(ownerUserId, workspaceId);
  const runDtos = (runRows as Array<{ id: string }>).map((row) => runs.getRun(ownerUserId, row.id))
    .filter((value): value is AgentRunDtoV1 => value !== null)
    .filter((run) => workspaceId !== null || !options.workspaceIds || options.workspaceIds.has(run.workspaceId));
  const attempts = runDtos.flatMap((run) => runs.listAttempts(ownerUserId, run.id));
  const events = runDtos.flatMap((run) => listAllEvents(runs, ownerUserId, run.id))
    .map((event) => ({ ...event, payload: portableJson(event.payload) }));
  const interactions = runDtos.flatMap((run) => runs.listInteractions(ownerUserId, run.id))
    .map((interaction) => ({ ...interaction, request: portableJson(interaction.request),
      response: interaction.response === null ? null : portableJson(interaction.response) }));
  const watchRows = (workspaceId === null
    ? db.prepare("SELECT id, delivery_status, delivered_at FROM agent_run_watches WHERE owner_user_id = ? AND status IN ('active','fired','cancelled') ORDER BY id").all(ownerUserId)
    : db.prepare("SELECT id, delivery_status, delivered_at FROM agent_run_watches WHERE owner_user_id = ? AND workspace_id = ? AND status IN ('active','fired','cancelled') ORDER BY id").all(ownerUserId, workspaceId)) as Array<{
      id: string;
      delivery_status: string | null;
      delivered_at: number | null;
    }>;
  const watchesWithDelivery = watchRows.map((row) => ({ row, watch: runs.getWatch(ownerUserId, row.id) }))
    .filter((value): value is typeof value & { watch: AgentRunWatchDtoV1 } => value.watch !== null)
    .filter(({ watch }) => workspaceId !== null || !options.workspaceIds || options.workspaceIds.has(watch.workspaceId));
  const watches = watchesWithDelivery.map(({ watch }) => watch);
  const fragment = parseAgentRunBackupFragmentV2({
    version: 2,
    scope: workspaceId === null ? 'owner_full' : 'workspace',
    workspaceId,
    definitions: definitionDtos.map((definition) => ({
      ...definition,
      name: portableText(definition.name),
      description: portableText(definition.description),
      instructions: portableText(definition.instructions),
      runtimeProfile: portableJson(definition.runtimeProfile) as unknown as typeof definition.runtimeProfile,
      fallbackChain: definition.fallbackChain.map((profile) =>
        portableJson(profile) as unknown as typeof profile),
      permissionPolicy: definition.permissionPolicy === null
        ? null
        : portableJson(definition.permissionPolicy) as unknown as typeof definition.permissionPolicy,
    })),
    runs: runDtos.map(portableRun),
    attempts: attempts.map((attempt) => ({
      ...attempt,
      recoveryEnvelope: attempt.recoveryEnvelope === null
        ? null
        : portableJson(attempt.recoveryEnvelope) as unknown as typeof attempt.recoveryEnvelope,
      error: attempt.error === null
        ? null
        : portableJson(attempt.error) as unknown as typeof attempt.error,
    })),
    events,
    interactions,
    watches,
    deliveries: watchesWithDelivery.map(({ watch, row }) =>
      watchDelivery(watch, row.delivery_status, row.delivered_at)),
  });
  assertPortableAgentRunBackup(fragment);
  return fragment;
}

export interface ImportAgentRunBackupOptions {
  ownerUserId: string;
  fragment: AgentRunBackupFragmentV2;
  workspaceIdMap: ReadonlyMap<string, string>;
  nodeIdMap?: ReadonlyMap<string, string>;
  /** Set only when the caller already owns the surrounding data transaction. */
  withinTransaction?: boolean;
  now?: number;
  createId?: (kind: 'definition' | 'run' | 'attempt' | 'interaction' | 'watch') => string;
}

export interface ImportAgentRunBackupResult {
  definitionIds: Map<string, string>;
  runIds: Map<string, string>;
  attemptIds: Map<string, string>;
  importedDefinitions: number;
  importedRuns: number;
}

const importInterrupted = (now: number): StructuredRunErrorV1 => ({
  version: 1,
  code: 'import_interrupted',
  category: 'import_interrupted',
  message: `Run was imported as historical state at ${now} and will not resume automatically`,
  retryable: false,
});

function encodeRefs(values: string[]): string { return JSON.stringify({ version: 1, values }); }

export function importAgentRunBackup(options: ImportAgentRunBackupOptions): ImportAgentRunBackupResult {
  const fragment = parseAgentRunBackupFragmentV2(options.fragment);
  const now = options.now ?? Date.now();
  const createId = options.createId ?? ((kind) => `import-${kind}-${randomUUID()}`);
  const importableDefinitions = fragment.definitions.filter((definition) =>
    definition.scope === 'global'
      ? fragment.scope === 'owner_full'
      : definition.workspaceId !== null
        && (fragment.scope === 'owner_full' || definition.workspaceId === fragment.workspaceId)
        && options.workspaceIdMap.has(definition.workspaceId));
  const importableRuns = fragment.runs.filter((run) =>
    (fragment.scope === 'owner_full' || run.workspaceId === fragment.workspaceId)
      && options.workspaceIdMap.has(run.workspaceId));
  const importableRunIds = new Set(importableRuns.map((run) => run.id));
  const definitionIds = new Map(importableDefinitions.map((definition) => [definition.id, createId('definition')]));
  const runIds = new Map(importableRuns.map((run) => [run.id, createId('run')]));
  const attemptIds = new Map(fragment.attempts.filter((attempt) => importableRunIds.has(attempt.runId))
    .map((attempt) => [attempt.id, createId('attempt')]));
  const interactionIds = new Map(fragment.interactions.map((interaction) => [interaction.id, createId('interaction')]));
  const watchIds = new Map(fragment.watches.map((watch) => [watch.id, createId('watch')]));
  const sourceRuns = new Map(fragment.runs.map((run) => [run.id, run]));
  const importedNonTerminal = new Set(fragment.runs
    .filter((run) => ![AgentRunStatus.Completed, AgentRunStatus.Failed, AgentRunStatus.Cancelled].includes(run.status))
    .map((run) => run.id));
  const error = importInterrupted(now);

  const importRows = () => {
    const db = getDb();
    for (const raw of importableDefinitions) {
      const parsedDefinition = parseAgentDefinitionDtoV1(raw);
      const definition: AgentDefinitionDtoV1 = {
        ...parsedDefinition,
        name: portableText(parsedDefinition.name),
        description: portableText(parsedDefinition.description),
        instructions: portableText(parsedDefinition.instructions),
        runtimeProfile: portableJson(parsedDefinition.runtimeProfile) as unknown as typeof parsedDefinition.runtimeProfile,
        fallbackChain: parsedDefinition.fallbackChain.map((profile) =>
          portableJson(profile) as unknown as typeof profile),
        permissionPolicy: parsedDefinition.permissionPolicy === null
          ? null
          : portableJson(parsedDefinition.permissionPolicy) as unknown as typeof parsedDefinition.permissionPolicy,
      };
      const workspaceId = definition.workspaceId === null ? null : options.workspaceIdMap.get(definition.workspaceId) ?? null;
      const definitionId = requiredId(definitionIds, definition.id, 'Definition');
      db.prepare(`INSERT INTO agent_definitions (
        id, owner_user_id, scope, workspace_id, name, description, instructions,
        runtime_profile, fallback_chain, tool_refs, skill_refs, mcp_server_refs,
        permission_policy, context_policy, default_run_ttl_ms, status, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?)`)
        .run(definitionId, options.ownerUserId, definition.scope, workspaceId,
          definition.name, definition.description, definition.instructions,
          JSON.stringify(definition.runtimeProfile), JSON.stringify({ version: 1, profiles: definition.fallbackChain }),
          encodeRefs(definition.toolRefs), encodeRefs(definition.skillRefs), encodeRefs(definition.mcpServerRefs),
          definition.permissionPolicy ? JSON.stringify(definition.permissionPolicy) : null,
          JSON.stringify(definition.contextPolicy), definition.defaultRunTtlMs, now, now);
    }

    for (const run of importableRuns) {
      const workspaceId = options.workspaceIdMap.get(run.workspaceId);
      if (!workspaceId) continue;
      const converted = importedNonTerminal.has(run.id);
      const status = converted ? AgentRunStatus.Failed : run.status;
      const definitionId = run.definitionId ? definitionIds.get(run.definitionId) ?? null : null;
      const parentNodeId = run.parentNodeId ? options.nodeIdMap?.get(run.parentNodeId) ?? null : null;
      const completedAt = converted ? now : run.completedAt;
      const archivedAt = converted ? now : run.archivedAt;
      const importedRunId = requiredId(runIds, run.id, 'Run');
      const environment = {
        version: 1 as const,
        kind: run.executionEnvironment.kind,
        cwd: '.',
        sourceWorkspaceId: workspaceId,
        ...(run.executionEnvironment.baseCommit ? { baseCommit: run.executionEnvironment.baseCommit } : {}),
        snapshotHash: run.executionEnvironment.snapshotHash,
        createdAt: run.executionEnvironment.createdAt,
      };
      const effective = portableEffectiveDefinition(run.effectiveDefinition);
      const result = run.resultBundle === null ? null : portableJson(run.resultBundle);
      const expectedResult = run.expectedResult === null ? null : portableJson(run.expectedResult);
      const contextManifest = {
        ...run.contextManifest,
        entries: run.contextManifest.entries.map((entry) => {
          if (entry.kind === 'artifact') {
            const { contentAvailability: _contentAvailability, ...portable } = entry;
            return { ...portable, snapshotPath: `not-exported:${entry.sha256}` };
          }
          if (entry.kind === 'file') {
            const { contentAvailability: _contentAvailability, ...portable } = entry;
            return { ...portable, workspacePath: portableBackupRelativePath(entry.workspacePath),
              snapshotPath: `not-exported:${entry.sha256}` };
          }
          return portableJson(entry);
        }),
      };
      db.prepare(`INSERT INTO agent_runs (
        id, owner_user_id, workspace_id, definition_id, definition_revision, effective_definition,
        invocation_mode, completion_mode, parent_run_id, parent_attempt_id, parent_node_id,
        parent_turn_id, parent_message_id, parent_tool_call_id, task, task_search_text,
        agent_name_snapshot, handoff_search_text, context_manifest, expected_result,
        execution_environment, status, waiting_reason, active_attempt_id, result_bundle,
        latest_event_seq, next_attempt_index, created_at, updated_at, started_at,
        completed_at, archived_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, -1, 0, ?, ?, ?, ?, ?, ?)`)
        .run(importedRunId, options.ownerUserId, workspaceId, definitionId,
          definitionId ? run.definitionRevision : null, JSON.stringify(effective), run.invocationMode,
          run.completionMode, null, parentNodeId,
          portableText(run.task), portableText(run.task).normalize('NFKC').toLowerCase(),
          effective.name.normalize('NFKC').toLowerCase(),
          result && typeof result === 'object' && !Array.isArray(result)
            && result.handoff && typeof result.handoff === 'object' && !Array.isArray(result.handoff)
            && typeof result.handoff.conclusion === 'string' ? result.handoff.conclusion : '',
          JSON.stringify(contextManifest),
          expectedResult ? JSON.stringify(expectedResult) : null, JSON.stringify(environment), status,
          result ? JSON.stringify(result) : null, run.createdAt, now, run.startedAt, completedAt, archivedAt, run.expiresAt);
    }

    const attemptsByRun = new Map<string, number>();
    for (const raw of fragment.attempts) {
      if (!runIds.has(raw.runId)) continue;
      const attempt = parseAgentRunAttemptDtoV1(raw);
      const attemptId = requiredId(attemptIds, attempt.id, 'Attempt');
      const importedRunId = requiredId(runIds, attempt.runId, 'Run');
      const converted = importedNonTerminal.has(attempt.runId) && !['completed', 'failed', 'cancelled'].includes(attempt.status);
      db.prepare(`INSERT INTO agent_run_attempts (
        id, run_id, attempt_index, profile_index, runtime_profile, status, public_session_id,
        native_resume_token, recovery_envelope, started_at, checkpoint_at, completed_at, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`)
        .run(attemptId, importedRunId, attempt.attemptIndex, attempt.profileIndex,
          JSON.stringify(portableJson(attempt.runtimeProfile)), converted ? 'failed' : attempt.status,
          `import-session-${attemptId}`, attempt.recoveryEnvelope ? JSON.stringify(portableJson(attempt.recoveryEnvelope)) : null,
          attempt.startedAt, attempt.checkpointAt, converted ? now : attempt.completedAt,
          converted ? JSON.stringify(error) : attempt.error ? JSON.stringify(portableJson(attempt.error)) : null);
      attemptsByRun.set(attempt.runId, Math.max(attemptsByRun.get(attempt.runId) ?? 0, attempt.attemptIndex + 1));
    }
    for (const sourceRunId of importedNonTerminal) {
      if (!runIds.has(sourceRunId) || attemptsByRun.has(sourceRunId)) continue;
      const source = sourceRuns.get(sourceRunId);
      if (!source) throw new Error(`Missing source Run ${sourceRunId}`);
      const importedRunId = requiredId(runIds, sourceRunId, 'Run');
      const attemptId = createId('attempt');
      attemptIds.set(`synthetic:${sourceRunId}`, attemptId);
      db.prepare(`INSERT INTO agent_run_attempts (
        id, run_id, attempt_index, profile_index, runtime_profile, status, public_session_id,
        native_resume_token, recovery_envelope, started_at, completed_at, error
      ) VALUES (?, ?, 0, 0, ?, 'failed', ?, NULL, NULL, ?, ?, ?)`)
        .run(attemptId, importedRunId, JSON.stringify(portableJson(source.effectiveDefinition.runtimeProfile)),
          `import-session-${attemptId}`, source.startedAt ?? source.createdAt, now, JSON.stringify(error));
      attemptsByRun.set(sourceRunId, 1);
    }
    for (const source of importableRuns) {
      const runId = requiredId(runIds, source.id, 'Run');
      const parentRunId = source.parentRunId ? runIds.get(source.parentRunId) ?? null : null;
      const parentAttemptId = source.parentAttemptId ? attemptIds.get(source.parentAttemptId) ?? null : null;
      if (parentRunId && parentAttemptId) {
        db.prepare('UPDATE agent_runs SET parent_run_id = ?, parent_attempt_id = ? WHERE id = ?')
          .run(parentRunId, parentAttemptId, runId);
      }
    }

    const maxSeq = new Map<string, number>();
    for (const raw of fragment.events) {
      const event = parseAgentRunEventV1(raw);
      const runId = runIds.get(event.runId);
      if (!runId) continue;
      db.prepare(`INSERT INTO agent_run_events (run_id, seq, attempt_id, type, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(runId, event.seq, event.attemptId ? attemptIds.get(event.attemptId) ?? null : null,
          event.type, JSON.stringify(portableJson(event.payload)), event.createdAt);
      maxSeq.set(event.runId, Math.max(maxSeq.get(event.runId) ?? -1, event.seq));
    }
    for (const sourceRunId of importedNonTerminal) {
      const runId = runIds.get(sourceRunId);
      if (!runId) continue;
      const seq = (maxSeq.get(sourceRunId) ?? -1) + 1;
      const attemptId = fragment.attempts.filter((attempt) => attempt.runId === sourceRunId).at(-1)?.id;
      db.prepare(`INSERT INTO agent_run_events (run_id, seq, attempt_id, type, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(runId, seq, attemptId ? attemptIds.get(attemptId) ?? null : attemptIds.get(`synthetic:${sourceRunId}`) ?? null,
          AgentRunEventType.AttemptStatusChanged, JSON.stringify({ version: 1, status: 'failed', error }), now);
      maxSeq.set(sourceRunId, seq);
    }
    for (const [sourceRunId, runId] of runIds) {
      db.prepare('UPDATE agent_runs SET latest_event_seq = ?, next_attempt_index = ? WHERE id = ?')
        .run(maxSeq.get(sourceRunId) ?? -1, attemptsByRun.get(sourceRunId) ?? 0, runId);
    }

    for (const raw of fragment.interactions) {
      if (!runIds.has(raw.runId)) continue;
      const interaction = parseAgentRunInteractionDtoV1(raw);
      const interactionId = requiredId(interactionIds, interaction.id, 'Interaction');
      const importedRunId = requiredId(runIds, interaction.runId, 'Run');
      const pending = interaction.status === 'pending';
      db.prepare(`INSERT INTO agent_run_interactions (
        id, run_id, attempt_id, type, status, request_payload, response_payload, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(interactionId, importedRunId,
          interaction.attemptId ? attemptIds.get(interaction.attemptId) ?? null : null,
          interaction.kind, pending ? 'cancelled' : interaction.status,
          JSON.stringify({ version: 1, value: portableJson(interaction.request) }),
          interaction.response === null ? null : JSON.stringify({ version: 1, value: portableJson(interaction.response) }),
          interaction.createdAt, pending ? now : interaction.resolvedAt);
    }

    for (const rawWatch of fragment.watches) {
      const watch = parseAgentRunWatchDtoV1(rawWatch);
      if (fragment.scope === 'workspace' && watch.workspaceId !== fragment.workspaceId) continue;
      const workspaceId = options.workspaceIdMap.get(watch.workspaceId);
      const members = watch.runIds.map((id) => runIds.get(id)).filter((id): id is string => !!id);
      if (!workspaceId || !members.length) continue;
      const watchId = requiredId(watchIds, watch.id, 'Watch');
      const parentNodeId = watch.parentNodeId ? options.nodeIdMap?.get(watch.parentNodeId) ?? null : null;
      db.prepare(`INSERT INTO agent_run_watches (
        id, owner_user_id, workspace_id, parent_run_id, parent_node_id, parent_turn_id,
        condition, completion_behavior, status, delivery_id, requested_turn_id,
        delivery_status, created_at, updated_at, fired_at, delivered_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'cancelled', ?, ?, 'undeliverable', ?, ?, NULL, ?)`)
        .run(watchId, options.ownerUserId, workspaceId,
          watch.parentRunId ? runIds.get(watch.parentRunId) ?? null : null,
          parentNodeId,
          JSON.stringify(watch.condition), watch.completionMode,
          `import-delivery-${watchId}`, `import-turn-${watchId}`, watch.createdAt, now, now);
      const insertMember = db.prepare('INSERT INTO agent_run_watch_members (watch_id, run_id, added_at) VALUES (?, ?, ?)');
      for (const member of members) insertMember.run(watchId, member, now);
    }
  };
  if (options.withinTransaction) importRows();
  else runInTransaction(importRows);

  return { definitionIds, runIds, attemptIds, importedDefinitions: definitionIds.size, importedRuns: runIds.size };
}
