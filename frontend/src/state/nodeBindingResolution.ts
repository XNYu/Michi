import type { ChatNodeState } from './chatTypes';
import type { AgentReasoning, AgentStatus, RuntimeId } from '../services/api';

/**
 * Resolved runtime/model/reasoning for a pane, with a `source` hint for UI
 * styling (e.g. dashed border on global defaults vs solid on node binding).
 */
export interface ResolvedNodeBinding {
  runtime: RuntimeId;
  provider: string | undefined;
  model: string | undefined;
  reasoning: AgentReasoning | undefined;
  /** 'pending' when the user has changed a chip but hasn't sent yet. */
  source: 'node' | 'global' | 'pending';
}

/**
 * Ephemeral per-pane override: set when the user picks a different
 * runtime/model/effort in the composer chips before sending a message.
 * Cleared (consumed) by sendMessage after it passes the values to the backend.
 */
export interface PendingNodeBindingOverride {
  runtime?: RuntimeId;
  provider?: string;
  model?: string;
  reasoning?: AgentReasoning;
}

/**
 * Three-level priority resolution:
 *   1. `pendingOverride` — user has changed a chip in this pane but hasn't sent yet
 *   2. Node's persisted binding — what this node actually used last time
 *   3. Global `agentStatus` — fallback for new/unbound nodes
 *
 * When the pending override or node only specifies `runtime` but not
 * `model`/`reasoning`, those fields fall through to the global defaults
 * ONLY if the runtime matches. Otherwise they're left undefined — the
 * caller should fetch the new runtime's catalog to populate them.
 */
export function resolveNodeBinding(
  node: ChatNodeState | null | undefined,
  agentStatus: AgentStatus | null | undefined,
  pendingOverride?: PendingNodeBindingOverride | null,
): ResolvedNodeBinding {
  const effectiveRuntime =
    pendingOverride?.runtime ??
    node?.runtimeId ??
    agentStatus?.runtime ??
    'kiro';

  // provider/model/reasoning: only inherit from agentStatus if the runtime
  // is the same as the global one. Otherwise the values would be from a
  // different runtime and would be invalid.
  const runtimeMatchesGlobal = effectiveRuntime === agentStatus?.runtime;

  const effectiveProvider =
    pendingOverride?.provider ??
    node?.providerId ??
    (runtimeMatchesGlobal ? agentStatus?.provider : undefined) ??
    undefined;

  const effectiveModel =
    pendingOverride?.model ??
    node?.modelId ??
    (runtimeMatchesGlobal ? agentStatus?.model : undefined) ??
    undefined;

  const effectiveReasoning =
    pendingOverride?.reasoning ??
    (node?.reasoning as AgentReasoning | undefined) ??
    (runtimeMatchesGlobal ? agentStatus?.reasoning : undefined) ??
    undefined;

  const source: ResolvedNodeBinding['source'] =
    pendingOverride?.runtime || pendingOverride?.model || pendingOverride?.reasoning
      ? 'pending'
      : node?.runtimeId
        ? 'node'
        : 'global';

  return {
    runtime: effectiveRuntime,
    provider: effectiveProvider,
    model: effectiveModel,
    reasoning: effectiveReasoning,
    source,
  };
}
