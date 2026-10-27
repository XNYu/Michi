import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentPolicyCategory, AgentPolicyDecision, AgentRunCompletionMode, AgentRunEventType, AgentRunInvocationMode, AgentRunStatus, type AgentRunAttemptDtoV1, type AgentRunDtoV1, type AgentRunEventV1, type EffectiveAgentDefinitionV1, type ResultBundleV1 } from 'michi-shared';
import { agentRunToDescriptor, type AgentRunProjectionInput } from '../src/services/paneInspectionProjection.run';

const hash = 'a'.repeat(64);

const permission = {
  version: 1 as const,
  preset: 'custom' as const,
  categories: Object.fromEntries(Object.values(AgentPolicyCategory).map((key) => [key, AgentPolicyDecision.Allow])),
  maxDelegationDepth: 3,
  maxConcurrentRuns: 3,
  maxWallTimeMs: 60_000,
  maxAttempts: 3,
  maxTokens: null,
  maxSpendMicros: null,
};
const contextPolicy = {
  version: 1 as const,
  includeWorkspaceInstructions: false,
  allowMessageContext: true,
  allowFileContext: true,
  allowArtifactContext: true,
  maxEstimatedChars: 10_000,
};
const capabilityEntry = {
  id: 'read',
  kind: 'tool' as const,
  revision: 'v1',
  schemaHash: hash,
  contentHash: hash,
  configHash: hash,
  publicConfig: { some: 'config' },
  credentialBindingIds: ['cred-secret-id-should-never-leak'],
};

function effectiveDefinition(): EffectiveAgentDefinitionV1 {
  return {
    version: 1,
    name: 'Worker Agent',
    description: 'Does bounded work',
    instructions: 'Do the task',
    runtimeProfile: { version: 1, runtimeId: 'claude-code', modelId: 'claude-x', providerId: 'anthropic', options: {} },
    fallbackChain: [],
    capabilitySnapshot: { version: 1, entries: [{ ...capabilityEntry }] },
    permissionPolicy: permission,
    contextPolicy,
  };
}

