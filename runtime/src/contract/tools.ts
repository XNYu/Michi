import type { ResultBundleV1 } from 'michi-shared';
import type { RuntimeSessionOwner, RuntimeToolProfile } from './types';

// The result bundle a Run worker submits and its parts, which a host names when it receives one.
export type {
  ResultBundleV1, ResultBundleStatus, ResultArtifactRefV1, GitChangeSetRefV1, ExternalActionReceiptV1,
  ResourceMutationReceiptV1, RunUsageSummaryV1,
} from 'michi-shared';

// ---------------------------------------------------------------------------
// Tool contracts
//
// Names and shapes shared by adapters and the host's MCP tools: the Agent Run
// tool names and invoker, the tool bridge the adapters call for business
// effects, and the Run worker's result-submission tool. Only types, constants
// and pure functions live here; the implementations (createAgentToolBridge,
// createAgentRunToolBridge, RunResultCollector) stay in the host.
// ---------------------------------------------------------------------------

export const AGENT_RUN_TOOL_NAMES = [
  'list_agents',
  'spawn_agent',
  'check_agent',
  'wait_agent',
  'send_agent_input',
  'cancel_agent',
  'watch_agent_runs',
  'update_agent_watch',
] as const;
export type AgentRunToolName = typeof AGENT_RUN_TOOL_NAMES[number];

export interface AgentRunToolInvoker {
  invoke(name: AgentRunToolName, args: Record<string, unknown>, meta?: { runtimeToolCallId?: string | null }): Promise<Record<string, unknown>>;
}

export interface AgentRunToolSessionBinding {
  runtimeId: string;
  sessionId: string;
  owner: RuntimeSessionOwner;
  ownerUserId: string | null;
  workspaceId: string | null;
  nodeId: string | null;
}

export type AgentRunToolInvokerFactory = (
  binding: Readonly<AgentRunToolSessionBinding>,
) => AgentRunToolInvoker | null | undefined;

/**
 * Shared handlers for the business effects of the host's spawn_branches,
 * save_artifact and update_artifact tools.
 *
 * The bridge does NOT surface events. The host's MCP tools report their
 * effects through the slot's event sink (McpSlotCallbacks.sink), which each
 * adapter routes into its own session's events; a runtime whose tools run
 * in process reports them itself.
 *
 * The runtime calls bridge.spawnBranches(...) etc. and consumes the
 * structured result. The bridge handles the durable side effects (creating
 * a new chat, persisting a context file).
 */
export interface SpawnedBranch {
  title: string;
  prompt: string;
  chatId: string;
  nodeId: string;
}

export interface BridgeSpawnBranchesArgs {
  /** The chatId that initiated the spawn (the "parent" branch). */
  parentChatId: string;
  /** Cwd inherited by the children. */
  cwd: string;
  /** Whether children should also instruct the agent to call set_follow_ups. */
  enableFollowUps: boolean;
  /** Cloud owner of the parent session, forwarded to durable graph lookup. */
  ownerUserId?: string | null;
  topics: Array<{ title: string; prompt: string }>;
}

export interface BridgeSaveContextArgs {
  cwd: string;
  /** Runtime chat id used to resolve the durable workspace owner. */
  chatId?: string;
  ownerUserId?: string | null;
  /** Sanitized to /^[A-Za-z0-9_-]+$/. The bridge enforces this. */
  name: string;
  body: string;
}

export interface BridgeContextResult {
  /** Durable contexts row id. Present in the production bridge. */
  id?: string;
  name: string;
  filePath: string;
  size: number;
}

export type BridgeSaveContextResult = BridgeContextResult;
export type BridgeUpdateContextResult = BridgeContextResult;

export interface BridgeUpdateContextArgs {
  cwd: string;
  /** Runtime chat id used to resolve the durable workspace owner. */
  chatId?: string;
  ownerUserId?: string | null;
  /** Sanitized to /^[A-Za-z0-9_-]+$/. The bridge enforces this. */
  name: string;
  body: string;
}

export interface AgentToolBridge {
  /** Host tool extension: the adapters offer spawn_branches only when it is present. */
  spawnBranches?(args: BridgeSpawnBranchesArgs): Promise<SpawnedBranch[]>;
  /** Host tool extension: the adapters offer save_artifact only when it is present. */
  saveContext?(args: BridgeSaveContextArgs): BridgeSaveContextResult | null;
  /** Host tool extension: the adapters offer update_artifact only when it is present. */
  updateContext?(args: BridgeUpdateContextArgs): BridgeUpdateContextResult | null;
  /** Optional generic Agent Run tools shared by every session; prefer
   * agentRunToolsForSession. Absent, chat tools are unchanged. */
  agentRuns?: AgentRunToolInvoker;
  /** Production path: bind orchestration tools to one immutable runtime
   * session identity. A factory avoids cross-session caller leakage when
   * several chats/Run Attempts execute concurrently. */
  agentRunToolsForSession?: AgentRunToolInvokerFactory;
}

export function resolveAgentRunToolsForSession(
  bridge: AgentToolBridge,
  binding: AgentRunToolSessionBinding,
): AgentRunToolInvoker | null {
  if (bridge.agentRunToolsForSession) {
    const immutable = Object.freeze({
      ...binding,
      // Shallow: hostRef is passed by reference, and hosts give an immutable one.
      owner: Object.freeze({ ...binding.owner }) as RuntimeSessionOwner,
    });
    return bridge.agentRunToolsForSession(immutable) ?? null;
  }
  // A bridge with one shared invoker. Hosts should provide the session
  // factory, so a singleton invoker is never shared concurrently.
  return bridge.agentRuns ?? null;
}

export const SUBMIT_AGENT_RESULT_TOOL = 'submit_agent_result';

export interface RunWorkerToolProfile extends RuntimeToolProfile {
  /** In-process hook consumed by fake transports and future native tool bridges. */
  runWorkerTools: {
    submitAgentResult(owner: RuntimeSessionOwner, payload: unknown): ResultBundleV1;
  };
}
