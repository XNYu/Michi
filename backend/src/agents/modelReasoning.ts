import { resolveReasoningOptions } from 'michi-shared';
import { hasProviders, type AgentReasoning, type AgentRuntime } from './types';

export async function getModelReasoningOptions(
  runtime: AgentRuntime,
  modelId?: string | null,
  providerId?: string | null,
  requested?: AgentReasoning | null,
) {
  const providers = hasProviders(runtime) ? await runtime.listProviders() : [];
  const provider = providers.find((entry) => entry.id === providerId);
  // A locked provider ignores requested models at execution time. Persist and
  // display that same model, including when healing an older mismatched binding.
  if (provider?.modelLocked) modelId = provider.defaultModel;
  if (!runtime.capabilities.reasoning) return { ...resolveReasoningOptions(runtime.capabilities), modelId };
  if (provider?.supportsReasoning === false) return { ...resolveReasoningOptions(runtime.capabilities, undefined, provider), modelId: modelId ?? provider.defaultModel };
  const models = runtime.listModels ? await runtime.listModels({ provider: providerId ?? undefined }) : [];
  const model = modelId ? models.find((entry) => entry.id === modelId)
    : models.find((entry) => entry.id === provider?.defaultModel) ?? models.find((entry) => entry.isDefault) ?? models[0];
  return { ...resolveReasoningOptions(runtime.capabilities, model, provider, requested), modelId: model?.id ?? modelId };
}
