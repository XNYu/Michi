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
