import type { AgentRuntime, RuntimeId } from "./types";
import { getRuntimeManager } from "./sessionRegistry";

export function registerRuntime(runtime: AgentRuntime): void {
  getRuntimeManager().register(runtime);
}

export function getRuntime(id: RuntimeId): AgentRuntime | undefined {
  return getRuntimeManager().get(id);
}

export function listRuntimes(): AgentRuntime[] {
  return getRuntimeManager().list();
}
