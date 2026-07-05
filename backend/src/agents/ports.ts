// backend/src/agents/ports.ts
import type { RuntimeId, AgentReasoning } from "./types";

/** Minimal structural shapes the runtime layer reads. Michi's richer DB rows
 *  are structurally assignable to these. */
export interface NodeRowLike {
  parent_node_id: string | null;
  workspace_id: string | null;
}
export interface MessageRowLike {
  role: string;
  content: string | null;
  created_at: number;
}
export interface WorkspaceRowLike {
  owner_user_id: string | null;
}

/** Read/persist access to conversation + workspace state. Consumer supplies
 *  the implementation (Michi: SQLite; a new project: memory/JSON/etc.). */
export interface HistoryStore {
  getNode(id: string): NodeRowLike | null;
  listMessages(nodeId: string): MessageRowLike[];
  getWorkspace(id: string, userId?: string): WorkspaceRowLike | null;
  getWorkspaceInstructions(workspaceId: string): string | null;
  hasGrant(workspaceId: string, toolName: string): boolean;
  grantPermission(workspaceId: string, toolName: string): void;
}

/** Result shape returned by the Pi read-only global-context tools. */
export interface GlobalContextResultLike {
  status: string;
  text: string;
}

/** Optional: backs Pi's list_threads / search_messages / read_node tools.
 *  When omitted, Pi does not register those tools. */
export interface GlobalContextProvider {
  listThreads(sessionWorkspaceId: string | null, ownerUserId: string | null | undefined,
              targetWorkspaceId?: string, currentNodeId?: string): GlobalContextResultLike;
  searchMessages(sessionWorkspaceId: string | null, ownerUserId: string | null | undefined,
                 query: string, scope?: "current" | "all", limit?: number): GlobalContextResultLike;
  readNode(sessionWorkspaceId: string | null, ownerUserId: string | null | undefined,
           nodeId: string): GlobalContextResultLike;
}

/** Resolves provider API keys. Default impl reads env only. */
export interface ProviderKeyStore {
  getProviderApiKey(provider: string, userId?: string): string | null;
}

/** The runtime/provider/model config the Pi runtime consults. */
export interface AgentConfigLike {
  runtime: RuntimeId;
  provider: string;
  modelByRuntime: Record<string, string>;
  reasoningByRuntime: Record<string, AgentReasoning>;
}
export interface AgentConfigResolver {
  getAgentConfig(userId?: string): AgentConfigLike;
  resolveModel(runtimeId: string, userId?: string): string;
  resolveReasoning(runtimeId: string, userId?: string): AgentReasoning | undefined;
}
