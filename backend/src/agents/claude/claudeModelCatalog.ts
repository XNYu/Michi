export interface ClaudeModelRates {
  input: number;          // USD per million tokens
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface ClaudeModelEntry {
  contextWindow: number;
  rates: ClaudeModelRates;
}

const CONTEXT_1M = 1_000_000;
const CONTEXT_200K = 200_000;

// Keyed by our model picker aliases. Claude CLI may emit concrete model ids
// (for example `claude-opus-4-7`) in assistant envelopes; getClaudeModelEntry
// maps those ids back onto these entries.
// Cost tracking is disabled for the Claude runtime — rates are all zero.
// contextWindow is still needed for the context usage percentage indicator.
const ZERO_RATES: ClaudeModelRates = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

export const CLAUDE_MODEL_CATALOG: Record<string, ClaudeModelEntry> = {
  fable:  { contextWindow: CONTEXT_1M,   rates: ZERO_RATES },
  opus:   { contextWindow: CONTEXT_1M,   rates: ZERO_RATES },
  sonnet: { contextWindow: CONTEXT_1M,   rates: ZERO_RATES },
  haiku:  { contextWindow: CONTEXT_200K, rates: ZERO_RATES },
};

// Fallback for unknown models — contextWindow matters for the percentage bar;
// rates are zero (cost tracking disabled).
export const UNKNOWN_CLAUDE_MODEL_FALLBACK: ClaudeModelEntry = {
  contextWindow: CONTEXT_200K,
  rates: ZERO_RATES,
};

export function getClaudeModelEntry(modelName: string): { entry: ClaudeModelEntry; isFallback: boolean } {
  // Strip extended-thinking suffix (e.g. "[1m]") before lookup — it doesn't
  // affect pricing tier, only context budget.
  const normalized = modelName.toLowerCase().replace(/\[\d+m\]$/, '');
  const entry = CLAUDE_MODEL_CATALOG[normalized] ?? CLAUDE_MODEL_CATALOG[aliasForConcreteModel(normalized)];
  if (entry) return { entry, isFallback: false };
  return { entry: UNKNOWN_CLAUDE_MODEL_FALLBACK, isFallback: true };
}

function aliasForConcreteModel(modelName: string): string {
  // Match concrete model IDs back to tier aliases. Rates are tier-level so
  // minor bumps within a generation map to the same entry.
  if (/claude-fable-\d/.test(modelName)) return 'fable';
  if (/claude-opus-[45]-?\d?/.test(modelName)) return 'opus';
  if (/claude-sonnet-[45]-?\d?/.test(modelName)) return 'sonnet';
  if (/claude-haiku-4-\d/.test(modelName)) return 'haiku';
  return '';
}

// Short aliases → concrete model IDs accepted by the CLI. The ASBX build of
// Claude Code does not resolve short aliases (it silently falls back to the
// system default). Michi must pass the full model ID.
const ALIAS_TO_CONCRETE_MODEL: Record<string, string> = {
  fable:  'claude-fable-5',
  opus:   'claude-opus-5[1m]',
  sonnet: 'claude-sonnet-5',
  haiku:  'claude-haiku-4-5',
};

/**
 * Resolve a Michi model alias (e.g. "fable") to the concrete model ID that
 * the CLI accepts (e.g. "claude-fable-5"). If the input is already a concrete
 * ID (starts with "claude-") or is not a known alias, it's returned as-is.
 */
export function resolveClaudeCliModelId(model: string): string {
  return ALIAS_TO_CONCRETE_MODEL[model] ?? model;
}
