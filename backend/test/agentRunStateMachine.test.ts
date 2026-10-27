import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunStatus, AgentRunWaitingReason } from 'michi-shared';
import { assertAgentRunTransition, assertAttemptTransition, assertWaitingProjection } from '../src/agents/runs/agentRunStateMachine';

import { contextManifestHash, normalizeContextManifest } from '../src/agents/runs/contextManifest';

describe('Agent Run pure domain modules', () => {
  test('state machine permits documented transitions and rejects terminal rewrites', () => {
    assert.doesNotThrow(() => assertAgentRunTransition(AgentRunStatus.Running, AgentRunStatus.Completed));
    assert.throws(() => assertAgentRunTransition(AgentRunStatus.Completed, AgentRunStatus.Running), /invalid/);
    assert.doesNotThrow(() => assertAttemptTransition('running', 'waiting'));
    assert.throws(() => assertAttemptTransition('failed', 'running'), /already terminal/);
    assert.doesNotThrow(() => assertWaitingProjection(AgentRunStatus.Waiting, AgentRunWaitingReason.Permission));
    assert.throws(() => assertWaitingProjection(AgentRunStatus.Running, AgentRunWaitingReason.Context));
  });

  test('context manifests reject duplicate durable identities and hash deterministically', () => {
    const manifest = { version: 1 as const, assembledAt: 1, estimatedChars: 3,
      entries: [{ kind: 'summary' as const, label: 'one', content: 'abc', sha256: 'a'.repeat(64) }] };
    assert.equal(contextManifestHash(manifest), contextManifestHash(normalizeContextManifest(manifest)));
    assert.throws(() => normalizeContextManifest({ ...manifest, entries: [...manifest.entries, ...manifest.entries] }), /duplicate/);
  });
});