function baseRun(overrides: Partial<AgentRunDtoV1> = {}): AgentRunDtoV1 {
  return {
    version: 1,
    id: 'run-1',
    ownerUserId: 'user-1',
    workspaceId: 'ws-1',
    definitionId: null,
    definitionRevision: null,
    effectiveDefinition: effectiveDefinition(),
    invocationMode: AgentRunInvocationMode.Manual,
    completionMode: AgentRunCompletionMode.Notify,
    parentRunId: null,
    parentAttemptId: null,
    parentNodeId: null,
    parentTurnId: null,
    parentMessageId: null,
    parentToolCallId: null,
    task: 'Do the thing',
    contextManifest: { version: 1, entries: [], assembledAt: 1_000, estimatedChars: 0 },
    expectedResult: null,
    executionEnvironment: {
      version: 1,
      kind: 'shared_workspace',
      cwd: '/some/secret/execution/path',
      sourceWorkspaceId: 'ws-1',
      snapshotHash: hash,
      createdAt: 1_000,
    },
    status: AgentRunStatus.Queued,
    waitingReason: null,
    activeAttemptId: null,
    resultBundle: null,
    latestEventSeq: -1,
    createdAt: 1_000,
    startedAt: null,
    completedAt: null,
    archivedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

function baseAttempt(overrides: Partial<AgentRunAttemptDtoV1> = {}): AgentRunAttemptDtoV1 {
  return {
    version: 1,
    id: 'attempt-1',
    runId: 'run-1',
    attemptIndex: 0,
    profileIndex: 0,
    runtimeProfile: { version: 1, runtimeId: 'claude-code', modelId: 'claude-x', options: {} },
    status: 'running',
    publicSessionId: 'session-1',
    recoveryEnvelope: null,
    startedAt: 1_100,
    checkpointAt: null,
    completedAt: null,
    error: null,
    ...overrides,
  };
}

function cancellationRequestedEvent(overrides: Partial<AgentRunEventV1> = {}): AgentRunEventV1 {
  return {
    version: 1,
    runId: 'run-1',
    seq: 5,
    attemptId: 'attempt-1',
    type: AgentRunEventType.CancellationRequested,
    payload: { version: 1, operationId: 'op-1', reason: null },
    createdAt: 5_000,
    ...overrides,
  };
}

function resultBundle(overrides: Partial<ResultBundleV1> = {}): ResultBundleV1 {
  return {
    version: 1,
    status: 'completed',
    source: 'submitted',
    handoff: { conclusion: 'All done', artifactsOrChanges: 'Changed files X, Y', unresolvedIssues: '' },
    artifacts: [],
    resourceMutations: [],
    externalActions: [],
    ...overrides,
  };
}

function baseInput(overrides: Partial<AgentRunProjectionInput> = {}): AgentRunProjectionInput {
  return {
    run: baseRun(),
    attempts: [],
    assistantEvents: [],
    cancellation: { cancellationRequested: [] },
    presence: { coverage: 'unknown', views: [] },
    backendConnectionId: 'conn-1',
    observedAt: 10_000,
    ...overrides,
  };
}

describe('agentRunToDescriptor — cancellation', () => {
  test('past 15s with no terminal status -> CANCEL_TIMEOUT error, activity still cancelling', () => {
    const run = baseRun({ status: AgentRunStatus.Running, activeAttemptId: 'attempt-1' });
    const attempt = baseAttempt();
    const cancelReq = cancellationRequestedEvent({ createdAt: 0 });
    const descriptor = agentRunToDescriptor(
      baseInput({
        run,
        attempts: [attempt],
        cancellation: { cancellationRequested: [cancelReq] },
        observedAt: 16_000, // 16s after request — past the 15s cancelTimeoutMs limit
      }),
    );
    assert.equal(descriptor.activity, 'cancelling');
    assert.equal(descriptor.execution.status, 'ready');
    if (descriptor.execution.status === 'ready') {
      assert.equal(descriptor.execution.value?.status, 'cancelling');
      assert.equal(descriptor.execution.value?.error?.code, 'CANCEL_TIMEOUT');
    }
  });

  test('CancellationRequested followed by an authoritative terminal status -> not cancelling', () => {
    const run = baseRun({ status: AgentRunStatus.Cancelled, completedAt: 20_000 });
    const cancelReq = cancellationRequestedEvent({ createdAt: 0 });
    const descriptor = agentRunToDescriptor(
      baseInput({
        run,
        cancellation: { cancellationRequested: [cancelReq] },
        observedAt: 20_100,
      }),
    );
    assert.equal(descriptor.activity, 'idle');
    assert.equal(descriptor.execution.status, 'ready');
    if (descriptor.execution.status === 'ready') {
      assert.equal(descriptor.execution.value?.status, 'cancelled');
      assert.equal(descriptor.execution.value?.error, null);
    }
  });
});

describe('agentRunToDescriptor — no secrets in the descriptor', () => {
  test('serialized descriptor contains no credential id, capability config, or environment path', () => {
    const bundle = resultBundle();
    const run = baseRun({
      status: AgentRunStatus.Completed,
      completedAt: 5_000,
      resultBundle: bundle,
      // executionEnvironment.cwd and effectiveDefinition.capabilitySnapshot both carry
      // sensitive/secret-adjacent data that must never reach the DTO.
    });
    const attempt = baseAttempt({ status: 'completed', completedAt: 5_000 });
    const descriptor = agentRunToDescriptor(baseInput({ run, attempts: [attempt] }));
    const serialized = JSON.stringify(descriptor);
    assert.doesNotMatch(serialized, /cred-secret-id-should-never-leak/);
    assert.doesNotMatch(serialized, /\/some\/secret\/execution\/path/);
    assert.doesNotMatch(serialized, new RegExp(hash));
    assert.doesNotMatch(serialized, /credentialBindingIds/);
    assert.doesNotMatch(serialized, /publicConfig/);
    assert.doesNotMatch(serialized, /executionEnvironment/);
    assert.doesNotMatch(serialized, /permissionPolicy/);
  });
});
