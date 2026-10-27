import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentDefinitionDtoV1, AgentDefinitionStatus, AgentRunCompletionMode, AgentRunContractError, AgentRunDtoV1, AgentPolicyCategory, AgentPolicyDecision, AgentRunInvocationMode, AgentRunStatus, MAX_RUN_TTL_MS, MIN_RUN_TTL_MS, parseRunTtl } from 'michi-shared';

const hash = 'a'.repeat(64);
const now = 1_787_827_200_000;
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
  test('preserves null retention and rejects TTLs outside policy', () => {
    assert.equal(parseRunTtl(null), null);
    assert.equal(parseRunTtl(MIN_RUN_TTL_MS), MIN_RUN_TTL_MS);
    assert.equal(parseRunTtl(MAX_RUN_TTL_MS), MAX_RUN_TTL_MS);
    rejects(() => parseRunTtl(0), /runTtlMs/);
    rejects(() => parseRunTtl(MIN_RUN_TTL_MS - 1), /runTtlMs/);
    rejects(() => parseRunTtl(MAX_RUN_TTL_MS + 1), /runTtlMs/);
  });
});
