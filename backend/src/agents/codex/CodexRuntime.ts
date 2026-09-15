import { isReasoningLevel, sanitizeReasoningLevels, type CapabilityDescriptor } from 'michi-shared';
import type {
  AgentCapabilities,
  AgentRuntime,
  AgentSession,
  LoadAgentSessionOptions,
  ModelInfo,
  NewAgentSessionOptions,
  RuntimeId,
  RuntimeSessionOwner,
} from '../types';
import { assertReleaseOwnership } from '../runs/runtimeRunAdapter';
import { assertOwner } from '../types';
import { withDeadline } from '../runtimeLifecycle';
import { describeRuntimeCapabilities } from '../capabilityDescriptors';
import type { AgentToolBridge } from '../toolBridge';
import type { McpSlotRegistry } from '../../services/mcpServer';
import { CodexAppServerClient, CodexRpcError } from './CodexAppServerClient';
import type { CodexModel } from './codexProtocol';
import { buildCodexMcpConfig, CODEX_SERVER_REQUESTS } from './codexProtocol';
import { CodexSession } from './CodexSession';
import * as sessionRegistry from '../sessionRegistry';
import { buildFirstTurnPrefix, buildStableSystemPrompt } from '../preamble';
import { getNode, grantPermission, getWorkspaceInstructions } from '../../services/dbRepository';
import { resolveModel, resolveReasoning } from '../../services/agentConfig';
import { canonicalPermissionToolName, resolvePolicy } from '../permissionPolicy';
import { preflightCodexAuth } from './codexBinary';
import { NativeResumeUnavailableError, nativeResumeId } from '../../services/nativeResume';
import type { RuntimeModelCache } from '../runtimeModelCache';
import { titleModelConfig } from '../../services/titleGeneration';
import {
  buildCodexFollowUpsHookPocConfig,
  isCodexFollowUpsHookPocEnabled,
  prepareCodexFollowUpsHookPocEnv,
} from './codexFollowUpsHookPoc';
import {
  followUpsMetadataOutputMode,
  resolveFollowUpsExperimentMode,
  type FollowUpsExperimentMode,
} from '../followUpsExperiment';

// ---- Errors ------------------------------------------------------------------

export class CodexConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexConcurrencyError';
  }
}
export class CodexSessionNotResumableError extends NativeResumeUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = 'CodexSessionNotResumableError';
  }
}

// ---- Capabilities ------------------------------------------------------------

const CODEX_CAPABILITIES: AgentCapabilities = {
  modes: false,
  permissions: true,
  models: true,
  providerModels: false,
  reasoning: true,
  supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'],
  apiKeys: false,
  warmSessions: false,
  saveContext: true,
  spawnBranches: true,
  nativeResume: true,
  nativeResumeSettings: ['model', 'reasoning'],
};

// ---- Approval alias map (spec §5.1) -----------------------------------------
//
// CRITICAL for security: only these methods are allowed to consult resolvePolicy
// (which defaults to ALLOW for unknown tools). Any method NOT in this map must
// always ask the user — never consult resolvePolicy.

const CODEX_APPROVAL_ALIASES: Record<string, string> = {
  [CODEX_SERVER_REQUESTS.commandApproval]: 'bash',
  [CODEX_SERVER_REQUESTS.fileChangeApproval]: 'edit',
};

const RECOVERY_TIMEOUT_MS = 20_000;
const RECOVERY_TIMEOUT_MESSAGE = 'Codex native recovery exceeded 20 seconds. Original thread retained; please retry.';

// ---- CodexRuntime ------------------------------------------------------------

export interface CodexRuntimeTestSeams {
  client?: CodexAppServerClient;
  modelCache?: RuntimeModelCache;
  followUpsHookPocEnabled?: boolean;
  followUpsExperimentMode?: FollowUpsExperimentMode;
}

export class CodexRuntime implements AgentRuntime {
  public readonly id: RuntimeId = 'codex';
  public readonly label = 'Codex';
  public readonly capabilities = CODEX_CAPABILITIES;
  public readonly capabilityDescriptor: CapabilityDescriptor = describeRuntimeCapabilities('codex');

