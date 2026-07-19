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
export const CLAUDE_MODEL_CATALOG: Record<string, ClaudeModelEntry> = {
  fable:  { contextWindow: CONTEXT_1M,   rates: { input: 10, output: 50, cacheCreation: 12.5, cacheRead: 1.0 } },
  opus:   { contextWindow: CONTEXT_1M,   rates: { input: 5, output: 25, cacheCreation: 6.25, cacheRead: 0.5 } },
  sonnet: { contextWindow: CONTEXT_1M,   rates: { input: 3, output: 15, cacheCreation: 3.75, cacheRead: 0.3 } },
  haiku:  { contextWindow: CONTEXT_200K, rates: { input: 1, output: 5,  cacheCreation: 1.25, cacheRead: 0.1 } },
};

// Over-reports rather than zeros — Opus-tier defensive default
export const UNKNOWN_CLAUDE_MODEL_FALLBACK: ClaudeModelEntry = {
  contextWindow: CONTEXT_200K,
  rates: { input: 15, output: 75, cacheCreation: 18.75, cacheRead: 1.5 },
};

export function getClaudeModelEntry(modelName: string): { entry: ClaudeModelEntry; isFallback: boolean } {
  const normalized = modelName.toLowerCase();
  const entry = CLAUDE_MODEL_CATALOG[normalized] ?? CLAUDE_MODEL_CATALOG[aliasForConcreteModel(normalized)];
  if (entry) return { entry, isFallback: false };
  return { entry: UNKNOWN_CLAUDE_MODEL_FALLBACK, isFallback: true };
}

function aliasForConcreteModel(modelName: string): string {
  // Match the whole 4.x line per tier (4-5, 4-6, 4-7, 4-8, …) — rates are
  // tier-level, so every minor bump maps to the same entry. A major bump
  // (opus-5) intentionally falls through to the fallback warning.
  if (/claude-fable-\d/.test(modelName)) return 'fable';
  if (/claude-opus-4-\d/.test(modelName)) return 'opus';
  if (/claude-sonnet-[45]-?\d?/.test(modelName)) return 'sonnet';
  if (/claude-haiku-4-\d/.test(modelName)) return 'haiku';
  return '';
}

// Short aliases → concrete model IDs accepted by the CLI. The ASBX build of
// Claude Code does not resolve short aliases (it silently falls back to the
// system default). Michi must pass the full model ID.
const ALIAS_TO_CONCRETE_MODEL: Record<string, string> = {
  fable:  'claude-fable-5',
  opus:   'claude-opus-4-8',
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
