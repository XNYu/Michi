/**
 * Michi's sidecar thread-title generation: the instruction text and prompt,
 * and the per-runtime title model read from the environment.
 *
 * The runtime-neutral mechanics (output cleaning, the plain-text fallback,
 * the deadline race and the length limits) live in michi-runtime
 * (runtime/src/core/titles.ts) and are re-exported here, so existing
 * importers keep the same functions. The runtime-specific transport lives
 * next to each runtime.
 */

import {
  DEFAULT_TITLE_TIMEOUT_MS,
  MAX_TITLE_INPUT_CHARS,
  truncateChars,
} from 'michi-runtime/internal/core/titles';

export {
  DEFAULT_TITLE_TIMEOUT_MS,
  MAX_TITLE_INPUT_CHARS,
  MAX_TITLE_CHARS,
  truncateChars,
  cleanGeneratedTitle,
  fallbackTitleFromUserText,
  withTitleTimeout,
} from 'michi-runtime/internal/core/titles';

export const TITLE_INSTRUCTIONS = `You generate a short thread title from a user's message in a knowledge-exploration chat app.
Do not answer the request, plan the work, call tools, or explain your reasoning.
Capture the TOPIC or INTENT of the message. Match the user's language.
The title MUST be self-contained: include the specific subject so it makes sense in a sidebar without extra context. Never produce a generic verb-only title like "修复原理详解" or "Implementation Details" — always name WHAT is being discussed.
Prefer 4-8 words for space-delimited languages or 8-20 characters for Chinese/Japanese.
Plain text only: no quotes, no trailing period, no markdown, no "Title:" prefix.
Avoid meta phrasing such as "User asks about…" or "关于…".
Output ONLY the title.`;

export function buildTitlePrompt(userText: string, contextText?: string): string {
  const contextBlock = contextText?.trim()
    ? `\nCONTEXT (the user is replying to or quoting this):\n${truncateChars(contextText.trim(), 1_000)}\n`
    : '';
  return `${TITLE_INSTRUCTIONS}\n\n---${contextBlock}\nUSER MESSAGE:\n${truncateChars(userText, MAX_TITLE_INPUT_CHARS)}`;
}

export interface TitleModelConfig {
  /** Model id passed to the runtime's cheap one-shot path; null disables sidecar generation. */
  model: string | null;
  timeoutMs: number;
}

function readTimeout(envName: string): number {
  const raw = process.env[envName];
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TITLE_TIMEOUT_MS;
}

function readModel(envName: string, fallback: string): string | null {
  const raw = process.env[envName];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'off' || trimmed.toLowerCase() === 'none') return null;
  return trimmed;
}

/**
 * Per-runtime cheap model for title generation. Each runtime reads its own
 * entry so a user who only has one CLI installed still gets titles from the
 * credentials they already have. Set the env var to `off` to disable.
 */
export function titleModelConfig(runtimeId: 'kiro' | 'codex'): TitleModelConfig {
  switch (runtimeId) {
    case 'kiro':
      return { model: readModel('MICHI_TITLE_MODEL_KIRO', 'gpt-5.6-luna'), timeoutMs: readTimeout('MICHI_TITLE_TIMEOUT_MS') };
    case 'codex':
      return { model: readModel('MICHI_TITLE_MODEL_CODEX', 'gpt-5.6-luna'), timeoutMs: readTimeout('MICHI_CODEX_TITLE_TIMEOUT_MS') };
  }
}
