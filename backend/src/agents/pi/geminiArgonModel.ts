import type { Model } from '@earendil-works/pi-ai';

export const GEMINI_ARGON_ID = 'gemini-4-argon';
export const GEMINI_ARGON_CONTEXT = 1_048_576;
export const GEMINI_ARGON_DEFAULT_OUTPUT = 262_144;
export const GEMINI_ARGON_TIMEOUT = 20 * 60 * 1000;

export function isGeminiArgon(model: { id?: string; provider?: string }): boolean {
  return model.provider === 'google' && model.id === GEMINI_ARGON_ID;
}

export function isOpenRouterArgon(id: string): boolean {
  return id === `google/${GEMINI_ARGON_ID}`;
}

export function argonThinkingLevelMap(google = true) {
  return {
    off: null, minimal: null,
    low: google ? 'LOW' : 'low', medium: google ? 'MEDIUM' : 'medium', high: google ? 'HIGH' : 'high',
    xhigh: null, max: null,
  };
}

/** Prices are per million tokens; Google's introductory rate ends December 1 UTC. */
export function geminiArgonModel(now = Date.now()): Model<'google-generative-ai'> {
  const introductory = now < Date.UTC(2026, 11, 1);
  return {
    id: GEMINI_ARGON_ID, name: 'Gemini 4 Argon', provider: 'google', api: 'google-generative-ai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    reasoning: true, input: ['text', 'image'],
    contextWindow: GEMINI_ARGON_CONTEXT, maxTokens: GEMINI_ARGON_CONTEXT,
    cost: { input: introductory ? 2 : 4, output: introductory ? 10 : 20, cacheRead: introductory ? 0.1 : 0.2, cacheWrite: 0 },
    thinkingLevelMap: argonThinkingLevelMap(),
  };
}

export function argonOutputLimit(env = process.env): number {
  const value = env.MICHI_GEMINI_ARGON_MAX_OUTPUT_TOKENS;
  if (!value) return GEMINI_ARGON_DEFAULT_OUTPUT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > GEMINI_ARGON_CONTEXT) {
    throw new Error(`MICHI_GEMINI_ARGON_MAX_OUTPUT_TOKENS must be an integer from 1 to ${GEMINI_ARGON_CONTEXT}`);
  }
  return parsed;
}
