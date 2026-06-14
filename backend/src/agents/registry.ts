import type { AgentRuntime, RuntimeId } from "./types";

const runtimes = new Map<RuntimeId, AgentRuntime>();

export function registerRuntime(runtime: AgentRuntime): void {
  runtimes.set(runtime.id, runtime);
}

export function getRuntime(id: RuntimeId): AgentRuntime | undefined {
  return runtimes.get(id);
}

export function listRuntimes(): AgentRuntime[] {
  return Array.from(runtimes.values());
}

/** Look up the runtime configured to be active. Throws if not registered. */
export function getActiveRuntime(activeId: RuntimeId): AgentRuntime {
  const runtime = runtimes.get(activeId);
  if (!runtime) {
    throw new Error(
      `Agent runtime '${activeId}' is not registered. Available: ${Array.from(runtimes.keys()).join(", ") || "(none)"}`,
    );
  }
  return runtime;
}
