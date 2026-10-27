import { fetchAssistant, isAssistantMissing, type AssistantInfo } from '../../../../../services/api/assistant';

/** How long one read of GET /api/assistant serves Assistant Settings. */
export const ASSISTANT_PROBE_FRESH_MS = 10_000;

let shared: { at: number; promise: Promise<AssistantInfo> } | null = null;

/**
 * GET /api/assistant, shared: opening Settings checks for the assistant to
 * show the native Assistant section; multiple readers
 * get the same request. "No assistant here" is kept like an answer; any
 * other failure is not, so the next reader tries again.
 */
export function probeAssistant(): Promise<AssistantInfo> {
  if (shared && Date.now() - shared.at < ASSISTANT_PROBE_FRESH_MS) return shared.promise;
  const promise = fetchAssistant();
  const entry = { at: Date.now(), promise };
  shared = entry;
  promise.catch((err) => { if (!isAssistantMissing(err) && shared === entry) shared = null; });
  return promise;
}

/** Keeps a newer answer (after a save or a reset) for the next reader. */
export function rememberAssistant(info: AssistantInfo): void {
  shared = { at: Date.now(), promise: Promise.resolve(info) };
}

export function resetAssistantProbe(): void {
  shared = null;
}
