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
  const options = resolveReasoningOptions(caps, model, provider, binding.reasoning);
  // The runtime has an effort control, but the effective model explicitly
  // opts out (e.g. Kiro's `auto` router). The picker shows the control
  // disabled with an explanation instead of hiding it.
  const unsupportedByModel = !!caps?.reasoning && options.levels.length === 0
    && provider?.supportsReasoning !== false && (
      model?.supportsReasoning === false
      || (Array.isArray(model?.supportedReasoningLevels) && model.supportedReasoningLevels.length === 0)
    );
  return {
    ...options,
    known: caps != null,
    unsupportedByModel,
    /** Effective model id, which may be the runtime default when the binding is unset. */
    effectiveModelId: model?.id,
  };
}
