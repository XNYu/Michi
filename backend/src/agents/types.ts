import type { NormalizedEvent } from "../services/chatEvents";

export type RuntimeId = string;

export type AgentReasoning = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
export type ExtraContext = {
  name: string;
  filePath: string;
  size?: number;
  kind?: "embedded" | "reference";
};

export interface AgentCapabilities {
  modes: boolean;
  permissions: boolean;
  /** Runtime exposes a list of selectable models via listModels(). */
  models: boolean;
  /** Models are scoped per provider (a provider picker is required to filter the list). */
  providerModels: boolean;
  reasoning: boolean;
  /** Reasoning levels this runtime accepts. Empty when reasoning=false. */
  supportedReasoningLevels: AgentReasoning[];
  apiKeys: boolean;
  warmSessions: boolean;
  saveContext: boolean;
  spawnBranches: boolean;
  /**
   * True iff `loadSession()` restores agent-side session state (a CLI
   * process, an ACP `session/load`, etc.) that materially differs from a
   * fresh session seeded with the same transcript. False for runtimes that
   * keep all state in our SQLite and replay it on resume — for those, the
   * "exact" resume path is indistinguishable from "compatible" and we skip
   * the extra round-trip.
   */
  nativeResume: boolean;
}

export interface AgentProviderInfo {
  id: string;
  label: string;
  keyLabel: string;
  envVars: string[];
  defaultModel: string;
  keyUrl?: string;
  supportsReasoning: boolean;
}

export interface AgentRuntimeOption {
  id: RuntimeId;
  label: string;
  available: boolean;
}

export interface ModelInfo {
  id: string;
  label?: string;
  description?: string;
  /** True for the runtime's catalog default. */
  isDefault?: boolean;
}

export interface SessionMode {
  id: string;
  label?: string;
  description?: string;
}

export interface NewAgentSessionOptions {
  cwd: string;
  parentChatId?: string;
  mergeContexts?: string[];
  extraContexts?: ExtraContext[];
  contextManifest?: ExtraContext[];
  /** Default true. When false, the runtime omits set_follow_ups instructions and tool. */
  enableFollowUps?: boolean;
  /** Optional model id forwarded to runtime (e.g. Kiro --model arg, or Pi provider model) */
  model?: string | null;
  /** Provider id for Pi runtime; ignored by Kiro */
  provider?: string | null;
  /** Reasoning level for Pi runtime; ignored by Kiro */
  reasoning?: AgentReasoning | null;
  /**
   * Optional client-supplied session id. Pi runtime adopts this as
   * `session.id` so chatId === nodeId, removing the second namespace
   * (and the acp_session_id reverse-lookup that came with it). Kiro
   * ignores this — ACP requires server-minted ids.
   */
  sessionId?: string;
  /**
   * Workspace this chat belongs to. Required for the globalContext tools
   * (list_threads / search_messages / read_node) as a cold-start/cache
   * fallback. MCP-backed runtimes prefer resolving workspace_id from the
   * supplied Michi node id at tool-call time.
   */
  workspaceId?: string | null;
  /**
   * Better-Auth user id of the chat owner. Cloud (BYOK) mode forwards
   * this from the request session so Pi can resolve a per-user provider
   * key. Local desktop / Electron leaves it undefined and falls back to
   * env / disk-stored shared keys.
   */
  ownerUserId?: string | null;
}

export interface LoadAgentSessionOptions {
  sessionId: string;
  /** Michi node id for this runtime session, when distinct from sessionId. */
  nodeId?: string | null;
  cwd: string;
  model?: string | null;
  /**
   * Workspace this session belongs to. Used as a cache/fallback by
   * globalContext tools; MCP-backed runtimes prefer nodeId -> nodes.workspace_id.
   * Optional because legacy callers (and Pi rehydrate) can derive it from the
   * persisted node row.
   */
  workspaceId?: string | null;
  /** See NewAgentSessionOptions.ownerUserId. */
  ownerUserId?: string | null;
}

