import type { RuntimeReasoning } from './agentRuns';

export const REASONING_LEVELS: readonly RuntimeReasoning[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export interface ModelReasoningCapabilities {
  supportsReasoning?: boolean;
  /** Omitted means unknown; an empty list explicitly means not configurable. */
  supportedReasoningLevels?: RuntimeReasoning[];
  defaultReasoning?: RuntimeReasoning;
}

export function isReasoningLevel(value: unknown): value is RuntimeReasoning {
  return typeof value === 'string' && REASONING_LEVELS.includes(value as RuntimeReasoning);
}

export function sanitizeReasoningLevels(value: unknown): RuntimeReasoning[] | undefined {
  return Array.isArray(value) ? [...new Set(value.filter(isReasoningLevel))] : undefined;
}

export function resolveReasoningOptions(
  runtime: { reasoning: boolean; supportedReasoningLevels?: RuntimeReasoning[] } | null | undefined,
  model?: ModelReasoningCapabilities | null,
  provider?: ModelReasoningCapabilities | null,
  requested?: RuntimeReasoning | null,
) {
  const enabled = runtime?.reasoning && model?.supportsReasoning !== false && provider?.supportsReasoning !== false;
  const levels = enabled
    ? sanitizeReasoningLevels(model?.supportedReasoningLevels ?? provider?.supportedReasoningLevels ?? runtime?.supportedReasoningLevels) ?? []
    : [];
  const preferred = model?.defaultReasoning ?? provider?.defaultReasoning;
  const fallback = preferred && levels.includes(preferred) ? preferred : levels.includes('medium') ? 'medium' : levels[0];
  const value = requested && levels.includes(requested) ? requested : fallback;
  return { levels, value, adjustable: levels.length > 1 };
}
