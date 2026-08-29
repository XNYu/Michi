import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunStatus, type AgentRunDtoV1, type RecoveryEnvelopeV1, type StructuredRunErrorV1 } from 'michi-shared';
import { planAgentRunRecovery, startupRecoveryAction } from '../src/agents/runs/agentRunRecovery';

function run(status = AgentRunStatus.Running): AgentRunDtoV1 {
  return { status, effectiveDefinition: { fallbackChain: [{}], permissionPolicy: { maxAttempts: 3 } } } as AgentRunDtoV1;
}

function error(category: StructuredRunErrorV1['category'], retryable = true): StructuredRunErrorV1 {
  return { version: 1, code: category, category, message: category, retryable };
}

describe('Agent Run recovery planning', () => {
  test('uses ordered fallback for capacity/incompatible failures', () => {
    const plan = planAgentRunRecovery({ run: run(), attempts: [{ profileIndex: 0 }],
      error: error('capacity'), recoveryEnvelope: null });
    assert.deepEqual(plan, { action: 'fallback', profileIndex: 1, recoveryEnvelope: null });
  });

  test('unsafe unreceipted side effects wait instead of replaying', () => {
    const envelope = { version: 1, completedWork: 'mutation sent', currentResourceState: { unreceiptedSideEffect: true },
      outstandingWork: 'verify effect', failureBoundary: error('transient'), resultBundleDraft: null } as RecoveryEnvelopeV1;
    assert.equal(planAgentRunRecovery({ run: run(), attempts: [{ profileIndex: 0 }],
      error: error('transient'), recoveryEnvelope: envelope }).action, 'wait');
  });

  test('attempt ceiling and terminal errors fail without another executor', () => {
    assert.equal(planAgentRunRecovery({ run: run(), attempts: [{ profileIndex: 0 }, { profileIndex: 0 }, { profileIndex: 0 }],
      error: error('transient'), recoveryEnvelope: null }).action, 'fail');
    assert.equal(planAgentRunRecovery({ run: run(), attempts: [{ profileIndex: 0 }],
      error: error('terminal', false), recoveryEnvelope: null }).action, 'fail');
  });

  test('startup audit distinguishes claimable, waiting, and terminal Runs', () => {
    assert.equal(startupRecoveryAction(run(AgentRunStatus.Recovering)), 'claim');
    assert.equal(startupRecoveryAction(run(AgentRunStatus.Waiting)), 'resume_waiting');
    assert.equal(startupRecoveryAction(run(AgentRunStatus.Completed)), 'audit_terminal');
  });
});
