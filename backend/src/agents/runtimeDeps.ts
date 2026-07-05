// backend/src/agents/runtimeDeps.ts
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type {
  HistoryStore, GlobalContextProvider, ProviderKeyStore, AgentConfigResolver,
} from "./ports";

export interface RuntimeDeps {
  historyStore: HistoryStore;
  /** Absolute base dir for per-user sandbox roots etc. */
  dataDir: string;
  /** Optional Pi ports. */
  globalContext?: GlobalContextProvider;
  providerKeys: ProviderKeyStore;
  agentConfig: AgentConfigResolver;
}

let deps: RuntimeDeps | undefined;

export function configureRuntimeDeps(next: {
  historyStore: HistoryStore;
  dataDir?: string;
  globalContext?: GlobalContextProvider;
  providerKeys?: ProviderKeyStore;
  agentConfig: AgentConfigResolver;
}): void {
  deps = {
    historyStore: next.historyStore,
    dataDir: next.dataDir ?? (process.env.AGENT_RUNTIME_DATA_DIR || path.join(os.homedir(), ".agent-runtime")),
    globalContext: next.globalContext,
    providerKeys: next.providerKeys ?? { getProviderApiKey: (p) => process.env[`${p.toUpperCase().replace(/-/g, "_")}_API_KEY`] ?? null },
    agentConfig: next.agentConfig,
  };
  fs.mkdirSync(deps.dataDir, { recursive: true });
}

export function getRuntimeDeps(): RuntimeDeps {
  if (!deps) {
    throw new Error("runtime deps not configured; call configureRuntimeDeps() before using the runtime layer");
  }
  return deps;
}

/** Test helper — reset the singleton between tests. */
export function __resetRuntimeDeps(): void {
  deps = undefined;
}
