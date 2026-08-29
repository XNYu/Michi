import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunStatus, MIN_RUN_TTL_MS, type AgentRunDtoV1 } from 'michi-shared';
import { AgentRunRetention, deriveRunExpiresAt } from '../src/agents/runs/agentRunRetention';

describe('Agent Run retention', () => {
  test('manual override may replace the Definition default within the platform ceiling', () => {
    assert.equal(deriveRunExpiresAt({ now: 1_000, invocationMode: 'manual', requestedTtlMs: 4 * MIN_RUN_TTL_MS,
      definitionDefaultTtlMs: 2 * MIN_RUN_TTL_MS, platformMaxTtlMs: 10 * MIN_RUN_TTL_MS }), 1_000 + 4 * MIN_RUN_TTL_MS);
  });

  test('delegated Parent may only shorten a finite Definition retention ceiling', () => {
    assert.equal(deriveRunExpiresAt({ now: 1_000, invocationMode: 'delegated', requestedTtlMs: 4 * MIN_RUN_TTL_MS,
      definitionDefaultTtlMs: 2 * MIN_RUN_TTL_MS, platformMaxTtlMs: 10 * MIN_RUN_TTL_MS }), 1_000 + 2 * MIN_RUN_TTL_MS);
    assert.equal(deriveRunExpiresAt({ now: 1_000, invocationMode: 'delegated', requestedTtlMs: null,
      definitionDefaultTtlMs: null, platformMaxTtlMs: 10 * MIN_RUN_TTL_MS }), null);
  });

  test('expired active/waiting Runs remain durable and searchable', () => {
    const retention = new AgentRunRetention({} as any, { cleanup: async () => {} });
    assert.equal(retention.shouldDefer({ status: AgentRunStatus.Running, expiresAt: 10 } as AgentRunDtoV1, 11), true);
    assert.equal(retention.shouldDefer({ status: AgentRunStatus.Waiting, expiresAt: 10 } as AgentRunDtoV1, 11), true);
  });

  test('terminal cleanup archives, releases resources, and deletes idempotently', async () => {
    const runs = new Map([['run-1', { id: 'run-1', status: AgentRunStatus.Completed } as AgentRunDtoV1]]);
    const archived: string[] = []; const cleaned: string[] = [];
    const repository = {
      listTtlCandidates: () => [...runs.values()],
      archiveRun: (_owner: string, id: string) => { archived.push(id); return true; },
      deleteRun: (_owner: string, id: string) => runs.delete(id),
    };
    const retention = new AgentRunRetention(repository as any, { cleanup: async (id) => { cleaned.push(id); } });
    assert.deepEqual(await retention.cleanupExpired('owner', 'ws', 100), ['run-1']);
    assert.deepEqual(await retention.cleanupExpired('owner', 'ws', 100), []);
    assert.deepEqual(archived, ['run-1']);
    assert.deepEqual(cleaned, ['run-1']);
  });
});
