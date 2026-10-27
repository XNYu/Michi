import { REASONING_LEVELS, isReasoningLevel, resolveReasoningOptions } from 'michi-shared';
import type { AgentCapabilities, AgentModelInfo, AgentProviderInfo } from '../services/api/agentRuntime';

/** A choice invalidates only fields whose meaning depends on that choice. */
export function changeRuntimeProfile<T extends { runtimeId: string; providerId: string; modelId: string; reasoning: string; modeId?: string }>(
  value: T, field: 'runtimeId' | 'providerId' | 'modelId', next: string,
): T {
  if (value[field] === next) return value;
  if (field === 'runtimeId') return { ...value, runtimeId: next, providerId: '', modelId: '', reasoning: '', ...(value.modeId === undefined ? {} : { modeId: '' }) };
  if (field === 'providerId') return { ...value, providerId: next, modelId: '', reasoning: '' };
  return { ...value, modelId: next, reasoning: '' };
}

export function profileReasoningLevels(
  capabilities?: AgentCapabilities | null, model?: AgentModelInfo, provider?: AgentProviderInfo,
) {
  // Offline/unknown catalogs still permit a draft with a manually supplied ID.
  return capabilities == null ? REASONING_LEVELS : resolveReasoningOptions(capabilities, model, provider).levels;
}

/** Resolve defaults the same way as Run validation, without treating missing model data as known. */
export function resolveProfileReasoning(
  capabilities: AgentCapabilities | null | undefined, models: readonly AgentModelInfo[] | undefined,
  modelId: string, provider?: AgentProviderInfo,
) {
  const selectedId = provider?.modelLocked ? provider.defaultModel : modelId;
  const model = selectedId ? models?.find((entry) => entry.id === selectedId)
    : models?.find((entry) => entry.id === provider?.defaultModel) ?? models?.find((entry) => entry.isDefault) ?? models?.[0];
  const known = capabilities != null && (!capabilities.reasoning || provider?.supportsReasoning === false
    || model != null || !(capabilities.models || capabilities.providerModels));
  return { known, levels: known ? profileReasoningLevels(capabilities, model, provider) : REASONING_LEVELS };
}

export function supportedProfileReasoning(value: string, levels: readonly string[]) {
  return !value || (isReasoningLevel(value) && levels.includes(value));
}
