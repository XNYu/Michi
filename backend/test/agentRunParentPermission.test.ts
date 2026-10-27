import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentPolicyCategory,
  AgentPolicyDecision,
  type AgentPermissionPolicyV1,
} from 'michi-shared';
import { computeEffectiveRunPermission } from '../src/agents/runs/parentPermissionSnapshot';

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

// ---------------------------------------------------------------------------
// Tests: computeEffectiveRunPermission
// ---------------------------------------------------------------------------

describe('computeEffectiveRunPermission', () => {
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