  private readonly client: CodexAppServerClient;
  private readonly bridge: AgentToolBridge;
  private readonly mcpRegistry: McpSlotRegistry;
  private readonly mcpPort: number;
  private readonly concurrencyCap: number;
  private readonly followUpsHookPocEnabled: boolean;
  private readonly followUpsExperimentMode: FollowUpsExperimentMode;

  private readonly sessions = new Map<string, CodexSession>();
  private readonly threadToSession = new Map<string, CodexSession>();
  private readonly pendingSessions = new Map<string, Promise<AgentSession>>();
  private recovery: Promise<void> | null = null;
  private daemonDisconnected = false;

  private readonly modelCacheStore?: RuntimeModelCache;
  private modelCache: ModelInfo[] | null;
  private modelRefreshLock: Promise<ModelInfo[]> | null = null;

  constructor(
    bridge: AgentToolBridge,
    mcpRegistry: McpSlotRegistry,
    mcpPort: number,
    testSeams?: CodexRuntimeTestSeams,
  ) {
    this.bridge = bridge;
    this.mcpRegistry = mcpRegistry;
    this.mcpPort = mcpPort;
    this.concurrencyCap = parseInt(process.env.MICHI_CODEX_MAX_CONCURRENT ?? '10', 10);
    this.modelCacheStore = testSeams?.modelCache;
    this.modelCache = this.modelCacheStore?.load(this.id) ?? null;

    let followUpsHookPocEnabled =
      testSeams?.followUpsHookPocEnabled ?? isCodexFollowUpsHookPocEnabled();
    this.followUpsExperimentMode =
      testSeams?.followUpsExperimentMode ?? resolveFollowUpsExperimentMode();

    if (testSeams?.client) {
      this.client = testSeams.client;
    } else {
      // Pre-flight auth check at construction — fail fast if credentials are absent.
      try {
        preflightCodexAuth();
      } catch (err) {
        console.warn('[CodexRuntime] Auth pre-flight warning:', (err as Error).message);
      }
      let spawnEnv: NodeJS.ProcessEnv | undefined;
      if (followUpsHookPocEnabled) {
        try {
          spawnEnv = prepareCodexFollowUpsHookPocEnv();
          console.info('[CodexRuntime] follow-ups Hook POC using isolated CODEX_HOME', {
            codexHome: spawnEnv.CODEX_HOME,
          });
        } catch (err) {
          followUpsHookPocEnabled = false;
          console.warn(
            '[CodexRuntime] follow-ups Hook POC disabled because isolation setup failed:',
            (err as Error).message,
          );
        }
      }
      this.client = new CodexAppServerClient({ spawnEnv });
    }
    this.followUpsHookPocEnabled = followUpsHookPocEnabled;

    // Wire server-request (approval) handler once, shared across all sessions.
    this.client.onServerRequest((method, params, respond) => {
      if (method === CODEX_SERVER_REQUESTS.requestUserInput) {
        this.handleUserInputRequest(params, respond);
        return;
      }
      if (method === CODEX_SERVER_REQUESTS.mcpElicitation) {
        this.handleMcpElicitationRequest(params, respond);
        return;
      }
      this.handleApprovalRequest(method, params, respond);
    });

    // When daemon exits unexpectedly, crash all live sessions.
    this.client.onExit(() => {
      this.daemonDisconnected = true;
      for (const session of this.sessions.values()) {
        session.markCrashed('codex app-server exited unexpectedly');
      }
    });
  }

  // ---- warm ----------------------------------------------------------------

  async warm(_cwd: string, _opts?: { model?: string | null }): Promise<void> {
    // Codex has no warm pool (warmSessions: false).
    // Ensure the daemon is started as an optimization.
    try {
      await this.client.ensureStarted();
    } catch {
      // Ignore — warm is best-effort
    }
  }

  // ---- newSession ----------------------------------------------------------

  async newSession(opts: NewAgentSessionOptions): Promise<AgentSession> {
    return this.acquireSession(opts, () => this.createSession(opts));
  }

