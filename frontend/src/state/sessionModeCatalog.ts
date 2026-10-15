import type { AgentSessionState } from 'michi-shared';
import type { SessionMode } from '../services/api';

export function sessionModeCatalog(state: AgentSessionState | undefined, fallback: SessionMode[], catalogRuntimeId?: string): SessionMode[] {
  // Kiro's catalog is global. A transient empty session snapshot must not
  // hide the loaded workspace catalog; other runtimes can be session-scoped.
  if (state?.runtimeId === 'kiro' && catalogRuntimeId === 'kiro' && state.availableModes?.length === 0) return fallback;
  return state?.availableModes ?? fallback;
}
