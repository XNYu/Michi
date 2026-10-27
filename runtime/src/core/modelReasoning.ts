import { resolveReasoningOptions } from 'michi-shared';
import { hasProviders, type AgentReasoning, type AgentRuntime } from '../contract/types';

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

/** Validate a stored Run selection without silently changing its model or effort. */
export async function assertModelReasoningCompatible(
  runtime: AgentRuntime,
  modelId?: string | null,
  providerId?: string | null,
  requested?: AgentReasoning | null,
): Promise<void> {
  const options = await getModelReasoningOptions(runtime, modelId, providerId, requested);
  if (modelId && options.modelId && modelId !== options.modelId) {
    throw Object.assign(new Error(
      `Provider ${providerId ?? runtime.id} requires model ${options.modelId}; requested ${modelId}`,
    ), { code: 'model_unsupported' });
  }
  if (requested && !options.levels.includes(requested)) {
    throw Object.assign(new Error(
      `Model ${modelId ?? options.modelId ?? runtime.id} does not support reasoning level ${requested}`,
    ), { code: 'reasoning_unsupported' });
  }
}
