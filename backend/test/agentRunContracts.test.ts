import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_RUN_LIMITS, AgentDefinitionDtoV1, AgentDefinitionStatus,
  AgentRunCompletionMode, AgentRunContractError, AgentRunDtoV1,
  AgentPolicyCategory, AgentPolicyDecision, AgentRunEventType, AgentRunInvocationMode, AgentRunStatus, AgentRunValidators,
  MAX_RUN_TTL_MS, MIN_RUN_TTL_MS, assertSecretFreePublicPayload,
  parseAgentDefinitionDtoV1, parseAgentRunAttemptDtoV1, parseAgentRunDtoV1, parseAgentRunEventV1,
  parseAgentRunInteractionDtoV1,
  parseAgentRunBackupFragmentV2, parseAgentRunListQueryV1, parseAgentRunSseEnvelopeV1,
  parseAgentRunWatchDtoV1, parseCancelAgentRunRequestV1, parseCreateAgentRunWatchRequestV1,
  parseAgentRunInputRequestV1, parseJsonValue, parseRespondAgentRunInteractionRequestV1,
  parseResultBundleV1, parseUpdateAgentRunWatchRequestV1,
  parseRunTtl, parseSpawnAgentRunRequestV1, parseWaitAgentRunRequestV1,
} from 'michi-shared';

const hash = 'a'.repeat(64);
const now = 1_787_827_200_000;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const rejects = (fn: () => unknown, pattern?: RegExp): void => {
  assert.throws(fn, (error) => error instanceof AgentRunContractError && (!pattern || pattern.test(error.message)));
};

const permissionPolicy = { version: 1 as const, preset: 'build' as const, categories: { [AgentPolicyCategory.FilesystemWrite]: AgentPolicyDecision.Allow, [AgentPolicyCategory.ExternalAction]: AgentPolicyDecision.Ask }, maxDelegationDepth: 2, maxConcurrentRuns: 4, maxWallTimeMs: 3_600_000, maxAttempts: 3 };
const contextPolicy = { version: 1 as const, includeWorkspaceInstructions: true, allowMessageContext: true, allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 100_000 };
const runtimeProfile = { version: 1 as const, runtimeId: 'pi', providerId: 'anthropic', modelId: 'claude-sonnet', reasoning: 'high' as const, options: { temperature: 0 } };
const effectiveDefinition = {
  version: 1 as const, name: 'Implementer', description: 'Implements bounded coding tasks when delegated.',
  instructions: 'Inspect the requested scope, implement it, and verify the result.', runtimeProfile,
  fallbackChain: [{ ...runtimeProfile, runtimeId: 'claude', reasoning: 'medium' as const }],
  capabilitySnapshot: { version: 1 as const, entries: [{ id: 'filesystem', kind: 'tool' as const, revision: '7', schemaHash: hash, contentHash: null, configHash: hash, publicSchema: { type: 'object' }, publicConfig: { rootMode: 'worktree' }, credentialBindingIds: ['binding-filesystem'] }] },
  permissionPolicy, contextPolicy,
};
const definition: AgentDefinitionDtoV1 = {
  version: 1, id: 'definition-1', ownerUserId: 'owner-1', scope: 'workspace', workspaceId: 'workspace-1',
  name: effectiveDefinition.name, description: effectiveDefinition.description, instructions: effectiveDefinition.instructions,
  runtimeProfile, fallbackChain: effectiveDefinition.fallbackChain, toolRefs: ['filesystem'], skillRefs: ['implementation'],
  mcpServerRefs: [], permissionPolicy, contextPolicy, defaultRunTtlMs: null, status: AgentDefinitionStatus.Enabled,
  revision: 3, createdAt: now, updatedAt: now + 1,
};
const run: AgentRunDtoV1 = {
  version: 1, id: 'run-1', ownerUserId: 'owner-1', workspaceId: 'workspace-1', definitionId: definition.id,
  definitionRevision: definition.revision, effectiveDefinition, invocationMode: AgentRunInvocationMode.Delegated,
  completionMode: AgentRunCompletionMode.Wake, parentRunId: null, parentAttemptId: null, parentNodeId: 'node-1', parentTurnId: 'turn-1',
  parentMessageId: 'message-1', parentToolCallId: 'tool-call-1', task: 'Implement the public contract.',
  contextManifest: { version: 1, entries: [{ kind: 'message', nodeId: 'node-1', messageId: 'message-0', role: 'user', content: 'Please implement T01.', sha256: hash }], assembledAt: now, estimatedChars: 21 },
  expectedResult: { version: 1, format: 'json', jsonSchema: { type: 'object' } },
  executionEnvironment: { version: 1, kind: 'git_worktree', cwd: '/tmp/run-1', sourceWorkspaceId: 'workspace-1', baseCommit: 'abc123', snapshotHash: hash, createdAt: now },
  status: AgentRunStatus.Running, waitingReason: null, activeAttemptId: 'attempt-1', resultBundle: null,
  latestEventSeq: 4, createdAt: now, startedAt: now + 1, completedAt: null, archivedAt: null, expiresAt: null,
};

