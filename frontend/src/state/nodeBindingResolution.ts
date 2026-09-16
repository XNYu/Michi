import type { ChatNodeState } from './chatTypes';
import type { AgentProviderInfo, AgentReasoning, AgentStatus, RuntimeId } from '../services/api';

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
 * ONLY if the runtime matches. Otherwise they fall back to the per-runtime
 * memory in `agentStatus.providerByRuntime` / `modelByRuntime` /
 * `reasoningByRuntime` (what the user last used with that runtime), and are
 * left undefined when there is no memory — the caller should then fetch the
 * new runtime's catalog to populate them.
 */
export function resolveNodeBinding(
  node: ChatNodeState | null | undefined,
  agentStatus: AgentStatus | null | undefined,
  pendingOverride?: PendingNodeBindingOverride | null,
  providers?: readonly AgentProviderInfo[],
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

  // Node-level fields only apply while the node's own runtime is still the
  // effective one. A pending runtime override must NOT inherit the previous
  // runtime's provider/model/reasoning — those ids belong to another runtime.
  const nodeMatchesRuntime = node?.runtimeId
    ? effectiveRuntime === node.runtimeId
    : runtimeMatchesGlobal;

  // Per-runtime memory: the provider/model/reasoning last used with this
  // runtime (written by the backend on every send and on Settings saves).
  // Lets a pane switched to a different runtime land on the user's last
  // choice instead of an empty "Default provider" that resolves to the
  // built-in fallback. modelByRuntime is recorded alongside providerByRuntime,
  // so it is only trusted when the remembered provider is the effective one.
  const rememberedProvider = agentStatus?.providerByRuntime?.[effectiveRuntime];
  const rememberedModel = agentStatus?.modelByRuntime?.[effectiveRuntime];
  const rememberedReasoning = agentStatus?.reasoningByRuntime?.[effectiveRuntime];

  const effectiveProvider =
    pendingOverride?.provider ??
    (nodeMatchesRuntime ? node?.providerId : undefined) ??
    (runtimeMatchesGlobal ? agentStatus?.provider : undefined) ??
    rememberedProvider ??
    undefined;

  // Models are provider-scoped for provider runtimes (e.g. Pi): a model bound
  // under a different provider is not valid for the newly selected provider.
  const nodeProviderMatches = !node?.providerId || node.providerId === effectiveProvider;
  const globalProviderMatches = !agentStatus?.provider || agentStatus.provider === effectiveProvider;
  const rememberedProviderMatches = !rememberedProvider || rememberedProvider === effectiveProvider;

  const selectedProvider = (providers ?? (runtimeMatchesGlobal ? agentStatus?.providers : undefined))
    ?.find((provider) => provider.id === effectiveProvider);
  const effectiveModel = selectedProvider?.modelLocked ? selectedProvider.defaultModel : (
    pendingOverride?.model ??
    (nodeMatchesRuntime && nodeProviderMatches ? node?.modelId : undefined) ??
    (runtimeMatchesGlobal && globalProviderMatches ? agentStatus?.model : undefined) ??
    (rememberedProviderMatches ? rememberedModel : undefined) ??
    undefined);

  const effectiveReasoning =
    pendingOverride?.reasoning ??
    (nodeMatchesRuntime ? (node?.reasoning as AgentReasoning | undefined) : undefined) ??
    (runtimeMatchesGlobal ? agentStatus?.reasoning : undefined) ??
    rememberedReasoning ??
    undefined;

  const source: ResolvedNodeBinding['source'] =
    pendingOverride?.runtime || pendingOverride?.provider || pendingOverride?.model || pendingOverride?.reasoning
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
