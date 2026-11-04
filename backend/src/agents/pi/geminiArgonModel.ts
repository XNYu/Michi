import type { Model } from '@earendil-works/pi-ai';

export const GEMINI_ARGON_ID = 'gemini-4-argon';
const GEMINI_ARGON_CONTEXT = 1_048_576;
/** Google's per-request outputTokenLimit; Pi's Google provider does not continue past it. */
export const GEMINI_ARGON_MAX_OUTPUT = 32_768;

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

/**
 * Pi's Google provider streams Argon. Michi keeps its own definition only for
 * the price change below; PiSession resolves the model every turn, so a
 * change applies from the next turn. Prices are per million tokens; Google's introductory rate
 * ends December 1 UTC.
 */
export function geminiArgonModel(now = Date.now()): Model<'google-generative-ai'> {
  const introductory = now < Date.UTC(2026, 11, 1);
  return {
    id: GEMINI_ARGON_ID, name: 'Gemini 4 Argon', provider: 'google', api: 'google-generative-ai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    reasoning: true, input: ['text', 'image'],
    contextWindow: GEMINI_ARGON_CONTEXT, maxTokens: GEMINI_ARGON_MAX_OUTPUT,
    cost: { input: introductory ? 2 : 4, output: introductory ? 10 : 20, cacheRead: introductory ? 0.1 : 0.2, cacheWrite: 0 },
    thinkingLevelMap: argonThinkingLevelMap(),
  };
}
