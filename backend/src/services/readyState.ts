/**
 * Module-scope warm status for the backend. Written exactly once by
 * server.ts when the active runtime warm resolves or rejects; read by
 * /api/ready. Intentionally NOT a class or singleton getter — keeping
 * it as plain functions over a closure variable means /api/ready can
 * never accidentally call into AgentRuntime methods.
 */

export type WarmStatus = 'pending' | 'ready' | 'failed';

let status: WarmStatus = 'pending';
let error: string | null = null;

export function getWarmStatus(): { status: WarmStatus; error: string | null } {
  return { status, error };
}

export function markReady(): void {
  if (status !== 'pending') return; // write-once
  status = 'ready';
}

export function markFailed(err: Error): void {
  if (status !== 'pending') return; // write-once
  status = 'failed';
  error = err.message;
}

/** Test-only — reset between unit tests. Do NOT call from production code. */
export function __resetWarmStatusForTest(): void {
  status = 'pending';
  error = null;
}
