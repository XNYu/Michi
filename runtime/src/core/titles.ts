/**
 * Runtime-neutral mechanics of sidecar thread-title generation: output
 * cleaning, the plain-text fallback and the deadline race, so a sidebar title
 * looks the same regardless of which model produced it. The instruction text
 * and the per-runtime title model come from the host (TitlePolicy and
 * RuntimeConfigPort.titleModel); the runtime-specific transport lives next
 * to each runtime.
 */

export const DEFAULT_TITLE_TIMEOUT_MS = 15_000;
export const MAX_TITLE_INPUT_CHARS = 4_000;
export const MAX_TITLE_CHARS = 80;

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
