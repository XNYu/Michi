/**
 * Runtime-neutral helpers for sidecar thread-title generation.
 *
 * Every runtime that can run a cheap one-shot prompt (Kiro, Claude, Codex)
 * shares the same instruction text, output cleaning and plain-text fallback
 * so the sidebar title looks the same regardless of which model produced it.
 * The runtime-specific transport lives next to each runtime; this module
 * only owns the pure pieces.
 */

export const DEFAULT_TITLE_TIMEOUT_MS = 15_000;
export const MAX_TITLE_INPUT_CHARS = 4_000;
export const MAX_TITLE_CHARS = 80;

export const TITLE_INSTRUCTIONS = `You generate a short thread title from a user's message in a knowledge-exploration chat app.
Do not answer the request, plan the work, call tools, or explain your reasoning.
Capture the TOPIC or INTENT of the message. Match the user's language.
Prefer 4-8 words for space-delimited languages or 8-20 characters for Chinese/Japanese.
Plain text only: no quotes, no trailing period, no markdown, no "Title:" prefix.
Avoid meta phrasing such as "User asks about…" or "关于…".
Output ONLY the title.`;

export function buildTitlePrompt(userText: string): string {
  return `${TITLE_INSTRUCTIONS}\n\n---\nUSER MESSAGE:\n${truncateChars(userText, MAX_TITLE_INPUT_CHARS)}`;
}

export function truncateChars(value: string, maxChars: number): string {
  const chars = Array.from(value);
  return chars.length <= maxChars ? value : chars.slice(0, maxChars).join('');
}

/**
 * Normalize raw model output into a single-line title. Handles the common
 * ways a model ignores "output only the title": sentinel wrappers, code
 * fences, headings, quotes, a "Title:" prefix, and multi-line replies (the
 * first non-empty line wins).
 */
export function cleanGeneratedTitle(raw: string): string {
  let title = raw.trim();
  const sentinel = /\[TITLE:\s*([^\]]+)\]/i.exec(title);
  if (sentinel) title = sentinel[1];
  title = title.replace(/^```(?:\w+)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const firstLine = title.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? '';
  title = firstLine
    .replace(/^#{1,6}\s*/, '')
    .replace(/^(?:title|标题|主题|话题)\s*[:：]\s*/i, '')
    .replace(/^["'“”‘’`「『《]+|["'“”‘’`」』》]+$/g, '')
    .replace(/^\*\*(.+)\*\*$/, '$1')
    .replace(/[\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncateChars(title, MAX_TITLE_CHARS).replace(/[\s:：,，;；.!?。！？-]+$/u, '').trim();
}

/** Last-resort title: the first sentence of the user's own message. */
export function fallbackTitleFromUserText(userText: string): string {
  const plain = userText
    .replace(/^\s*\/(?:btw|branch)\s+/i, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_>#\[\]()]/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const firstPhrase = plain.split(/(?<=[。！？.!?])\s*/u)[0] ?? plain;
  return cleanGeneratedTitle(truncateChars(firstPhrase, 48));
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
export function titleModelConfig(runtimeId: 'kiro' | 'claude' | 'codex'): TitleModelConfig {
  switch (runtimeId) {
    case 'kiro':
      return { model: readModel('MICHI_TITLE_MODEL_KIRO', 'gpt-5.6-luna'), timeoutMs: readTimeout('MICHI_TITLE_TIMEOUT_MS') };
    case 'claude':
      return { model: readModel('MICHI_TITLE_MODEL_CLAUDE', 'haiku'), timeoutMs: readTimeout('MICHI_TITLE_TIMEOUT_MS') };
    case 'codex':
      return { model: readModel('MICHI_TITLE_MODEL_CODEX', 'gpt-5.6-luna'), timeoutMs: readTimeout('MICHI_CODEX_TITLE_TIMEOUT_MS') };
  }
}

/**
 * Race a promise against a deadline. On timeout the abort controller fires so
 * the caller can stop the underlying work, then the promise rejects.
 */
export async function withTitleTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } catch (err) {
    // The aborted work may reject before the deadline promise does; report
    // the timeout either way so callers see one consistent failure.
    if (timedOut) throw new Error(`${label} timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