export interface AgentStatus {
  runtime: RuntimeId;
  label: string;
  capabilities: AgentCapabilities;
  /** All runtimes the current build can switch between (rendered as runtime picker when length > 1). */
  availableRuntimes: AgentRuntimeOption[];
  provider?: string;
  providers?: AgentProviderInfo[];
  /** Resolved model id for the active runtime (from modelByRuntime or builtin default). */
  model?: string;
  /** Per-runtime model overrides set by the user. */
  modelByRuntime?: Record<string, string>;
  /** Resolved reasoning level for the active runtime. */
  reasoning?: AgentReasoning;
  /** Per-runtime reasoning overrides set by the user. */
  reasoningByRuntime?: Record<string, AgentReasoning>;
  hasRequiredKey: boolean;
}

export interface AgentSession {
  /** Stable Michi node id. This is the only session identity exposed outside runtime adapters. */
  id: string;
  /**
   * Runtime-owned resume/transport id when it differs from the Michi node id
   * (for example Kiro's ACP session id). Never expose this to the frontend.
   */
  nativeSessionId?: string | null;
  runtimeId: RuntimeId;
  parentChatId?: string;
  currentModeId?: string | null;
  currentModelId?: string | null;
  /** Returns this session's own user/assistant transcript, used by ancestor preamble stitching. */
  getHistory(): ChatMessage[];
  /** Mid-stream partial assistant text for an in-progress turn (auto-branch case). Returns undefined when not streaming. */
  getPendingAssistant(): string | undefined;
  send(text: string): AsyncIterableIterator<NormalizedEvent>;
  cancel(): Promise<void> | void;
  setMode?(modeId: string): Promise<void>;
  setModel?(modelId: string): Promise<void>;
  respondToPermission?(requestId: number, optionId: string): void;
  cancelPermission?(requestId: number): void;
}

export interface AgentRuntime {
  id: RuntimeId;
  label: string;
  capabilities: AgentCapabilities;

  warm(cwd: string, opts?: { model?: string | null }): Promise<void>;
  newSession(opts: NewAgentSessionOptions): Promise<AgentSession>;
  loadSession?(opts: LoadAgentSessionOptions): Promise<AgentSession>;
  /**
   * Runtime-owned teardown for a live session. Callers should use this instead
   * of casting AgentSession to runtime-specific dispose/destroy methods so the
   * runtime can keep its private maps, process/slot ownership, and
   * sessionRegistry in sync.
   */
  releaseSession(sessionId: string): Promise<void> | void;
  listModes?(sessionId: string): Promise<SessionMode[]>;
  listModels?(opts?: { provider?: string }): Promise<ModelInfo[]>;
  /** Refresh a dynamic model catalog from the underlying runtime. */
  refreshModels?(): Promise<ModelInfo[]>;
  shutdown(): Promise<void>;
}

export interface VerifyProviderKeyOptions {
  provider?: string;
  key?: string;
  model?: string;
}

export interface VerifyProviderKeyResult {
  ok: boolean;
  provider: string;
  model: string;
  latencyMs: number;
  error?: string;
}

/**
 * Sub-interface for runtimes that surface a multi-provider catalog and
 * verifiable API keys (currently Pi). The registry does not require this;
 * routes/agent.ts uses `hasProviders` to narrow before calling.
 */
export interface AgentRuntimeWithProviders extends AgentRuntime {
  listProviders(): Promise<AgentProviderInfo[]>;
  verifyProviderKey(opts: VerifyProviderKeyOptions): Promise<VerifyProviderKeyResult>;
}

export function hasProviders(runtime: AgentRuntime): runtime is AgentRuntimeWithProviders {
  return runtime.capabilities.apiKeys === true
    && typeof (runtime as any).listProviders === "function"
    && typeof (runtime as any).verifyProviderKey === "function";
}

export interface ProviderEnvBinding {
  provider: string;
  envVars: string[];
}
