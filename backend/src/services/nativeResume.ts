import { setTimeout as delay } from 'node:timers/promises';
import { NativeResumeFailedError, NativeResumeUnavailableError } from 'michi-runtime/internal/contract/errors';
import type { AgentRuntime, AgentSession, LoadAgentSessionOptions, RuntimeResumeBinding } from '../agents/types';
import { dropSession, getSession } from '../agents/sessionRegistry';
import { isNativeResumeEnabled } from './agentConfig';
import { KiroSignedOutError } from '../agents/kiro/kiroAuth';

/**
 * The native session id a node binding resumes for `runtime`. A runtime that
 * reads its own binding (AgentRuntime.resumeTokenFromBinding: Codex, Claude)
 * decides, its null included: Claude's placeholder id in the ACP column is not
 * a session. For the rest the host reads the ACP column, then the external one.
 */
export function nativeResumeIdFor(
  runtime: Pick<AgentRuntime, 'id' | 'resumeTokenFromBinding'>,
  binding: RuntimeResumeBinding | null | undefined,
): string | null {
  return runtime.resumeTokenFromBinding
    ? runtime.resumeTokenFromBinding(binding)
    : binding?.acp_session_id ?? binding?.external_session_id ?? null;
}

// The error classes are part of the runtime contract; re-exported so existing
// importers of this module keep the same class objects.
export { NativeResumeUnavailableError, NativeResumeFailedError };

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
  if (!runtime.capabilities.nativeResume || !runtime.loadSession
    || !isNativeResumeEnabled(runtime.id, options.ownerUserId)) return null;
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
      // Keep the binding, but preserve the actionable reason for the scheduler and UI.
      if (error instanceof KiroSignedOutError) throw new NativeResumeFailedError(error, error.message);
      if (error instanceof NativeResumeFailedError) throw error;
      if (error instanceof NativeResumeUnavailableError) return null;
      if (attempt >= 2 || !runtime.isNativeResumeRetryable?.(error)) {
        throw new NativeResumeFailedError(error);
      }
      await delay(100 * 2 ** attempt);
    }
  }
}
