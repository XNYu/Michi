import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResultBundleV1 } from 'michi-shared';
import { createRunResultCollector, discoverRunWorkerTools, SUBMIT_AGENT_RESULT_TOOL } from '../src/agents/runs/runWorkerTools';

const owner = { kind: 'agent_run' as const, runId: 'run-1', attemptId: 'attempt-1' };

function bundle(conclusion = 'done'): ResultBundleV1 {
  return {
    version: 1, status: 'completed', source: 'inferred',
    handoff: { conclusion, artifactsOrChanges: '', unresolvedIssues: '' },
    artifacts: [], resourceMutations: [], externalActions: [],
  };
}

test('submit_agent_result is discoverable only by Agent Run owners', () => {
  assert.deepEqual(discoverRunWorkerTools(owner), [SUBMIT_AGENT_RESULT_TOOL]);
  assert.deepEqual(discoverRunWorkerTools({ kind: 'chat_node', nodeId: 'node-1' }), []);
  assert.throws(() => createRunResultCollector({ kind: 'chat_node', nodeId: 'node-1' }), /only to Agent Run/);
});

test('structured submission wins, is source-normalized, and identical retries are idempotent', () => {
  const collector = createRunResultCollector(owner);
  const submitted = collector.submit(owner, bundle('structured'));
  assert.equal(submitted.source, 'submitted');
  assert.strictEqual(collector.submit(owner, bundle('structured')), submitted);
  assert.strictEqual(collector.finalize('fallback text'), submitted);
  assert.throws(() => collector.submit(owner, bundle('different')), /different Result Bundle/);
});

test('submission rejects wrong owners, malformed bundles, and secret-bearing payloads', () => {
  const collector = createRunResultCollector(owner);
  assert.throws(() => collector.submit({ kind: 'agent_run', runId: 'run-1', attemptId: 'attempt-2' }, bundle()), /owner does not match/);
  assert.throws(() => collector.submit(owner, { version: 1 }), /handoff/);
  assert.throws(() => collector.submit(owner, { ...bundle(), structuredResult: { apiKey: 'secret' } }), /secret-bearing fields/);
});

test('fallback inference includes recorded receipts, artifacts, change set, and usage', () => {
  const collector = createRunResultCollector(owner);
  collector.recordArtifact({ id: 'a1', name: 'report', kind: 'file', uri: 'artifact://a1', sha256: null, size: 12 });
  collector.recordResourceMutation({ id: 'm1', kind: 'file_write', summary: 'updated file', idempotencyKey: null, details: null });
  collector.recordExternalAction({ id: 'e1', kind: 'issue', summary: 'opened issue', idempotencyKey: 'k1', details: null, provider: 'tracker', externalId: '42' });
  collector.recordChangeSet({ baseCommit: 'abc', snapshotHash: 'a'.repeat(64), worktreeId: 'wt1', changedFiles: ['a.ts'], summary: 'one file changed', diffArtifactId: null });
  collector.recordUsage({ inputTokens: 10, outputTokens: 4 });
  const result = collector.finalize('Final assistant answer');
  assert.equal(result.source, 'inferred');
  assert.equal(result.handoff.conclusion, 'Final assistant answer');
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.resourceMutations.length, 1);
  assert.equal(result.externalActions.length, 1);
  assert.equal(result.changeSet?.worktreeId, 'wt1');
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 4 });
});
