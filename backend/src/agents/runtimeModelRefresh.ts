import type { AgentRuntime } from './types';

export type ModelRefreshErrorHandler = (runtimeId: string, error: Error) => void;

/** Start refreshes without delaying server readiness or the first cached response. */
export function refreshRuntimeModelsInBackground(
  runtimes: readonly AgentRuntime[],
  onError: ModelRefreshErrorHandler = (runtimeId, error) => {
    console.warn(`[runtimeModelRefresh] ${runtimeId} refresh failed:`, error.message);
  },
): void {
  for (const runtime of runtimes) {
    if (!runtime.refreshModels) continue;
    void runtime.refreshModels().catch((err: unknown) => {
      onError(runtime.id, err instanceof Error ? err : new Error(String(err)));
    });
  }
}
