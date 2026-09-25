import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentPolicyCategory,
  AgentPolicyDecision,
  AgentRunCompletionMode,
  AgentRunEventType,
  AgentRunInvocationMode,
  AgentRunStatus,
  AgentRunWaitingReason,
  type AgentRunAttemptDtoV1,
  type AgentRunDtoV1,
  type AgentRunEventV1,
  type EffectiveAgentDefinitionV1,
  type ResultBundleV1,
} from 'michi-shared';
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

function assistantEvent(overrides: Partial<AgentRunEventV1> & { text: string }): AgentRunEventV1 {
  const { text, ...rest } = overrides;
  return {
    version: 1,
    runId: 'run-1',
    seq: 0,
    attemptId: 'attempt-1',
    type: AgentRunEventType.Assistant,
    payload: { version: 1, text },
    createdAt: 1_200,
    ...rest,
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

describe('agentRunToDescriptor — status -> activity/execution.status', () => {
  const cases: Array<{ status: AgentRunStatus; activity: string }> = [
    { status: AgentRunStatus.Queued, activity: 'queued' },
    { status: AgentRunStatus.Preparing, activity: 'preparing' },
    { status: AgentRunStatus.Running, activity: 'running' },
    { status: AgentRunStatus.Recovering, activity: 'recovering' },
  ];

  for (const { status, activity } of cases) {
    test(`${status} -> activity ${activity}`, () => {
      const descriptor = agentRunToDescriptor(baseInput({ run: baseRun({ status }) }));
      assert.equal(descriptor.activity, activity);
      assert.equal(descriptor.execution.status, 'ready');
      if (descriptor.execution.status === 'ready') {
        assert.equal(descriptor.execution.value?.status, status);
      }
    });
  }

  test('waiting -> activity waiting, execution.status waiting, waitingReason carried through', () => {
    const run = baseRun({ status: AgentRunStatus.Waiting, waitingReason: AgentRunWaitingReason.Permission });
    const descriptor = agentRunToDescriptor(baseInput({ run }));
    assert.equal(descriptor.activity, 'waiting');
    assert.equal(descriptor.execution.status, 'ready');
    if (descriptor.execution.status === 'ready') {
      assert.equal(descriptor.execution.value?.status, 'waiting');
      assert.equal(descriptor.execution.value?.waitingReason, 'permission');
    }
  });

  for (const status of [AgentRunStatus.Completed, AgentRunStatus.Failed, AgentRunStatus.Cancelled]) {
    test(`terminal ${status} -> activity idle, execution.status ${status} (idle never means success)`, () => {
      const run = baseRun({ status, completedAt: 2_000 });
      const descriptor = agentRunToDescriptor(baseInput({ run }));
      assert.equal(descriptor.activity, 'idle');
      assert.equal(descriptor.execution.status, 'ready');
      if (descriptor.execution.status === 'ready') {
        assert.equal(descriptor.execution.value?.status, status);
      }
    });
  }
});

describe('agentRunToDescriptor — attempt failure does not leak into Run outcome', () => {
  test('a failed attempt followed by recovering is NOT a failed Run', () => {
    const failedAttempt = baseAttempt({
      id: 'attempt-1',
      attemptIndex: 0,
      status: 'failed',
      completedAt: 1_500,
      error: { version: 1, code: 'boom', category: 'transient', message: 'attempt died', retryable: true },
    });
    const recoveringAttempt = baseAttempt({ id: 'attempt-2', attemptIndex: 1, status: 'running', startedAt: 1_600 });
    const run = baseRun({ status: AgentRunStatus.Recovering, activeAttemptId: 'attempt-2' });
    const descriptor = agentRunToDescriptor(
      baseInput({ run, attempts: [failedAttempt, recoveringAttempt] }),
    );
    assert.equal(descriptor.activity, 'recovering');
    assert.equal(descriptor.execution.status, 'ready');
    if (descriptor.execution.status === 'ready') {
      // Run-level status/error must reflect the Run (recovering, no error) — never the attempt's.
      assert.equal(descriptor.execution.value?.status, 'recovering');
      assert.equal(descriptor.execution.value?.error, null);
      assert.equal(descriptor.execution.value?.attemptId, 'attempt-2');
      assert.equal(descriptor.execution.value?.attemptIndex, 1);
    }
  });
});

describe('agentRunToDescriptor — output preview', () => {
  test('terminal + resultBundle -> preview kind handoff using compactResultHandoff', () => {
    const bundle = resultBundle();
    const run = baseRun({ status: AgentRunStatus.Completed, completedAt: 3_000, resultBundle: bundle });
    const descriptor = agentRunToDescriptor(baseInput({ run }));
    assert.equal(descriptor.latestOutput.status, 'ready');
    if (descriptor.latestOutput.status === 'ready') {
      assert.ok(descriptor.latestOutput.value);
      assert.equal(descriptor.latestOutput.value?.kind, 'handoff');
      assert.equal(descriptor.latestOutput.value?.text, 'All done\nChanged files X, Y');
    }
  });

  test('assistant text from attempt 2 is not concatenated with attempt 1', () => {
    const attempt1 = baseAttempt({ id: 'attempt-1', attemptIndex: 0, status: 'failed', completedAt: 1_500 });
    const attempt2 = baseAttempt({ id: 'attempt-2', attemptIndex: 1, status: 'running', startedAt: 1_600 });
    const run = baseRun({ status: AgentRunStatus.Running, activeAttemptId: 'attempt-2' });
    // Simulate a caller that (incorrectly) passed events from both attempts — the projection must
    // still filter to only the selected attempt when building the preview.
    const events = [
      assistantEvent({ attemptId: 'attempt-1', text: 'attempt one output' }),
      assistantEvent({ attemptId: 'attempt-2', text: 'attempt two output' }),
    ];
    const descriptor = agentRunToDescriptor(
      baseInput({ run, attempts: [attempt1, attempt2], assistantEvents: events }),
    );
    assert.equal(descriptor.latestOutput.status, 'ready');
    if (descriptor.latestOutput.status === 'ready') {
      assert.equal(descriptor.latestOutput.value?.kind, 'answer');
      assert.equal(descriptor.latestOutput.value?.text, 'attempt two output');
    }
  });

  test('multi-byte truncation does not split a code point', () => {
    // Each '🎉' is 4 UTF-8 bytes. Build a string clearly over the 1 KiB cap.
    const emoji = '🎉';
    const longText = emoji.repeat(400); // 1600 bytes, over the 1024-byte cap
    const attempt = baseAttempt();
    const run = baseRun({ status: AgentRunStatus.Running, activeAttemptId: 'attempt-1' });
    const events = [assistantEvent({ text: longText })];
    const descriptor = agentRunToDescriptor(baseInput({ run, attempts: [attempt], assistantEvents: events }));
    assert.equal(descriptor.latestOutput.status, 'ready');
    if (descriptor.latestOutput.status === 'ready') {
      assert.ok(descriptor.latestOutput.value);
      const preview = descriptor.latestOutput.value!;
      assert.equal(preview.truncated, true);
      const byteLength = Buffer.byteLength(preview.text, 'utf8');
      assert.ok(byteLength <= 1_024, `expected <=1024 bytes, got ${byteLength}`);
      // Re-encoding must round-trip cleanly with no replacement/mangled characters.
      assert.doesNotMatch(preview.text, /\uFFFD/);
      // Every character in the truncated text must be a complete emoji (no half code point).
      assert.equal(preview.text.length % 2, 0); // 🎉 is a surrogate pair in UTF-16 (length 2)
    }
  });
});

describe('agentRunToDescriptor — cancellation', () => {
  test('CancellationRequested with no terminal status -> activity cancelling, no error yet', () => {
    const run = baseRun({ status: AgentRunStatus.Running, activeAttemptId: 'attempt-1' });
    const attempt = baseAttempt();
    const cancelReq = cancellationRequestedEvent({ createdAt: 9_500 });
    const descriptor = agentRunToDescriptor(
      baseInput({
        run,
        attempts: [attempt],
        cancellation: { cancellationRequested: [cancelReq] },
        observedAt: 10_000, // 500ms after request — well under the 15s CANCEL_TIMEOUT
      }),
    );
    assert.equal(descriptor.activity, 'cancelling');
    assert.equal(descriptor.execution.status, 'ready');
    if (descriptor.execution.status === 'ready') {
      assert.equal(descriptor.execution.value?.status, 'cancelling');
      assert.equal(descriptor.execution.value?.error, null);
    }
  });

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

describe('agentRunToDescriptor — conversation is unsupported, never a number', () => {
  test('conversation.status is unsupported with a reason', () => {
    const descriptor = agentRunToDescriptor(baseInput());
    assert.equal(descriptor.conversation.status, 'unsupported');
    if (descriptor.conversation.status === 'unsupported' || descriptor.conversation.status === 'unknown' || descriptor.conversation.status === 'redacted') {
      assert.ok(descriptor.conversation.reason.length > 0);
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

