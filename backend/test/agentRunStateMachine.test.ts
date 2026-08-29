import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentPolicyCategory,
  AgentPolicyDecision,
  AgentRunStatus,
  AgentRunWaitingReason,
  type AgentPermissionPolicyV1,
  type ResultBundleV1,
} from 'michi-shared';
import { assertAgentRunTransition, assertAttemptTransition, assertWaitingProjection } from '../src/agents/runs/agentRunStateMachine';
import { intersectPermissionPolicies } from '../src/agents/runs/effectivePermissionPolicy';
import { contextManifestHash, normalizeContextManifest } from '../src/agents/runs/contextManifest';
import { compactResultHandoff, normalizeResultBundle } from '../src/agents/runs/resultBundle';

function policy(decision: AgentPolicyDecision, maxAttempts = 3): AgentPermissionPolicyV1 {
  return { version: 1, preset: 'custom', categories: Object.fromEntries(Object.values(AgentPolicyCategory).map((key) => [key, decision])),
    maxDelegationDepth: 4, maxConcurrentRuns: 4, maxWallTimeMs: 10_000, maxAttempts, maxTokens: null, maxSpendMicros: null };
}

describe('Agent Run pure domain modules', () => {
  test('state machine permits documented transitions and rejects terminal rewrites', () => {
    assert.doesNotThrow(() => assertAgentRunTransition(AgentRunStatus.Running, AgentRunStatus.Completed));
    assert.throws(() => assertAgentRunTransition(AgentRunStatus.Completed, AgentRunStatus.Running), /invalid/);
    assert.doesNotThrow(() => assertAttemptTransition('running', 'waiting'));
    assert.throws(() => assertAttemptTransition('failed', 'running'), /already terminal/);
    assert.doesNotThrow(() => assertWaitingProjection(AgentRunStatus.Waiting, AgentRunWaitingReason.Permission));
    assert.throws(() => assertWaitingProjection(AgentRunStatus.Running, AgentRunWaitingReason.Context));
  });

  test('effective permission policy is the strict intersection of every ceiling', () => {
    const effective = intersectPermissionPolicies({
      platform: policy(AgentPolicyDecision.Allow, 5),
      workspace: policy(AgentPolicyDecision.Ask, 4),
      definition: policy(AgentPolicyDecision.Deny, 3),
    });
    assert.equal(effective.categories[AgentPolicyCategory.ShellExec], AgentPolicyDecision.Deny);
    assert.equal(effective.maxAttempts, 3);
  });

  test('context manifests reject duplicate durable identities and hash deterministically', () => {
    const manifest = { version: 1 as const, assembledAt: 1, estimatedChars: 3,
      entries: [{ kind: 'summary' as const, label: 'one', content: 'abc', sha256: 'a'.repeat(64) }] };
    assert.equal(contextManifestHash(manifest), contextManifestHash(normalizeContextManifest(manifest)));
    assert.throws(() => normalizeContextManifest({ ...manifest, entries: [...manifest.entries, ...manifest.entries] }), /duplicate/);
  });

  test('Result Bundle normalization creates the compact Parent handoff', () => {
    const bundle: ResultBundleV1 = { version: 1, status: 'completed', source: 'submitted',
      handoff: { conclusion: 'Done', artifactsOrChanges: 'Changed A', unresolvedIssues: '' },
      artifacts: [], resourceMutations: [], externalActions: [] };
    assert.deepEqual(normalizeResultBundle(bundle), bundle);
    assert.equal(compactResultHandoff(bundle), 'Done\nChanged A');
  });
});