describe('Custom Agent V1 public contracts', () => {
  test('round-trips valid Definition, Run, event, and SSE fixtures while tolerating additive fields', () => {
    assert.deepEqual(parseAgentDefinitionDtoV1({ ...clone(definition), futureField: true }), definition);
    assert.deepEqual(parseAgentRunDtoV1({ ...clone(run), futureProjection: true }), run);
    const event = { version: 1, runId: run.id, seq: 5, attemptId: 'attempt-1', type: AgentRunEventType.RunStatusChanged, payload: { version: 1, from: 'running', to: 'completed', waitingReason: null }, createdAt: now + 2 };
    const envelope = { version: 1, event: 'agent_run_event', runId: run.id, seq: 5, eventData: event, gapAfterSeq: null, emittedAt: now + 3 };
    assert.deepEqual(parseAgentRunSseEnvelopeV1(clone(envelope)), envelope);
  });

  test('uses zero-based event sequences and -1 as the pre-event cursor', () => {
    const preEventRun = { ...clone(run), latestEventSeq: -1 };
    assert.equal(parseAgentRunDtoV1(preEventRun).latestEventSeq, -1);
    const event = { version: 1, runId: run.id, seq: 0, attemptId: null, type: AgentRunEventType.Assistant, payload: { text: 'started' }, createdAt: now };
    const envelope = { version: 1, event: 'agent_run_event', runId: run.id, seq: 0, eventData: event, gapAfterSeq: null, emittedAt: now };
    assert.deepEqual(parseAgentRunSseEnvelopeV1(envelope), envelope);
    assert.deepEqual(
      parseAgentRunSseEnvelopeV1({ version: 1, event: 'agent_run_gap', runId: run.id, seq: null, eventData: null, gapAfterSeq: -1, emittedAt: now }),
      { version: 1, event: 'agent_run_gap', runId: run.id, seq: null, eventData: null, gapAfterSeq: -1, emittedAt: now },
    );
  });

  test('validates Attempt and Interaction detail records', () => {
    const error = { version: 1, code: 'runtime_failed', category: 'transient', message: 'Runtime exited.', retryable: true, details: { exitCode: 1 } };
    const attempt = { version: 1, id: 'attempt-1', runId: run.id, attemptIndex: 0, profileIndex: 0, runtimeProfile, status: 'failed', publicSessionId: 'public-session-1', recoveryEnvelope: { version: 1, completedWork: 'Inspected files.', currentResourceState: { clean: true }, outstandingWork: 'Apply patch.', failureBoundary: error, resultBundleDraft: null }, startedAt: now, checkpointAt: now + 1, completedAt: now + 2, error };
    const interaction = { version: 1, id: 'interaction-1', runId: run.id, attemptId: attempt.id, kind: 'permission', status: 'pending', request: { category: 'shell_exec' }, response: null, createdAt: now, resolvedAt: null };
    assert.deepEqual(parseAgentRunAttemptDtoV1(attempt), attempt);
    assert.deepEqual(parseAgentRunInteractionDtoV1(interaction), interaction);
    rejects(() => parseAgentRunAttemptDtoV1({ ...attempt, publicSessionId: '' }), /publicSessionId/);
    rejects(() => parseAgentRunAttemptDtoV1({ ...attempt, recoveryEnvelope: { ...attempt.recoveryEnvelope, currentResourceState: { apiKey: 'secret' } } }), /secret-bearing/);
    rejects(() => parseAgentRunInteractionDtoV1({ ...interaction, response: { approved: true } }), /while pending/);
    rejects(() => parseAgentRunInteractionDtoV1({ ...interaction, status: 'resolved' }), /resolvedAt/);
  });

  test('persists lowercase statuses and rejects uppercase/invented statuses', () => {
    assert.equal(AgentRunValidators.validateStatus('running'), true);
    assert.equal(AgentRunValidators.validateStatus('Running'), false);
    assert.equal(AgentRunValidators.validateStatus('terminal'), false);
    assert.equal(AgentRunValidators.validateDefinitionStatus('enabled'), true);
    assert.equal(AgentRunValidators.validateDefinitionStatus('Enabled'), false);
  });

  test('rejects unknown versions, illegal status transitions, and negative times', () => {
    rejects(() => parseAgentDefinitionDtoV1({ ...clone(definition), version: 2 }), /version/);
    rejects(() => parseAgentRunEventV1({ version: 1, runId: 'run-1', seq: 1, attemptId: null, type: 'run_status_changed', payload: { version: 1, from: 'completed', to: 'running' }, createdAt: now }), /transition/);
    rejects(() => parseAgentDefinitionDtoV1({ ...clone(definition), createdAt: -1 }), /createdAt/);
  });

  test('rejects malformed owner/workspace scope and Parent anchor combinations', () => {
    rejects(() => parseAgentDefinitionDtoV1({ ...clone(definition), ownerUserId: '' }), /ownerUserId/);
    rejects(() => parseAgentDefinitionDtoV1({ ...clone(definition), scope: 'global', workspaceId: 'workspace-1' }), /workspaceId/);
    rejects(() => parseAgentRunDtoV1({ ...clone(run), workspaceId: '' }), /workspaceId/);
    rejects(() => parseAgentRunDtoV1({ ...clone(run), parentMessageId: null, parentToolCallId: null }), /supplied together/);
    rejects(() => parseAgentRunDtoV1({ ...clone(run), parentMessageId: null, parentToolCallId: 'tool-call-1' }), /parentToolCallId/);
    rejects(() => parseAgentRunDtoV1({ ...clone(run), definitionRevision: null }), /definitionRevision/);
    assert.equal(parseAgentRunDtoV1({ ...clone(run), definitionId: null }).definitionRevision, definition.revision);
    rejects(() => parseAgentRunDtoV1({ ...clone(run), invocationMode: 'manual' }), /manual invocation/);
    rejects(() => parseAgentRunDtoV1({ ...clone(run), parentAttemptId: 'attempt-parent' }), /requires parentRunId/);
    const legacyNested = { ...clone(run), parentRunId: 'run-parent', parentNodeId: null, parentTurnId: null,
      parentMessageId: null, parentToolCallId: 'tool-call-1' } as Record<string, unknown>;
    delete legacyNested.parentAttemptId;
    assert.equal(parseAgentRunDtoV1(legacyNested).parentAttemptId, null);
  });

  test('rejects duplicate context identities and bounded Definition fields', () => {
    const duplicate = clone(run);
    duplicate.contextManifest.entries.push(clone(duplicate.contextManifest.entries[0]));
    rejects(() => parseAgentRunDtoV1(duplicate), /duplicate context/);
    rejects(() => parseAgentDefinitionDtoV1({ ...clone(definition), instructions: 'x'.repeat(AGENT_RUN_LIMITS.instructions + 1) }), /instructions/);
    rejects(() => parseAgentDefinitionDtoV1({ ...clone(definition), description: 'x'.repeat(AGENT_RUN_LIMITS.description + 1) }), /description/);
    rejects(() => parseAgentDefinitionDtoV1({ ...clone(definition), toolRefs: Array.from({ length: AGENT_RUN_LIMITS.capabilityRefs + 1 }, (_, index) => `tool-${index}`) }), /toolRefs/);
    assert.equal(parseAgentDefinitionDtoV1({ ...clone(definition), instructions: '', runtimeProfile: { version: 1, runtimeId: '' } }).instructions, '');
  });

  test('preserves null retention and rejects TTLs outside policy', () => {
    assert.equal(parseRunTtl(null), null);
    assert.equal(parseRunTtl(MIN_RUN_TTL_MS), MIN_RUN_TTL_MS);
    assert.equal(parseRunTtl(MAX_RUN_TTL_MS), MAX_RUN_TTL_MS);
    rejects(() => parseRunTtl(0), /runTtlMs/);
    rejects(() => parseRunTtl(MIN_RUN_TTL_MS - 1), /runTtlMs/);
    rejects(() => parseRunTtl(MAX_RUN_TTL_MS + 1), /runTtlMs/);
  });

  test('rejects malformed hashes, secrets, and native resume tokens', () => {
    const badHash = clone(run);
    badHash.effectiveDefinition.capabilitySnapshot.entries[0].schemaHash = 'short';
    rejects(() => parseAgentRunDtoV1(badHash), /schemaHash/);
    const secret = clone(run);
    secret.effectiveDefinition.capabilitySnapshot.entries[0].publicConfig = { apiKey: 'do-not-export' };
    rejects(() => parseAgentRunDtoV1(secret), /secret-bearing/);
    rejects(() => assertSecretFreePublicPayload({ version: 2, attempts: [{ nativeResumeToken: 'private' }] }, 'backup'), /nativeResumeToken/);
  });

  test('bounds JSON strings, arrays, depth, and finite numbers', () => {
    let nested: unknown = 'leaf';
    for (let index = 0; index < AGENT_RUN_LIMITS.jsonDepth + 2; index += 1) nested = { child: nested };
    rejects(() => parseJsonValue(nested), /depth/);
    rejects(() => parseJsonValue(Array(AGENT_RUN_LIMITS.jsonArray + 1).fill(null)), /256 items/);
    rejects(() => parseJsonValue('x'.repeat(AGENT_RUN_LIMITS.jsonString + 1)), /characters/);
    rejects(() => parseJsonValue(Number.NaN), /finite/);
  });

  test('bounds structured Result Bundle receipts and handoff strings', () => {
    const result = { version: 1, status: 'completed', source: 'submitted', handoff: { conclusion: 'Done', artifactsOrChanges: 'One file', unresolvedIssues: '' }, artifacts: [], resourceMutations: [], externalActions: [], structuredResult: { ok: true } };
    assert.deepEqual(parseResultBundleV1(result), result);
    rejects(() => parseResultBundleV1({ ...result, resourceMutations: Array.from({ length: AGENT_RUN_LIMITS.resultReceipts + 1 }, (_, index) => ({ id: `r-${index}`, kind: 'file', summary: 'changed', idempotencyKey: null, details: null })) }), /resourceMutations/);
    rejects(() => parseResultBundleV1({ ...result, handoff: { ...result.handoff, conclusion: 'x'.repeat(AGENT_RUN_LIMITS.receiptText + 1) } }), /conclusion/);
  });

  test('validates watch quorum/delivery identity plus bounded wait/search requests', () => {
    const watch = { version: 1, id: 'watch-1', ownerUserId: 'owner-1', workspaceId: 'workspace-1', runIds: ['run-1', 'run-2'], condition: { version: 1, kind: 'quorum', count: 2 }, completionMode: 'wake', status: 'active', deliveryId: 'delivery-1', requestedTurnId: 'turn-delivery-1', parentRunId: null, parentNodeId: 'node-1', parentTurnId: 'turn-1', createdAt: now, firedAt: null };
    assert.deepEqual(parseAgentRunWatchDtoV1(watch), watch);
    assert.deepEqual(parseAgentRunWatchDtoV1({ ...watch, runIds: [] }).runIds, []);
    rejects(() => parseAgentRunWatchDtoV1({ ...watch, condition: { version: 1, kind: 'quorum', count: 3 } }), /count/);
    rejects(() => parseAgentRunWatchDtoV1({ ...watch, deliveryId: '' }), /deliveryId/);
    assert.deepEqual(parseWaitAgentRunRequestV1({ version: 1, runId: 'run-1', timeoutMs: AGENT_RUN_LIMITS.waitMs }), { version: 1, runId: 'run-1', timeoutMs: AGENT_RUN_LIMITS.waitMs });
    rejects(() => parseWaitAgentRunRequestV1({ version: 1, runId: 'run-1', watchId: 'watch-1', timeoutMs: 1 }), /exactly one/);
    rejects(() => parseWaitAgentRunRequestV1({ version: 1, runId: 'run-1', timeoutMs: AGENT_RUN_LIMITS.waitMs + 1 }), /timeoutMs/);
    rejects(() => parseAgentRunListQueryV1({ version: 1, workspaceId: 'workspace-1', q: 'x'.repeat(AGENT_RUN_LIMITS.searchQuery + 1) }), /query.q/);
    assert.deepEqual(parseAgentRunListQueryV1({ version: 1, workspaceId: 'workspace-1', includeArchived: true, cursor: 'run-2' }), { version: 1, workspaceId: 'workspace-1', includeArchived: true, cursor: 'run-2' });
    assert.deepEqual(parseAgentRunInputRequestV1({ version: 1, text: 'Continue', mode: 'queued', expectedAttemptId: null }), { version: 1, text: 'Continue', mode: 'queued', expectedAttemptId: null });
    assert.deepEqual(parseCancelAgentRunRequestV1({ version: 1, expectedAttemptId: 'attempt-1', reason: null }), { version: 1, expectedAttemptId: 'attempt-1', reason: null });
    assert.deepEqual(parseRespondAgentRunInteractionRequestV1({ version: 1, response: { allow: true } }), { version: 1, response: { allow: true } });
    assert.deepEqual(parseCreateAgentRunWatchRequestV1({ version: 1, workspaceId: 'workspace-1', runIds: ['run-1'], condition: { version: 1, kind: 'all' }, completionMode: 'notify', parentRunId: null, parentNodeId: null, parentTurnId: null }).runIds, ['run-1']);
    assert.deepEqual(parseUpdateAgentRunWatchRequestV1({ version: 1, addRunIds: ['run-2'] }), { version: 1, addRunIds: ['run-2'] });
  });

  test('validates saved-versus-ephemeral spawn and sanitized backup fragments', () => {
    const spawn = { version: 1, workspaceId: 'workspace-1', agentId: 'definition-1', ephemeralDefinition: null, task: 'Do the work', contextManifest: clone(run.contextManifest), permissionRestriction: null, environment: { version: 1, kind: 'auto' }, expectedResult: null, completionMode: 'wake', invocationMode: 'delegated', runTtlMs: null, parentRunId: null, parentAttemptId: null, parentNodeId: 'node-1', parentTurnId: 'turn-1', parentMessageId: 'message-1', parentToolCallId: 'tool-call-1' };
    assert.deepEqual(parseSpawnAgentRunRequestV1(spawn), spawn);
    rejects(() => parseSpawnAgentRunRequestV1({ ...spawn, ephemeralDefinition: clone(effectiveDefinition) }), /exactly one/);
    const backup = { version: 2, scope: 'workspace', workspaceId: 'workspace-1', definitions: [], runs: [], attempts: [], events: [], interactions: [], watches: [], deliveries: [] };
    assert.deepEqual(parseAgentRunBackupFragmentV2(backup), backup);
    rejects(() => parseAgentRunBackupFragmentV2({ ...backup, attempts: [{ nativeResumeToken: 'private' }] }), /nativeResumeToken/);
    rejects(() => parseAgentRunBackupFragmentV2({ ...backup, runs: [{ executionEnvironment: { cwd: '/private/worktree' } }] }), /cwd/);
  });
});
