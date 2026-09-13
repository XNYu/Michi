import { resolveReasoningOptions } from 'michi-shared';
import type { AgentCapabilities, AgentModelInfo, AgentProviderInfo, AgentStatus } from '../../services/api';
import type { ResolvedNodeBinding } from '../../state/nodeBindingResolution';

export function resolveComposerReasoning(
  binding: ResolvedNodeBinding,
  status: AgentStatus | null,
  capabilities: AgentCapabilities | null,
  models: readonly AgentModelInfo[],
  providers: readonly AgentProviderInfo[] = [],
) {
  const caps = capabilities ?? (binding.runtime === status?.runtime ? status.capabilities : null);
  const providerList = providers.length ? providers : binding.runtime === status?.runtime ? status.providers : undefined;
  const provider = providerList?.find((entry) => entry.id === binding.provider);
  const model = binding.model ? models.find((entry) => entry.id === binding.model)
    : models.find((entry) => entry.id === provider?.defaultModel) ?? models.find((entry) => entry.isDefault) ?? models[0];
  return { ...resolveReasoningOptions(caps, model, provider, binding.reasoning), known: caps != null };
}
