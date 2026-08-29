import { AgentRunStatus, type AgentRunDtoV1, type RecoveryEnvelopeV1, type StructuredRunErrorV1 } from 'michi-shared';

export interface RetryPlan {
  action: 'retry' | 'fallback' | 'wait' | 'fail';
  profileIndex: number;
  recoveryEnvelope: RecoveryEnvelopeV1 | null;
}

function latestProfileIndex(attempts: Array<{ profileIndex: number }>): number {
  return attempts.length ? attempts[attempts.length - 1].profileIndex : 0;
}

/** Retry/fallback is forbidden after an unreceipted mutation. The recovery
 * envelope's resource state is intentionally generic, so adapters stamp the
 * conservative `unreceiptedSideEffect` flag when replay safety is unknown. */
export function planAgentRunRecovery(input: {
  run: AgentRunDtoV1;
  attempts: Array<{ profileIndex: number }>;
  error: StructuredRunErrorV1;
  recoveryEnvelope: RecoveryEnvelopeV1 | null;
}): RetryPlan {
  const maxAttempts = input.run.effectiveDefinition.permissionPolicy.maxAttempts;
  if (input.attempts.length >= maxAttempts) return { action: 'fail', profileIndex: latestProfileIndex(input.attempts), recoveryEnvelope: input.recoveryEnvelope };
  const state = input.recoveryEnvelope?.currentResourceState;
  const unsafe = !!state && !Array.isArray(state) && typeof state === 'object'
    && (state as Record<string, unknown>).unreceiptedSideEffect === true;
  if (unsafe || input.error.category === 'unsafe_recovery') {
    return { action: 'wait', profileIndex: latestProfileIndex(input.attempts), recoveryEnvelope: input.recoveryEnvelope };
  }
  if (!input.error.retryable) return { action: 'fail', profileIndex: latestProfileIndex(input.attempts), recoveryEnvelope: input.recoveryEnvelope };
  const current = latestProfileIndex(input.attempts);
  if (input.error.category === 'capacity' || input.error.category === 'incompatible' || input.error.category === 'auth_permission') {
    if (current < input.run.effectiveDefinition.fallbackChain.length) {
      return { action: 'fallback', profileIndex: current + 1, recoveryEnvelope: input.recoveryEnvelope };
    }
  }
  return { action: 'retry', profileIndex: current, recoveryEnvelope: input.recoveryEnvelope };
}

export function startupRecoveryAction(run: AgentRunDtoV1): 'claim' | 'resume_waiting' | 'audit_terminal' | 'ignore' {
  if (run.status === AgentRunStatus.Queued || run.status === AgentRunStatus.Recovering) return 'claim';
  if (run.status === AgentRunStatus.Waiting) return 'resume_waiting';
  if ([AgentRunStatus.Completed, AgentRunStatus.Failed, AgentRunStatus.Cancelled].includes(run.status)) return 'audit_terminal';
  if (run.status === AgentRunStatus.Preparing || run.status === AgentRunStatus.Running) return 'claim';
  return 'ignore';
}
