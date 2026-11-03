import type { SelfUpdateCheck, SelfUpdateJob, SelfUpdateStatus } from 'michi-shared';
import { API_BASE_URL } from '../../config/env';

/** An error response from /self-update, with what the backend attached (a fresh check, the running job). */
export class SelfUpdateRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly check?: SelfUpdateCheck, readonly job?: SelfUpdateJob | null) {
    super(message);
  }
}

// The backend this page came from. Plain fetch: while it restarts, a failed
// request must not mark the connection unavailable for the rest of the app.
async function request<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 15_000, signal, ...rest } = init;
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...rest,
    signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new SelfUpdateRequestError(typeof body.error === 'string' ? body.error : `Update request failed (HTTP ${response.status}).`,
      response.status, typeof body.code === 'string' ? body.code : undefined,
      body.check as SelfUpdateCheck | undefined, body.job as SelfUpdateJob | null | undefined);
  }
  return body as T;
}

export const fetchSelfUpdate = (signal?: AbortSignal) => request<SelfUpdateStatus>('/self-update', { signal, timeoutMs: 8000 });

/** Fetches the source branch on the machine; can take a while over SSH. */
export const checkSelfUpdate = (signal?: AbortSignal) => request<SelfUpdateCheck>('/self-update/check', { method: 'POST', signal, timeoutMs: 120_000 });

export async function startSelfUpdate(revision: string, signal?: AbortSignal): Promise<SelfUpdateJob> {
  const body = await request<{ job: SelfUpdateJob }>('/self-update/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision }), signal, timeoutMs: 120_000,
  });
  return body.job;
}
