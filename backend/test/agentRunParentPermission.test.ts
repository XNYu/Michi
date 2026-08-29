import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentPolicyCategory,
  AgentPolicyDecision,
  type AgentPermissionPolicyV1,
} from 'michi-shared';
import {
  computeEffectiveRunPermission,
  deriveParentPermissionSnapshot,
  type DeriveParentSnapshotInput,
  type ParentPermissionPort,
} from '../src/agents/runs/parentPermissionSnapshot';
import { intersectPermissionPolicies } from '../src/agents/runs/effectivePermissionPolicy';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function policy(preset: AgentPermissionPolicyV1['preset'] = 'custom',
  overrides: Partial<Record<AgentPolicyCategory, AgentPolicyDecision>> = {},
  budgets: Partial<Pick<AgentPermissionPolicyV1, 'maxDelegationDepth' | 'maxConcurrentRuns' | 'maxWallTimeMs' | 'maxAttempts' | 'maxTokens' | 'maxSpendMicros'>> = {},
): AgentPermissionPolicyV1 {
  return {
    version: 1, preset,
    categories: {
      ...Object.fromEntries(Object.values(AgentPolicyCategory).map((key) => [key, AgentPolicyDecision.Allow])),
      ...overrides,
    },
    maxDelegationDepth: budgets.maxDelegationDepth ?? 5,
    maxConcurrentRuns: budgets.maxConcurrentRuns ?? 10,
    maxWallTimeMs: budgets.maxWallTimeMs ?? 600_000,
    maxAttempts: budgets.maxAttempts ?? 3,
    maxTokens: budgets.maxTokens ?? null,
    maxSpendMicros: budgets.maxSpendMicros ?? null,
  };
}

function restrictivePolicy(): AgentPermissionPolicyV1 {
  return policy('custom', {
    [AgentPolicyCategory.ShellExec]: AgentPolicyDecision.Deny,
    [AgentPolicyCategory.ExternalAction]: AgentPolicyDecision.Deny,
    [AgentPolicyCategory.SpawnAgent]: AgentPolicyDecision.Ask,
  }, { maxDelegationDepth: 2, maxConcurrentRuns: 2, maxWallTimeMs: 120_000, maxTokens: 50_000 });
}

function fakePort(
  runPolicies: Record<string, AgentPermissionPolicyV1> = {},
  chatPolicies: Record<string, AgentPermissionPolicyV1> = {},
): ParentPermissionPort {
  return {
    getRunEffectivePolicy(_ownerUserId: string, parentRunId: string) {
      return runPolicies[parentRunId] ?? null;
    },
    getChatEffectivePolicy(_ownerUserId: string, _workspaceId: string, parentNodeId: string) {
      return chatPolicies[parentNodeId] ?? null;
    },
  };
}

