import type { AgentRuntimeOption } from '../services/api';
import { RESTRICTED_RUNTIME_BUILD } from '../state/featureFlags';

const RESTRICTED_RUNTIME_IDS = new Set(['kiro', 'claude', 'codex', 'pi']);

/**
 * Restricted builds keep every backend runtime registered, but only
 * expose the approved runtime choices in the UI. Public builds are unchanged.
 */
export function filterVisibleRuntimes(
  runtimes: readonly AgentRuntimeOption[],
  restrictedBuild = RESTRICTED_RUNTIME_BUILD,
): AgentRuntimeOption[] {
  if (!restrictedBuild) return [...runtimes];
  return runtimes.filter((runtime) =>
    RESTRICTED_RUNTIME_IDS.has(runtime.id.trim().toLowerCase()),
  );
}
