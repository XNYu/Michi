// backend/src/agents/runtimeDeps.ts
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type {
  HistoryStore, GlobalContextProvider, ProviderKeyStore, AgentConfigResolver,
} from "./ports";
import type { AgentSession, RuntimeSessionOwner } from "./types";
import type { AgentSessionState, ChatPermissionMode } from 'michi-shared';

export interface RuntimeDeps {
  historyStore: HistoryStore;
  /** Absolute base dir for per-user sandbox roots etc. */
  dataDir: string;
  /** Optional Pi ports. */
  globalContext?: GlobalContextProvider;
  providerKeys: ProviderKeyStore;
  agentConfig: AgentConfigResolver;
  /** Optional audit hook for live runtime ownership changes. */
  onSessionOwnerBound?: (sessionId: string, owner: RuntimeSessionOwner) => void;
  onSessionStateChanged?: (session: AgentSession, ownerUserId: string | null, state: AgentSessionState) => void;
  chatPermissions?: {
    getMode(nodeId: string, ownerUserId?: string | null): ChatPermissionMode;
    hasGrant(nodeId: string, toolKey: string, ownerUserId?: string | null): boolean;
    grant(nodeId: string, toolKey: string, ownerUserId?: string | null): void;
  };
}

let deps: RuntimeDeps | undefined;

export function configureRuntimeDeps(next: {
  historyStore: HistoryStore;
  dataDir?: string;
  globalContext?: GlobalContextProvider;
  providerKeys?: ProviderKeyStore;
  agentConfig: AgentConfigResolver;
  onSessionOwnerBound?: (sessionId: string, owner: RuntimeSessionOwner) => void;
  chatPermissions?: RuntimeDeps['chatPermissions'];
  onSessionStateChanged?: RuntimeDeps['onSessionStateChanged'];
}): void {
  deps = {
    historyStore: next.historyStore,
    dataDir: next.dataDir ?? (process.env.AGENT_RUNTIME_DATA_DIR || path.join(os.homedir(), ".agent-runtime")),
    globalContext: next.globalContext,
    providerKeys: next.providerKeys ?? { getProviderApiKey: (p) => process.env[`${p.toUpperCase().replace(/-/g, "_")}_API_KEY`] ?? null },
    agentConfig: next.agentConfig,
    onSessionOwnerBound: next.onSessionOwnerBound,
    chatPermissions: next.chatPermissions,
    onSessionStateChanged: next.onSessionStateChanged,
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