function baseInput(overrides: Partial<DeriveParentSnapshotInput> = {}): DeriveParentSnapshotInput {
  return {
    invocationMode: 'manual',
    ownerUserId: 'owner',
    workspaceId: 'ws',
    parentRunId: null,
    parentAttemptId: null,
    parentNodeId: null,
    workspacePolicy: policy(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: deriveParentPermissionSnapshot
// ---------------------------------------------------------------------------

describe('deriveParentPermissionSnapshot', () => {
  test('manual run without parent uses workspace defaults', () => {
    const workspacePolicy = restrictivePolicy();
    const snapshot = deriveParentPermissionSnapshot(
      baseInput({ invocationMode: 'manual', workspacePolicy }),
      fakePort(),
    );
    assert.deepEqual(snapshot.policy, workspacePolicy);
    assert.deepEqual(snapshot.source, { kind: 'workspace_default' });
  });

  test('delegated run from Parent Run uses the Parent Run persisted effective policy', () => {
    const parentPolicy = restrictivePolicy();
    const snapshot = deriveParentPermissionSnapshot(
      baseInput({
        invocationMode: 'delegated',
        parentRunId: 'parent-run-1',
        parentAttemptId: 'parent-attempt-1',
      }),
      fakePort({ 'parent-run-1': parentPolicy }),
    );
    assert.deepEqual(snapshot.policy, parentPolicy);
    assert.deepEqual(snapshot.source, {
      kind: 'parent_run', parentRunId: 'parent-run-1', parentAttemptId: 'parent-attempt-1',
    });
  });

  test('delegated run from Parent Run falls back to workspace policy when policy is unavailable', () => {
    const workspacePolicy = restrictivePolicy();
    const snapshot = deriveParentPermissionSnapshot(
      baseInput({
        invocationMode: 'delegated',
        parentRunId: 'missing-run',
        parentAttemptId: 'attempt-x',
        workspacePolicy,
      }),
      fakePort(),
    );
    // Falls back to workspace policy for backward compatibility
    assert.deepEqual(snapshot.policy, workspacePolicy);
    assert.deepEqual(snapshot.source, {
      kind: 'parent_run', parentRunId: 'missing-run', parentAttemptId: 'attempt-x',
    });
  });

  test('delegated run from Parent chat uses the chat effective policy', () => {
    const chatPolicy = restrictivePolicy();
    const snapshot = deriveParentPermissionSnapshot(
      baseInput({
        invocationMode: 'delegated',
        parentNodeId: 'node-1',
      }),
      fakePort({}, { 'node-1': chatPolicy }),
    );
    assert.deepEqual(snapshot.policy, chatPolicy);
    assert.deepEqual(snapshot.source, { kind: 'parent_chat', parentNodeId: 'node-1' });
  });

  test('delegated run from Parent chat falls back to workspace policy when port returns null', () => {
    const workspacePolicy = restrictivePolicy();
    const snapshot = deriveParentPermissionSnapshot(
      baseInput({
        invocationMode: 'delegated',
        parentNodeId: 'node-missing',
        workspacePolicy,
      }),
      fakePort(),
    );
    assert.deepEqual(snapshot.policy, workspacePolicy);
    assert.deepEqual(snapshot.source, { kind: 'parent_chat', parentNodeId: 'node-missing' });
  });

  test('delegated run from Parent chat falls back to workspace when port has no getChatEffectivePolicy', () => {
    const workspacePolicy = restrictivePolicy();
    const portWithoutChat: ParentPermissionPort = {
      getRunEffectivePolicy: () => null,
    };
    const snapshot = deriveParentPermissionSnapshot(
      baseInput({
        invocationMode: 'delegated',
        parentNodeId: 'node-1',
        workspacePolicy,
      }),
      portWithoutChat,
    );
    assert.deepEqual(snapshot.policy, workspacePolicy);
  });

  test('parentless delegated run (no parentRunId, no parentNodeId) uses workspace defaults', () => {
    const workspacePolicy = restrictivePolicy();
    const snapshot = deriveParentPermissionSnapshot(
      baseInput({ invocationMode: 'delegated', workspacePolicy }),
      fakePort(),
    );
    assert.deepEqual(snapshot.policy, workspacePolicy);
    assert.deepEqual(snapshot.source, { kind: 'workspace_default' });
  });
});

// ---------------------------------------------------------------------------
// Tests: computeEffectiveRunPermission
// ---------------------------------------------------------------------------

describe('computeEffectiveRunPermission', () => {
  test('intersects platform, workspace, parent, definition, and spawn', () => {
    const platform = policy('custom', {}, { maxDelegationDepth: 10, maxWallTimeMs: 1_000_000 });
    const workspace = policy('custom', { [AgentPolicyCategory.ExternalAction]: AgentPolicyDecision.Ask });
    const parent = {
      policy: policy('custom', {
        [AgentPolicyCategory.ShellExec]: AgentPolicyDecision.Ask,
        [AgentPolicyCategory.ExternalAction]: AgentPolicyDecision.Deny,
      }),
      source: { kind: 'parent_run' as const, parentRunId: 'p1', parentAttemptId: 'a1' },
    };
    const definition = policy('custom', {
      [AgentPolicyCategory.ShellExec]: AgentPolicyDecision.Allow,
    }, { maxDelegationDepth: 3 });

    const result = computeEffectiveRunPermission({
      platform, workspace, parent, definition, spawn: null,
    });

    // ShellExec: platform Allow, workspace Allow, parent Ask, definition Allow → Ask
    assert.equal(result.categories[AgentPolicyCategory.ShellExec], AgentPolicyDecision.Ask);
    // ExternalAction: platform Allow, workspace Ask, parent Deny → Deny
    assert.equal(result.categories[AgentPolicyCategory.ExternalAction], AgentPolicyDecision.Deny);
    // maxDelegationDepth: min(10, 5, 5, 3) = 3
    assert.equal(result.maxDelegationDepth, 3);
  });

  test('delegated Run cannot exceed Parent effective category decision', () => {
    const platform = policy();
    const workspace = policy();
    const parentPolicy = policy('custom', {
      [AgentPolicyCategory.FilesystemWrite]: AgentPolicyDecision.Deny,
      [AgentPolicyCategory.SpawnAgent]: AgentPolicyDecision.Ask,
    });
    const parent = {
      policy: parentPolicy,
      source: { kind: 'parent_run' as const, parentRunId: 'p1', parentAttemptId: 'a1' },
    };

    const result = computeEffectiveRunPermission({
      platform, workspace, parent, definition: policy(), spawn: null,
    });

    // Even though definition says Allow, parent ceiling says Deny
    assert.equal(result.categories[AgentPolicyCategory.FilesystemWrite], AgentPolicyDecision.Deny);
    assert.equal(result.categories[AgentPolicyCategory.SpawnAgent], AgentPolicyDecision.Ask);
  });

  test('delegated Run cannot exceed Parent budget limits', () => {
    const platform = policy('custom', {}, { maxTokens: 1_000_000 });
    const workspace = policy('custom', {}, { maxTokens: 500_000 });
    const parentPolicy = policy('custom', {}, { maxTokens: 100_000, maxSpendMicros: 50_000 });
    const parent = {
      policy: parentPolicy,
      source: { kind: 'parent_run' as const, parentRunId: 'p1', parentAttemptId: 'a1' },
    };
    const definition = policy('custom', {}, { maxTokens: 200_000, maxSpendMicros: 100_000 });

    const result = computeEffectiveRunPermission({
      platform, workspace, parent, definition, spawn: null,
    });

    assert.equal(result.maxTokens, 100_000);
    assert.equal(result.maxSpendMicros, 50_000);
  });

  test('manual Run uses workspace defaults as parent (no additional restriction)', () => {
    const platform = policy();
    const workspace = policy('custom', {
      [AgentPolicyCategory.ShellExec]: AgentPolicyDecision.Ask,
    }, { maxDelegationDepth: 4 });
    const parent = {
      policy: workspace, // manual → workspace is the parent snapshot
      source: { kind: 'workspace_default' as const },
    };

    const result = computeEffectiveRunPermission({
      platform, workspace, parent, definition: null, spawn: null,
    });

    assert.equal(result.categories[AgentPolicyCategory.ShellExec], AgentPolicyDecision.Ask);
    assert.equal(result.maxDelegationDepth, 4);
  });

  test('spawn restriction further limits the effective policy', () => {
    const platform = policy();
    const workspace = policy();
    const parent = {
      policy: policy(),
      source: { kind: 'workspace_default' as const },
    };
    const spawn = policy('custom', {
      [AgentPolicyCategory.Browse]: AgentPolicyDecision.Deny,
    }, { maxAttempts: 1 });

    const result = computeEffectiveRunPermission({
      platform, workspace, parent, definition: null, spawn,
    });

    assert.equal(result.categories[AgentPolicyCategory.Browse], AgentPolicyDecision.Deny);
    assert.equal(result.maxAttempts, 1);
  });

  test('recursive delegation depth limits remain enforced after intersection', () => {
    const platform = policy('custom', {}, { maxDelegationDepth: 10 });
    const workspace = policy('custom', {}, { maxDelegationDepth: 5 });
    const parentPolicy = policy('custom', {}, { maxDelegationDepth: 2 });
    const parent = {
      policy: parentPolicy,
      source: { kind: 'parent_run' as const, parentRunId: 'p1', parentAttemptId: 'a1' },
    };

    const result = computeEffectiveRunPermission({
      platform, workspace, parent, definition: null, spawn: null,
    });

    assert.equal(result.maxDelegationDepth, 2);
  });
});

// ---------------------------------------------------------------------------
// Tests: intersectPermissionPolicies with parent field
// ---------------------------------------------------------------------------

describe('intersectPermissionPolicies with parent field', () => {
  test('parent field is optional and backward compatible', () => {
    const platform = policy();
    const workspace = policy('custom', {
      [AgentPolicyCategory.ShellExec]: AgentPolicyDecision.Ask,
    });
    const without = intersectPermissionPolicies({ platform, workspace });
    const withNull = intersectPermissionPolicies({ platform, workspace, parent: null });
    assert.deepEqual(without, withNull);
  });

  test('parent field reduces the effective decision', () => {
    const platform = policy();
    const workspace = policy();
    const parent = policy('custom', {
      [AgentPolicyCategory.SpawnAgent]: AgentPolicyDecision.Deny,
    });

    const result = intersectPermissionPolicies({ platform, workspace, parent });
    assert.equal(result.categories[AgentPolicyCategory.SpawnAgent], AgentPolicyDecision.Deny);
    assert.equal(result.categories[AgentPolicyCategory.Read], AgentPolicyDecision.Allow);
  });

  test('allow_once is not a valid decision value and cannot be injected', () => {
    // AgentPolicyDecision only has Allow, Ask, Deny. There is no AllowOnce
    // value. This test documents that allow_once cannot enter the snapshot.
    const validDecisions = Object.values(AgentPolicyDecision);
    assert.ok(!validDecisions.includes('allow_once' as any));
  });

  test('post-spawn grant changes do not alter a committed Run', () => {
    // This is a semantic/integration guarantee: once the policy is persisted
    // in effectiveDefinition, it cannot be mutated. We test that the derived
    // policy is a concrete value (preset: custom with all categories explicit).
    const platform = policy();
    const workspace = policy();
    const parent = policy('custom', {
      [AgentPolicyCategory.ShellExec]: AgentPolicyDecision.Ask,
    });

    const result = intersectPermissionPolicies({ platform, workspace, parent });
    assert.equal(result.preset, 'custom');
    // All categories are explicit in the result
    for (const category of Object.values(AgentPolicyCategory)) {
      assert.ok(category in result.categories, `${category} must be explicit in persisted policy`);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: End-to-end coordinator integration (parent snapshot)
// ---------------------------------------------------------------------------

describe('Parent permission snapshot coordinator integration', () => {
  test('delegated run from Parent Run inherits the Parent Run effective policy ceiling', async () => {
    // Import coordinator dynamically to keep this a focused unit test
    const { AgentRunCoordinator } = await import('../src/agents/runs/agentRunCoordinator');

    const parentEffective = policy('custom', {
      [AgentPolicyCategory.ShellExec]: AgentPolicyDecision.Deny,
      [AgentPolicyCategory.ExternalAction]: AgentPolicyDecision.Ask,
    }, { maxDelegationDepth: 2 });

    const hash = 'a'.repeat(64);
    const capabilityEntry = { id: 'read', kind: 'tool' as const, revision: 'v1', schemaHash: hash,
      contentHash: hash, configHash: hash, publicConfig: {}, credentialBindingIds: [] };
    const contextPolicy = { version: 1 as const, includeWorkspaceInstructions: false,
      allowMessageContext: true, allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 10_000 };
    const profile = { version: 1 as const, runtimeId: 'fake', modelId: 'model', options: {} };
    const workspacePolicy = policy();

    // Create a "parent" run in the repository that has the restricted effective policy
    const parentRunId = 'parent-run-1';

    const ports: any = {
      repository: {
        getRun(owner: string, id: string) {
          if (id === parentRunId) {
            return {
              version: 1, id: parentRunId, ownerUserId: owner, workspaceId: 'ws',
              effectiveDefinition: {
                version: 1, name: 'Parent', description: '', instructions: '',
                runtimeProfile: profile, fallbackChain: [],
                capabilitySnapshot: { version: 1, entries: [{ ...capabilityEntry }] },
                permissionPolicy: parentEffective,
                contextPolicy,
              },
              status: 'running', activeAttemptId: 'parent-attempt-1',
            };
          }
          return this._runs?.get(id) ?? null;
        },
        _runs: new Map(),
        createRun(input: any) {
          const run = {
            ...input, id: 'child-run-1', status: 'queued', latestEventSeq: 0,
            activeAttemptId: null, resultBundle: null, createdAt: 1000,
            startedAt: null, completedAt: null, archivedAt: null,
          };
          this._runs.set(run.id, run);
          return run;
        },
        listEvents() { return []; },
        claimRun() { return null; },
      },
      definitions: { get: () => null },
      capabilities: {
        assertRuntimeReady: () => {},
        resolve: () => ({ version: 1, entries: [{ ...capabilityEntry }] }),
      },
      contexts: { snapshot: async ({ manifest }: any) => manifest, cleanup: async () => {} },
      environments: {
        prepare: async () => ({
          leaseId: 'e', ownerRunId: 'op', access: 'read_only',
          snapshot: { version: 1, kind: 'shared_workspace', cwd: '/ws', sourceWorkspaceId: 'ws', snapshotHash: hash, createdAt: 1 },
          provenance: { version: 1, sourceRepositoryRoot: null, baseCommit: null, stagedPatchHash: null, unstagedPatchHash: null, untrackedFiles: [], skippedSensitivePaths: [] },
          buildChangeSet: async () => null, cleanup: async () => ({ removed: false }),
        }),
      },
      executor: { start: async () => ({ completion: Promise.resolve({ status: 'completed', resultBundle: { version: 1, status: 'completed', source: 'submitted', handoff: { conclusion: 'Done', artifactsOrChanges: '', unresolvedIssues: '' }, artifacts: [], resourceMutations: [], externalActions: [] } }), input: async () => {}, cancel: async () => {} }) },
      workspaces: { resolve: () => ({ cwd: '/ws', permissionPolicy: workspacePolicy }) },
      notifier: { notify: async () => {} },
      parentSink: { deliver: async () => 'delivered' },
      resourceCleaner: { cleanup: async () => {} },
      clock: { now: () => 1000, setTimeout: () => {}, clearTimeout: () => {} },
      instanceId: 'test-1',
      nextId: (() => { let n = 0; return () => `id-${++n}`; })(),
      platformPermissionPolicy: policy(),
      maxRunTtlMs: 10_000_000,
    };

    const coordinator = new AgentRunCoordinator(ports);
    const childRun = await coordinator.spawn({
      operationId: 'op-1', ownerUserId: 'owner', workspaceId: 'ws',
      definitionId: null,
      ephemeralDefinition: {
        version: 1, name: 'Child', description: 'Child worker', instructions: 'Do work',
        runtimeProfile: profile, fallbackChain: [],
        capabilitySnapshot: { version: 1, entries: [{ ...capabilityEntry }] },
        permissionPolicy: policy(), // definition says "allow all"
        contextPolicy,
      },
      invocationMode: 'delegated',
      completionMode: 'wait' as any,
      parentRunId, parentAttemptId: 'parent-attempt-1',
      parentNodeId: null, parentTurnId: null, parentMessageId: null, parentToolCallId: null,
      task: 'Do delegated work',
      contextManifest: { version: 1, entries: [], assembledAt: 1, estimatedChars: 0 },
      permissionRestriction: null,
      environment: { version: 1, kind: 'auto' } as any,
      expectedResult: null, runTtlMs: null,
    });

    // The child's effective policy should be constrained by the parent's ceiling
    const childPolicy = childRun.effectiveDefinition.permissionPolicy;
    assert.equal(childPolicy.categories[AgentPolicyCategory.ShellExec], AgentPolicyDecision.Deny);
    assert.equal(childPolicy.categories[AgentPolicyCategory.ExternalAction], AgentPolicyDecision.Ask);
    assert.equal(childPolicy.maxDelegationDepth, 2);
  });
});
