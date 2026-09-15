import { setTimeout as delay } from 'node:timers/promises';
import type { AgentRuntime, AgentSession, LoadAgentSessionOptions } from '../agents/types';
import { dropSession, getSession } from '../agents/sessionRegistry';

export function nativeResumeId(runtimeId: string, binding: { id?: string; acp_session_id?: string | null; external_session_id?: string | null } | null | undefined): string | null {
  const id = (runtimeId === 'claude' || runtimeId === 'codex'
    ? binding?.external_session_id ?? binding?.acp_session_id
    : binding?.acp_session_id ?? binding?.external_session_id) ?? null;
  // Claude has no native identity until init. Its public node placeholder is
  // not a resumable CLI session, even though it occupies the legacy ACP column.
  return runtimeId === 'claude' && id === binding?.id ? null : id;
}

/** Only adapters with positive evidence of unavailable native state may throw this. */
export class NativeResumeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativeResumeUnavailableError';
  }
}

export class NativeResumeFailedError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown, message = 'Native session restore could not complete. The original session binding has been retained. Please retry; check the runtime connection and authentication if this persists.') {
    super(message);
    this.name = 'NativeResumeFailedError';
    this.cause = cause;
  }
}

// Foreground, background and explicit load paths must read the binding inside
// this lock, and keep it until registration AND durable persistence complete.
const restores = new Map<string, Promise<void>>();

export async function acquireSessionRestoreLock(nodeId: string): Promise<() => void> {
  const previous = restores.get(nodeId);
  let resolve!: () => void;
  const current = new Promise<void>((done) => { resolve = done; });
  restores.set(nodeId, current);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (restores.get(nodeId) === current) restores.delete(nodeId);
    resolve();
  };
}

/** Null permits compatible reconstruction; every other failure retains the binding. */
export async function loadNativeSession(
  runtime: AgentRuntime,
  options: LoadAgentSessionOptions,
  expectedNativeId?: string | null,
): Promise<AgentSession | null> {
  if (!runtime.capabilities.nativeResume || !runtime.loadSession) return null;
  for (let attempt = 0; ; attempt++) {
    try {
      const session = await runtime.loadSession(options);
      if (expectedNativeId && (session.nativeSessionId ?? session.id) !== expectedNativeId) {
        try { await runtime.releaseSession(session.id); } catch { /* best-effort teardown */ } finally {
          if (getSession(session.id) === session) dropSession(session.id);
        }
        throw new NativeResumeFailedError(new Error('Native restore returned a different session identity'));
      }
      return session;
    } catch (error) {
      if (error instanceof NativeResumeFailedError) throw error;
      if (error instanceof NativeResumeUnavailableError) return null;
      if (attempt >= 2 || !runtime.isNativeResumeRetryable?.(error)) {
        throw new NativeResumeFailedError(error);
      }
      await delay(100 * 2 ** attempt);
    }
  }
}
