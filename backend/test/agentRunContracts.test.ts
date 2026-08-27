import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { 
  AgentRunStatus, 
  AgentRunValidators, 
  AgentRunSseEnvelopeV1, 
  AgentRunDtoV1 
} from '../../shared/src/agentRuns';

describe('Agent Run Contracts', () => {
  test('AgentRunValidators.validateStatus accepts valid statuses', () => {
    assert.ok(AgentRunValidators.validateStatus(AgentRunStatus.Running));
    assert.ok(AgentRunValidators.validateStatus(AgentRunStatus.Completed));
    assert.ok(AgentRunValidators.validateStatus(AgentRunStatus.Failed));
    assert.ok(AgentRunValidators.validateStatus(AgentRunStatus.Terminal));
  });

  test('AgentRunValidators.validateStatus rejects invalid statuses', () => {
    assert.strictEqual(AgentRunValidators.validateStatus('unknown'), false);
    assert.strictEqual(AgentRunValidators.validateStatus(123), false);
    assert.strictEqual(AgentRunValidators.validateStatus(null), false);
  });

  test('AgentRunValidators.validateDefinitionStatus accepts valid definition statuses', () => {
    assert.ok(AgentRunValidators.validateDefinitionStatus('Draft'));
    assert.ok(AgentRunValidators.validateDefinitionStatus('Enabled'));
    assert.ok(AgentRunValidators.validateDefinitionStatus('Disabled'));
  });

  test('AgentRunValidators.validateDefinitionStatus rejects invalid definition statuses', () => {
    assert.strictEqual(AgentRunValidators.validateDefinitionStatus('Running'), false);
    assert.strictEqual(AgentRunValidators.validateDefinitionStatus(''), false);
  });

  test('AgentRunValidators.validateTtl accents valid numbers', () => {
    assert.ok(AgentRunValidators.validateTtl(3600));
    assert.ok(AgentRunValidators.validateTtl(0));
    assert.strictEqual(AgentRunValidators.validateTtl(-1), false);
    assert.strictEqual(AgentRunValidators.validateTtl('3600'), false);
  });

  test('JSON round-trip for AgentRunDtoV1', () => {
    const original: AgentRunDtoV1 = {
      id: 'run-123',
      definitionId: 'def-abc',
      definitionSnapshot: {
        id: 'def-abc',
        ownerId: 'user-1',
        workspaceId: 'ws-1',
        name: 'Test Agent',
        instructions: 'Do things',
        runtimeProfile: {
          runtimeId: 'pi',
          modelId: 'pi-v1',
          version: '1.0',
          config: {},
          fingerprint: 'fp-1',
        },
        capabilities: ['web_search'],
        status: 'Enabled',
        revision: 1,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      ownerId: 'user-1',
      workspaceId: 'ws-1',
      status: AgentRunStatus.Running,
      currentAttemptId: 'att-1',
      expiresAt: '2026-12-31T23:59:59Z',
      createdAt: '2026-01-01T10:00:00Z',
      updatedAt: '2026-01-01T10:05:00Z',
    };

    const json = JSON.stringify(original);
    const parsed = JSON.parse(json);
    assert.deepEqual(parsed, original);
  });

  test('JSON round-trip for AgentRunSseEnvelopeV1', () => {
    const original: AgentRunSseEnvelopeV1 = {
      event: 'status_change',
      data: { status: AgentRunStatus.Completed },
      timestamp: '2026-01-01T10:10:00Z',
      cursor: 42,
    };

    const json = JSON.stringify(original);
    const parsed = JSON.parse(json);
    assert.deepEqual(parsed, original);
  });
});