  private async acquireSession(
    opts: NewAgentSessionOptions | LoadAgentSessionOptions,
    create: () => Promise<AgentSession>,
  ): Promise<AgentSession> {
    if (!opts.sessionId) throw new Error('sessionId is required for CodexRuntime');
    const owner: RuntimeSessionOwner = opts.owner ?? { kind: 'chat_node', nodeId: opts.sessionId };
    const id = owner.kind === 'agent_run' ? owner.attemptId : opts.sessionId;
    const compatible = (session: AgentSession): AgentSession => {
      assertOwner(session.owner ?? { kind: 'chat_node', nodeId: session.id }, owner);
      if ((session.runtimeProfileHash ?? null) !== (opts.profileHash ?? null)) {
        throw new Error(`session ${id} runtime profile hash mismatch`);
      }
      return session;
    };
    const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
    while (this.recovery) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(RECOVERY_TIMEOUT_MESSAGE);
      await withDeadline(this.recovery.catch(() => {}), remaining, RECOVERY_TIMEOUT_MESSAGE);
    }
    const pending = this.pendingSessions.get(id);
    if (pending) return compatible(await pending);
    const existing = this.sessions.get(id);
    if (existing) return compatible(existing);
    if (this.sessions.size + this.pendingSessions.size >= this.concurrencyCap) {
      throw new CodexConcurrencyError(`Codex concurrency cap (${this.concurrencyCap}) reached.`);
    }
    const work = create();
    this.pendingSessions.set(id, work);
    try { return compatible(await work); } finally { this.pendingSessions.delete(id); }
  }

  private async createSession(opts: NewAgentSessionOptions): Promise<AgentSession> {
    const nodeId = opts.sessionId ?? (() => { throw new Error('sessionId is required for CodexRuntime'); })();

    // Resolve product owner. For agent_run owners, the public session id is
    // the attemptId. For chat sessions, it is the nodeId.
    const owner: RuntimeSessionOwner = opts.owner ?? { kind: 'chat_node', nodeId };
    const publicId = owner.kind === 'agent_run' ? owner.attemptId : nodeId;

    // Double-load guard
    const existing = this.sessions.get(publicId);
    if (existing) return existing;

    // Concurrency cap
    if (this.sessions.size >= this.concurrencyCap) {
      throw new CodexConcurrencyError(
        `Codex concurrency cap (${this.concurrencyCap}) reached. Try again when an existing session finishes.`,
      );
    }

    await this.client.ensureStarted();

    // Resolve model — fall back to isDefault from model/list if empty
    let modelId = opts.model ?? resolveModel('codex');
    if (!modelId) {
      const models = await this.listModels();
      const def = models.find((m) => m.isDefault);
      modelId = def?.id ?? '';
    }

    // Ancestor chain for preamble (chat sessions only)
    const ancestorChain: AgentSession[] = [];
    if (owner.kind === 'chat_node' && opts.parentChatId) {
      sessionRegistry.ensureAncestorChainLoaded(opts.parentChatId);
      const parent = sessionRegistry.getSession(opts.parentChatId);
      if (parent) {
        ancestorChain.push(...sessionRegistry.getAncestors(opts.parentChatId), parent);
      }
    }

    const workspaceInstructions = opts.workspaceId
      ? getWorkspaceInstructions(opts.workspaceId)
      : null;

    // For agent_run, bootstrapInstructions come from the Executor; for chat,
    // build from ancestor chain and context.
    const firstTurnPrefix = owner.kind === 'agent_run'
      ? (opts.bootstrapInstructions ?? '')
      : buildFirstTurnPrefix({
          cwd: opts.cwd,
          contextManifest: opts.contextManifest,
          extraContexts: opts.extraContexts,
          ancestors: ancestorChain,
          mergeContexts: opts.mergeContexts,
          workspaceInstructions,
        });

    const effort = opts.reasoning !== undefined ? opts.reasoning : resolveReasoning('codex', opts.ownerUserId ?? undefined) ?? null;
    const enableFollowUps = opts.enableFollowUps !== false;

    // Create MCP slot (session pre-wires the callbacks but MCP slot created here)
    // We construct the session first so it can own the slot.
    const session = new CodexSession({
      nodeId: publicId,
      threadId: '', // will be set below after thread/start
      cwd: opts.cwd,
      workspaceId: opts.workspaceId ?? null,
      parentChatId: owner.kind === 'chat_node' ? opts.parentChatId : undefined,
      client: this.client,
      mcpRegistry: this.mcpRegistry,
      bridge: this.bridge,
      mcpPort: this.mcpPort,
      ownerUserId: opts.ownerUserId ?? null,
      firstTurnPrefix,
      effort: effort ? String(effort) : null,
      model: modelId || null,
      generateTitleOnFirstTurn: owner.kind === 'chat_node',
      titleModel: await this.resolveTitleModel(),
      enableFollowUps,
      followUpsHookPocEnabled: this.followUpsHookPocEnabled,
      followUpsExperimentMode: this.followUpsExperimentMode,
      owner,
      profileHash: opts.profileHash,
      toolProfile: opts.toolProfile,
      permissionBroker: opts.permissionBroker,
      recover: (s) => this.recoverSession(s),
    });

    const slotId = session.createMcpSlot();
    const threadConfig = this.buildThreadConfig(slotId);

    // Start the thread on codex app-server
    let threadStartResult: Record<string, unknown>;
    try {
      threadStartResult = await this.client.request('thread/start', {
      model: modelId || undefined,
      cwd: opts.cwd,
      developerInstructions: buildStableSystemPrompt(
        followUpsMetadataOutputMode(
          this.followUpsHookPocEnabled,
          this.followUpsExperimentMode,
        ),
        enableFollowUps,
      ) || undefined,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      config: threadConfig,
      ...(effort ? { reasoningEffort: String(effort) } : {}),
      }) as Record<string, unknown>;
    } catch (error) {
      await session.dispose();
      throw error;
    }

    const thread = threadStartResult['thread'] as Record<string, unknown> | undefined;
    const threadId = (thread?.['id'] as string | undefined) ?? (threadStartResult['threadId'] as string | undefined);
    if (!threadId) {
      await session.dispose();
      throw new Error('codex thread/start did not return a threadId');
    }

    // Rebind session's threadId (the session was constructed with '' as placeholder)
    (session as any).threadId = threadId;
    // Update nativeSessionId after threadId is known
    (session as any).nativeSessionId = threadId;

    // Wire notifications before registering
    session.wireNotifications();

    // The route/Executor commits the complete binding atomically. Publishing
    // an external ID here would overwrite the old binding before that commit.

    this.sessions.set(publicId, session);
    this.threadToSession.set(threadId, session);
    sessionRegistry.registerSession(session, opts.ownerUserId, owner);

    return session;
  }

  // ---- loadSession ---------------------------------------------------------

  async loadSession(opts: LoadAgentSessionOptions): Promise<AgentSession> {
    return this.acquireSession(opts, () => this.restoreSession(opts));
  }

  private async restoreSession(opts: LoadAgentSessionOptions): Promise<AgentSession> {
    const owner: RuntimeSessionOwner = opts.owner ?? { kind: 'chat_node', nodeId: opts.sessionId };
    const publicId = owner.kind === 'agent_run' ? owner.attemptId : opts.sessionId;

    // Double-load guard
    const existing = this.sessions.get(publicId);
    if (existing) return existing;

    // Resolve the native thread id.
    // Agent Run: from nativeResumeToken — NEVER read nodes.external_session_id.
    // Chat: from the node row (existing behavior).
    let threadId: string | null = null;
    let nodeWorkspaceId: string | null = null;
    if (owner.kind === 'agent_run') {
      threadId = typeof opts.nativeResumeToken === 'string' ? opts.nativeResumeToken : null;
      if (!threadId) {
        throw new CodexSessionNotResumableError(
          `Attempt ${publicId} has no nativeResumeToken — cannot resume codex agent_run session`,
        );
      }
    } else {
      const node = getNode(publicId);
      if (node?.runtime_id && node.runtime_id !== 'codex') {
        throw new Error(`Node ${publicId} belongs to runtime ${node.runtime_id}, not Codex. Original binding retained.`);
      }
      threadId = nativeResumeId('codex', node);
      nodeWorkspaceId = node?.workspace_id ?? null;
      if (!threadId) {
        throw new CodexSessionNotResumableError(
          `Node ${publicId} has no native session binding - cannot resume codex session`,
        );
      }
    }

    await this.client.ensureStarted();

    let modelId = opts.model ?? resolveModel('codex');
    if (!modelId) {
      const models = await this.listModels();
      const def = models.find((m) => m.isDefault);
      modelId = def?.id ?? '';
    }

    const effort = opts.reasoning !== undefined ? opts.reasoning : resolveReasoning('codex', opts.ownerUserId ?? undefined) ?? null;

    const session = new CodexSession({
      nodeId: publicId,
      threadId,
      cwd: opts.cwd,
      workspaceId: opts.workspaceId ?? nodeWorkspaceId ?? null,
      client: this.client,
      mcpRegistry: this.mcpRegistry,
      bridge: this.bridge,
      mcpPort: this.mcpPort,
      ownerUserId: opts.ownerUserId ?? null,
      effort: effort ? String(effort) : null,
      model: modelId || null,
      followUpsHookPocEnabled: this.followUpsHookPocEnabled,
      followUpsExperimentMode: this.followUpsExperimentMode,
      owner,
      profileHash: opts.profileHash,
      toolProfile: opts.toolProfile,
      permissionBroker: opts.permissionBroker,
      recover: (s) => this.recoverSession(s),
    });

    const slotId = session.createMcpSlot();
    const threadConfig = this.buildThreadConfig(slotId);

    // Resume the thread
    let resumeResult: Record<string, unknown>;
    try {
      resumeResult = await this.client.request('thread/resume', {
        threadId,
        model: modelId || undefined,
        cwd: opts.cwd,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: 'workspace-write',
        config: threadConfig,
        ...(effort ? { reasoningEffort: String(effort) } : {}),
      }) as Record<string, unknown>;
    } catch (err) {
      const msg = (err as Error).message ?? '';
      await session.dispose();
      if ((err instanceof CodexRpcError ? err.rpcMessage : msg) === `no rollout found for thread id ${threadId}`) {
        throw new CodexSessionNotResumableError(
          `codex thread/resume failed: ${msg}`,
        );
      }
      throw err;
    }

    // Validate that the server echoed back the same threadId
    const resumeThread = resumeResult['thread'] as Record<string, unknown> | undefined;
    const echoedThreadId = (resumeThread?.['id'] as string | undefined) ?? (resumeResult['threadId'] as string | undefined);
    if (echoedThreadId !== threadId) {
      await session.dispose();
      throw new Error('Codex native resume returned a different thread identity');
    }

    // Rebind in case the threadId came back different (treat original as canonical)
    (session as any).threadId = threadId;

    session.wireNotifications();

    this.sessions.set(publicId, session);
    this.threadToSession.set(threadId, session);
    sessionRegistry.registerSession(session, opts.ownerUserId, owner);

    return session;
  }

  private async recoverSession(session: CodexSession): Promise<void> {
    const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
    const remaining = () => {
      const ms = deadline - Date.now();
      if (ms <= 0) throw new Error(RECOVERY_TIMEOUT_MESSAGE);
      return ms;
    };
    while (this.recovery) {
      await withDeadline(this.recovery.catch(() => {}), remaining(), RECOVERY_TIMEOUT_MESSAGE);
    }
    remaining();
    if (!session.needsRecovery()) return;
    const assertRegistered = () => {
      if (this.sessions.get(session.id) !== session) throw new Error('Codex session was released during recovery');
    };
    // Reserve ownership before any recovery work can yield or call external code.
    const work = Promise.resolve().then(async () => {
      assertRegistered();
      let replacedDaemon = this.daemonDisconnected || !this.client.isRunning();
      if (session.requiresRestart && this.client.isRunning() && !this.daemonDisconnected) {
        const unhealthy = new Set([...this.sessions.values()].filter((s) => s.needsRecovery()).map((s) => s.threadId));
        if (this.pendingSessions.size || [...this.sessions.values()].some((s) => s !== session && s.isBusy()) || this.client.hasPendingRequests(unhealthy)) {
          throw new Error('Codex recovery is waiting for other tasks to finish. Their work was not interrupted; retry this message afterward.');
        }
        for (const peer of this.sessions.values()) peer.markCrashed('Codex connection is restarting; native threads retained.');
        await this.client.shutdown();
        // shutdown only succeeds after exit is confirmed. Every old native turn
        // is now stopped, even though each peer still needs its own thread resume.
        for (const peer of this.sessions.values()) peer.requiresRestart = false;
        replacedDaemon = true;
      }
      await this.client.ensureStarted(remaining());
      remaining();
      if (replacedDaemon) {
        for (const peer of this.sessions.values()) {
          if (peer.needsRecovery()) peer.requiresRestart = false;
        }
        this.daemonDisconnected = false;
      }
      assertRegistered();
      const slotId = await session.prepareNativeResume();
      const result = await this.client.request('thread/resume', {
        threadId: session.threadId, cwd: session.cwd,
        model: session.currentModelId || undefined,
        approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write',
        config: this.buildThreadConfig(slotId),
        ...(session.effort ? { reasoningEffort: session.effort } : {}),
      }, remaining()) as { thread?: { id?: string }; threadId?: string };
      if ((result.thread?.id ?? result.threadId) !== session.threadId) throw new Error('Codex native recovery returned a different thread identity. Original binding retained.');
      remaining();
      assertRegistered();
      session.completeNativeResume();
    });
    this.recovery = work;
    // A caller can time out without releasing another operation's native work.
    // Later callers still have bounded waits, and late work checks its deadline.
    void work.finally(() => { if (this.recovery === work) this.recovery = null; }).catch(() => {});
    await withDeadline(work, remaining(), RECOVERY_TIMEOUT_MESSAGE);
  }

  private buildThreadConfig(slotId: string): Record<string, unknown> {
    return {
      ...buildCodexMcpConfig(slotId, this.mcpPort),
      ...(this.followUpsHookPocEnabled
        ? buildCodexFollowUpsHookPocConfig(slotId, this.mcpPort)
        : {}),
    };
  }

  // ---- releaseSession ------------------------------------------------------

  /**
   * Release a live Codex session. When `expectedOwner` is provided, ownership
   * is verified first — a stale Attempt cannot release a session that has been
   * rebound to a different owner.
   */
  async releaseSession(sessionId: string, expectedOwner?: RuntimeSessionOwner): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Ownership guard: reject if expectedOwner doesn't match.
    if (expectedOwner) {
      assertReleaseOwnership(session.owner, expectedOwner);
    }

    const threadId = session.threadId;
    this.sessions.delete(sessionId);
    if (threadId) this.threadToSession.delete(threadId);
    sessionRegistry.dropSession(sessionId);
    await session.dispose();
  }

  // ---- listModels ----------------------------------------------------------

  async listModels(): Promise<ModelInfo[]> {
    if (this.modelCache) {
      void this.refreshModels().catch((err: unknown) => {
        console.warn('[CodexRuntime] model refresh failed; using cached catalog:', (err as Error).message);
      });
      return this.modelCache;
    }
    return this.refreshModels();
  }

  /**
   * Cheap model for the pre-turn title thread. Only returned when the account's
   * catalog actually lists it, otherwise the title thread stays on the
   * session's own model rather than failing on an unknown model id.
   */
  private async resolveTitleModel(): Promise<string | null> {
    const configured = titleModelConfig('codex').model;
    if (!configured) return null;
    try {
      const models = await this.listModels();
      return models.some((m) => m.id === configured) ? configured : null;
    } catch {
      return null;
    }
  }

  async refreshModels(): Promise<ModelInfo[]> {
    if (this.modelRefreshLock) return this.modelRefreshLock;

    this.modelRefreshLock = (async () => {
      await this.client.ensureStarted();
      const result = await this.client.request('model/list', {}) as Record<string, unknown>;
      const raw = Array.isArray(result['data']) ? (result['data'] as CodexModel[]) : [];

      const models: ModelInfo[] = raw
        .filter((m) => !m.hidden)
        .map((m) => ({
          id: m.id,
          label: m.displayName || m.id,
          description: m.description || undefined,
          isDefault: m.isDefault || undefined,
          ...(Array.isArray(m.supportedReasoningEfforts) ? {
            supportedReasoningLevels: sanitizeReasoningLevels(m.supportedReasoningEfforts.map((entry) => entry.reasoningEffort)),
            supportsReasoning: m.supportedReasoningEfforts.length > 0,
          } : {}),
          ...(isReasoningLevel(m.defaultReasoningEffort) ? { defaultReasoning: m.defaultReasoningEffort } : {}),
        }));

      // A transient empty response must not erase the last usable snapshot.
      if (models.length > 0) {
        this.modelCache = models;
        this.modelCacheStore?.save(this.id, models);
      }
      return this.modelCache ?? models;
    })().finally(() => {
      this.modelRefreshLock = null;
    });

    return this.modelRefreshLock;
  }

  // ---- shutdown ------------------------------------------------------------

  async shutdown(): Promise<void> {
    const sessions = [...this.sessions.values()];
    for (const session of sessions) {
      await this.releaseSession(session.id);
    }
    await this.client.shutdown();
  }

  // ---- User input handler ---------------------------------------------------

  private handleUserInputRequest(
    params: Record<string, unknown>,
    respond: (result: unknown) => void,
  ): void {
    const threadId = typeof params['threadId'] === 'string' ? params['threadId'] : null;
    const session = threadId ? this.threadToSession.get(threadId) : null;
    if (!session || !session.acceptsControl(params)) {
      respond({ answers: null });
      return;
    }
    void session.askUserInput(params, respond);
  }

  private handleMcpElicitationRequest(
    params: Record<string, unknown>,
    respond: (result: unknown) => void,
  ): void {
    const threadId = typeof params['threadId'] === 'string' ? params['threadId'] : null;
    const session = threadId ? this.threadToSession.get(threadId) : null;
    if (!session || !session.acceptsControl(params)) {
      respond({ action: 'decline', content: null, _meta: null });
      return;
    }
    void session.askMcpElicitation(params, respond);
  }

  // ---- Approval handler ----------------------------------------------------

  private handleApprovalRequest(
    method: string,
    params: Record<string, unknown>,
    respond: (result: unknown) => void,
  ): void {
    const threadId = typeof params['threadId'] === 'string' ? params['threadId'] : null;
    const session = threadId ? this.threadToSession.get(threadId) : null;
    if (!session || !session.acceptsControl(params)) { respond({ decision: 'decline' }); return; }

    // Agent Run owner: delegate directly to the session's permission broker.
    // MUST NOT call resolvePolicy() or grantPermission().
    if (session?.owner?.kind === 'agent_run') {
      void session.askPermission(method, params, respond);
      return;
    }

    // Chat session: existing workspace policy and grant behavior.
    // Look up the canonical tool name for policy checks.
    // CRITICAL: only methods in CODEX_APPROVAL_ALIASES may consult resolvePolicy.
    // Unknown methods (not in the map) always ask the user — never trust the default.
    const canonicalTool = CODEX_APPROVAL_ALIASES[method];

    if (canonicalTool !== undefined) {
      // Known method — check workspace policy first.
      const workspaceId = session?.workspaceId ?? null;
      const policy = resolvePolicy(workspaceId, canonicalTool, params);
      if (policy === 'allow') {
        respond({ decision: 'accept' });
        return;
      }
      if (policy === 'deny') {
        respond({ decision: 'decline' });
        return;
      }
      // policy === 'ask': fall through to session.askPermission below
    }
    // Unknown methods always ask (never consult resolvePolicy).

    if (!session) {
      // No session found — fail safe: decline
      respond({ decision: 'decline' });
      return;
    }

    // Delegate to session for user-facing permission request
    void session.askPermission(method, params, respond);
  }
}
