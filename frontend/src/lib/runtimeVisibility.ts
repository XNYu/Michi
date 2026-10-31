import type { AgentRuntimeOption } from '../services/api';
import { RESTRICTED_RUNTIME_BUILD } from '../state/featureFlags';

const RESTRICTED_RUNTIME_IDS = new Set(['kiro', 'crew', 'claude', 'codex', 'pi']);

/** Filter choices without changing a backend's runtime IDs or stored bindings. */
export function filterAvailableRuntimes(runtimes: readonly AgentRuntimeOption[]): AgentRuntimeOption[] {
  return runtimes.filter((runtime) => runtime.available);
}

/**
 * Restricted builds keep every backend runtime registered, but only
 * expose the approved runtime choices in the UI. Only available runtimes are
 * offered as choices; callers retain the full catalog for existing bindings.
 */
export function filterVisibleRuntimes(
  runtimes: readonly AgentRuntimeOption[],
  restrictedBuild = RESTRICTED_RUNTIME_BUILD,
): AgentRuntimeOption[] {
  return filterAvailableRuntimes(runtimes).filter((runtime) =>
    !restrictedBuild || RESTRICTED_RUNTIME_IDS.has(runtime.id.trim().toLowerCase()),
  );
}
