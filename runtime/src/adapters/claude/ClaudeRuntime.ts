import { RuntimeModelCatalog } from '../../core/modelCatalog';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as claudeProjectsPath from './claudeProjectsPath';
import { getClaudeJsonlPath } from './claudeProjectsPath';
import type {
  AgentCapabilities,
  AgentRuntime,
  AgentSession,
  ForkAgentSessionOptions,
  LoadAgentSessionOptions,
  ModelInfo,
  NewAgentSessionOptions,
  RuntimeAvailability,
  RuntimeResumeBinding,
  RuntimeSessionOwner,
  RuntimeId,
  SessionMode,
} from '../../contract/types';
import type { AgentToolBridge } from '../../contract/tools';
import type { McpSlotProvider } from '../../contract/mcp';
import { ownerMode, type BackgroundTurnConsumer, type RuntimeHost } from '../../contract/host';
import { interactiveOwner } from '../../contract/types';
import { assertHostPorts } from '../../core/defaultHost';
import type { ClaudeAdapterOptions, ClaudeModelCatalogOptions } from './claudeAdapterOptions';
import { CLAUDE_MODEL_CATALOG, resolveClaudeCliModelId, setDiscoveredClaudeModels } from './claudeModelCatalog';
import { probeClaudeModels } from './claudeModelProbe';
import { findClaudeBinary, preflightClaudeAuth } from './claudeBinary';
import { ClaudeSessionManager, ClaudeConcurrencyError } from './ClaudeSessionManager';
import type { RuntimeDescriptor } from '../../contract/descriptor';
import { CLAUDE_RUNTIME_DESCRIPTOR } from './claudeDescriptor';
import { NativeResumeUnavailableError } from '../../contract/errors';
import { forkClaudeHistory } from './claudeSdkHistory';
import { normalizeWorkspaceCwd } from '../../core/pathSandbox';

// ---- Errors ------------------------------------------------------------------

export { ClaudeConcurrencyError };

export class ClaudeSessionNotResumableError extends NativeResumeUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeSessionNotResumableError';
  }
}

// ---- Capabilities ------------------------------------------------------------

const CLAUDE_CAPABILITIES: AgentCapabilities = {
  modes: false,
  permissions: true,
  models: true,
  providerModels: false,
  reasoning: true,
  // claude --effort accepts: low | medium | high | xhigh | max
  supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  apiKeys: false,
  warmSessions: true,
  saveContext: true,
  spawnBranches: true,
  nativeResume: true,
  nativeResumeSettings: ['model', 'reasoning'],
};

// ---- ClaudeRuntime -----------------------------------------------------------

export type { ClaudeAdapterOptions, ClaudeModelCatalogOptions };

/** What ClaudeRuntime is built from: the adapter's options plus the host's tool effects and MCP slots. */
export interface ClaudeRuntimeOptions extends ClaudeAdapterOptions {
  /** Business effects of the host's tools (spawn branches, save/update artifacts, Agent Run tools). */
  bridge: AgentToolBridge;
  /** The host's MCP slots; every Claude session's host tools go through them. */
  mcpSlots: McpSlotProvider;
}

/** Every host port the Claude adapter calls (it has no title port use: the CLI titles chats itself). */
const CLAUDE_HOST_PORTS = [
  'config', 'prompt', 'profile', 'bindings', 'sessions', 'permissions', 'principal', 'observability',
  'backgroundTurns', 'workflows', 'backgroundSubagents',
] as const;

export class ClaudeRuntime implements AgentRuntime {
  public readonly id: RuntimeId = 'claude';
  public readonly label = 'Claude';
  public readonly capabilities = CLAUDE_CAPABILITIES;
  public readonly descriptor: RuntimeDescriptor = CLAUDE_RUNTIME_DESCRIPTOR;

  private readonly manager: ClaudeSessionManager;
  /** Stops following the host's default model (host.config.onDefaultModelChanged). */
  private readonly unsubscribeDefaultModel: () => void;
  /** Auth pre-flight failure from construction, surfaced by checkAvailability. */
  private authError: string | undefined;
  private readonly modelCatalog?: RuntimeModelCatalog;
  /** Never start another expensive CLI probe merely because a picker reopened. */
  private listProbeAttempted = false;

  /**
   * Both halves of Claude's readiness were already computed and then discarded:
   * the binary lookup throws ClaudeBinaryNotFoundError, and the auth pre-flight
   * result went to console.warn. Report them instead of hardcoding available.
   * findClaudeBinary caches internally, so this stays cheap per status poll.
   */
  checkAvailability(): RuntimeAvailability {
    try {
      findClaudeBinary(this.options.binaryPath());
    } catch (err) {
      return { available: false, detail: (err as Error).message };
    }
    if (this.authError) return { available: false, detail: this.authError };
    return { available: true };
  }

  private readonly host: RuntimeHost;
  private readonly options: ClaudeAdapterOptions;
  /** The host's owner of self-started turns, also asked by the native fork guard (asserted present). */
  private readonly backgroundTurns: BackgroundTurnConsumer;

  constructor(options: ClaudeRuntimeOptions) {
    // tsc cannot see untyped (JS or require'd) callers of the old positional
    // form, nor members left undefined.
    if (typeof options !== 'object' || options === null || options.host == null || options.bridge == null || options.mcpSlots == null) {
      throw new TypeError('ClaudeRuntime takes one options object { host, bridge, mcpSlots, … } (runtime contract v1)');
    }
    const { bridge, mcpSlots: mcpRegistry } = options;
    // Besides the mandatory ports: self-turns and the native fork guard need
    // backgroundTurns (without it the guard would pass every fork); the
    // workflow tap and background subagents report to their sinks.
    assertHostPorts(options.host, CLAUDE_HOST_PORTS, 'ClaudeRuntime');
    this.host = options.host;
    this.options = options;
    this.backgroundTurns = options.host.backgroundTurns!;
    const modelCatalog = options.modelCatalog;
    if (modelCatalog) {
      this.modelCatalog = new RuntimeModelCatalog({
        initial: modelCatalog.cache?.load(this.id),
        probe: modelCatalog.probe ?? (() => probeClaudeModels(this.options)),
        normalize: (models) => models,
        persist: (models) => modelCatalog.cache?.save(this.id, models),
        onUpdate: setDiscoveredClaudeModels,
        fallback: staticClaudeModels,
      });
    }
    const { maxConcurrent: concurrencyCap, pool } = options.limits;
    // Pre-flight auth check at construction — fail fast if credentials are absent
    // rather than letting the first spawn hang on a stdin auth prompt. The
    // result is also retained (it used to be discarded into console.warn) so
    // checkAvailability can report it instead of claiming the runtime is ready.
    try {
      preflightClaudeAuth(options.configDir?.(), options.spawnEnv());
    } catch (err) {
      this.authError = (err as Error).message;
      console.warn('[ClaudeRuntime] Auth pre-flight warning:', this.authError);
    }

    this.manager = new ClaudeSessionManager({
      bridge,
      mcpRegistry,
      options,
      concurrencyCap,
      currentModel: this.host.config.defaultModel(this.id),
      poolDisabled: pool.disabled,
      waitForWarm: pool.waitForWarm,
      sessionsPerSlot: pool.sessionsPerCwd,
      onSelfTurn: (info) => this.backgroundTurns.consume(info),
    });

    // Keep the pool's model_set aligned with the user's global model choice.
    this.unsubscribeDefaultModel = this.host.config.onDefaultModelChanged((evt) => {
      if (evt.runtime !== 'claude') return;
      void this.manager.notifyModelChange(evt.model);
    });
  }

  async warm(cwd: string, opts?: { model?: string | null }): Promise<void> {
    await this.manager.warm(cwd, opts?.model ?? this.host.config.defaultModel(this.id));
  }

  async newSession(opts: NewAgentSessionOptions): Promise<AgentSession> {
    return this.createSession(opts);
  }

  resumeTokenFromBinding(binding: RuntimeResumeBinding | null | undefined): string | null {
    return ClaudeRuntime.resumeTokenFromBinding(binding);
  }

  /**
   * Claude's native session id in a stored binding: external_session_id, else
   * the legacy ACP column. Claude has no native identity until init; the
   * node's own id, the placeholder that occupies the ACP column until then,
   * is not a resumable CLI session.
   */
  static resumeTokenFromBinding(binding: RuntimeResumeBinding | null | undefined): string | null {
    const id = binding?.external_session_id ?? binding?.acp_session_id ?? null;
    return id === binding?.id ? null : id;
  }

  async forkSession(opts: ForkAgentSessionOptions): Promise<AgentSession> {
    if (!opts.sessionId || !opts.parentChatId || (opts.owner && ownerMode(opts.owner) === 'headless')) {
      throw new NativeResumeUnavailableError('Only chat children can inherit Claude native history');
    }
    // Cloud history helpers currently namespace by owner, while the CLI's
    // native resume still reads its ordinary project directory. Until those
    // layouts are aligned, use the caller's exact text fallback rather than
    // publishing a child native identity the CLI cannot actually restore.
    if (this.host.principal.enforceUserOwnership()) {
      throw new NativeResumeUnavailableError('Claude cloud native fork is unavailable');
    }
    // An assistant conversation's native history stays with the assistant's
    // lockdown: never forked into an ordinary chat, nor an ordinary chat's
    // into the assistant (assistant/policy.ts).
    if (this.host.profile.isRestricted(opts.toolProfile) || this.host.profile.isRestrictedWorkspace(opts.workspaceId)) {
      throw new NativeResumeUnavailableError('The Michi assistant does not fork native Claude history');
    }
    const owner = resolveSessionOwner(opts.owner, opts.sessionId);
    await this.manager.waitForRelease(opts.sessionId);
    const existing = this.manager.getCompatible(opts.sessionId, owner, opts.profileHash ?? null, opts.ownerUserId ?? null);
    if (existing) return existing;
    const parent = this.host.bindings.nodeBinding(opts.parentChatId);
    const child = this.host.bindings.nodeBinding(opts.sessionId);
    const workspace = parent ? this.host.bindings.workspace(parent.workspace_id) : undefined;
    if (!parent || !child || ownerMode(owner) !== 'interactive' || owner.key !== child.id
      || child.parent_node_id !== parent.id || child.id === parent.id
      || parent.kind !== 'chat' || child.kind !== 'chat' || parent.runtime_id !== 'claude'
      || parent.workspace_id !== child.workspace_id || parent.tree_id !== child.tree_id
      || parent.workspace_id !== opts.workspaceId || this.host.profile.isRestrictedWorkspace(parent.workspace_id)
      || parent.deleted_at || parent.purged_at
      || child.deleted_at || child.purged_at || this.resumeTokenFromBinding(parent) !== opts.sourceNativeSessionId
      || !workspace || workspace.deleted_at || workspace.archived_at
      || !this.host.principal.workspaceOwnerMatches(workspace.owner_user_id ?? null, this.host.principal.resolve(opts.ownerUserId))
      || normalizeWorkspaceCwd(workspace.cwd ?? process.cwd()) !== normalizeWorkspaceCwd(opts.cwd)
      || parent.status === 'streaming' || this.backgroundTurns.isActive(parent.id)
      || this.backgroundTurns.isOwnerTurnActive(parent.id) || this.backgroundTurns.hasPendingSelfTurn(parent.id)) {
      throw new NativeResumeUnavailableError('Claude parent history is not available to this child');
    }
    if (opts.anchorMessageId) {
      const nativeMessageId = this.host.bindings.forkAnchors.readClaudeForkAnchor({
        nodeId: opts.parentChatId, nativeSessionId: opts.sourceNativeSessionId,
        messageId: opts.anchorMessageId, workspaceId: opts.workspaceId, ownerUserId: opts.ownerUserId,
      });
      if (!nativeMessageId) {
        throw new NativeResumeUnavailableError('No native Claude anchor for the selected historical message');
      }
      const forkId = await forkClaudeHistory(this.options, {
        cwd: opts.cwd, sourceNativeSessionId: opts.sourceNativeSessionId,
        nativeMessageId, ownerUserId: opts.ownerUserId,
      });
      return this.createSession({ ...opts, branchContext: undefined }, undefined, forkId);
    }
    const file = getClaudeJsonlPath(this.options, opts.cwd, opts.sourceNativeSessionId, opts.ownerUserId);
    if (!fs.existsSync(file)) throw new NativeResumeUnavailableError('Claude parent session file is unavailable');
    return this.createSession({ ...opts, branchContext: undefined }, opts.sourceNativeSessionId);
  }

  private async createSession(opts: NewAgentSessionOptions, forkFrom?: string, resumeFrom?: string): Promise<AgentSession> {
    const owner = resolveSessionOwner(opts.owner, opts.sessionId);
    const id = ownerMode(owner) === 'headless' ? owner.key : (opts.sessionId ?? owner.key);

    // Invariant 9: double-load guard
    await this.manager.waitForRelease(id);
    const existing = this.manager.getCompatible(id, owner, opts.profileHash ?? null, opts.ownerUserId ?? null);
    if (existing) return existing;

    const cwd = opts.cwd;

    // Ancestor chain is needed by the per-chat preamble regardless of warm
    // hit vs cold spawn — except when the server resolved an exact branch
    // prefix, which must replace the live chain rather than duplicate it.
    const ancestorChain: AgentSession[] = [];
    if (!forkFrom && !resumeFrom && !opts.branchContext && ownerMode(owner) === 'interactive' && opts.parentChatId) {
      this.host.sessions.ensureAncestorChainLoaded(opts.parentChatId);
      const parent = this.host.sessions.getSession(opts.parentChatId);
      if (parent) {
        ancestorChain.push(...this.host.sessions.getAncestors(opts.parentChatId), parent);
      }
    }

    // Per-chat preamble is prepended to the first real user message by
    // ClaudeSession.send(). This is what carries cwd files, ancestor history,
    // merged contexts.
    const workspaceInstructions = opts.workspaceId
      ? this.host.prompt.workspaceInstructions(opts.workspaceId)
      : null;

    const branchContextText = opts.branchContext
      ? this.host.prompt.renderBranchContext(opts.branchContext)
      : null;
    const firstTurnPrefix = this.host.prompt.firstTurnPrefix({
      cwd,
      contextManifest: opts.contextManifest,
      extraContexts: opts.extraContexts,
      ancestors: ancestorChain,
      mergeContexts: [
        ...(branchContextText ? [branchContextText] : []),
        ...(opts.mergeContexts ?? []),
      ],
      workspaceInstructions,
    });
    const effectiveFirstTurnPrefix = this.host.profile.composeFirstTurnPrefix(firstTurnPrefix, opts.bootstrapInstructions, opts.toolProfile);

    if (resumeFrom) {
      const session = await this.manager.loadSession({
        id, owner, cwd, parentChatId: opts.parentChatId, workspaceId: opts.workspaceId ?? null,
        model: opts.model ?? undefined, externalSessionId: resumeFrom,
        ownerUserId: opts.ownerUserId ?? null, bootstrapInstructions: effectiveFirstTurnPrefix,
        replayHistory: opts.replayHistory, toolProfile: opts.toolProfile,
        permissionBroker: opts.permissionBroker, profileHash: opts.profileHash ?? null,
        reasoning: opts.reasoning ?? null,
      });
      if (opts.enableFollowUps === false) session.setEnableFollowUps(false);
      return session;
    }

    return this.manager.createSession({
      forkFromNativeSessionId: forkFrom,
      id,
      owner,
      cwd,
      parentChatId: ownerMode(owner) === 'interactive' ? opts.parentChatId : undefined,
      workspaceId: opts.workspaceId ?? null,
      model: opts.model ?? undefined,
      firstTurnPrefix: effectiveFirstTurnPrefix,
      ownerUserId: opts.ownerUserId ?? null,
      enableFollowUps: opts.enableFollowUps,
      replayHistory: opts.replayHistory,
      toolProfile: opts.toolProfile,
      permissionBroker: opts.permissionBroker,
      profileHash: opts.profileHash ?? null,
      reasoning: opts.reasoning ?? null,
    });
  }

  async loadSession(opts: LoadAgentSessionOptions): Promise<AgentSession> {
    const owner = resolveSessionOwner(opts.owner, opts.nodeId ?? opts.sessionId);
    // Invariant 9: double-load guard
    await this.manager.waitForRelease(opts.sessionId);
    const existing = this.manager.getCompatible(opts.sessionId, owner, opts.profileHash ?? null, opts.ownerUserId ?? null);
    if (existing) return existing;

    // Chat sessions resolve their native id from the node. Run attempts carry
    // the opaque resume token explicitly and never query a nodes row.
    const node = ownerMode(owner) === 'interactive' ? this.host.bindings.nodeBinding(owner.key) : null;
    const explicitResumeToken = typeof opts.nativeResumeToken === 'string'
      ? opts.nativeResumeToken
      : null;
    const externalSessionId = ownerMode(owner) === 'headless'
      ? explicitResumeToken
      : this.resumeTokenFromBinding(node);
    if (!externalSessionId) {
      throw new ClaudeSessionNotResumableError(
        `Node ${opts.sessionId} has no external_session_id — cannot resume claude session`,
      );
    }
    // Without its transcript in any project directory (deleted, or never
    // written), `--resume` can only fail: say so, and the session is rebuilt
    // from Michi's history instead of failing every retry.
    if (!(await claudeProjectsPath.claudeTranscriptFindable(this.options, opts.cwd, externalSessionId, opts.ownerUserId))) {
      throw new ClaudeSessionNotResumableError(`Claude session ${externalSessionId} has no transcript to resume`);
    }

    return this.manager.loadSession({
      id: opts.sessionId,
      owner,
      cwd: opts.cwd,
      workspaceId: opts.workspaceId ?? node?.workspace_id ?? null,
      model: opts.model ?? undefined,
      externalSessionId,
      ownerUserId: opts.ownerUserId ?? null,
      replayHistory: opts.replayHistory,
      bootstrapInstructions: opts.bootstrapInstructions,
      toolProfile: opts.toolProfile,
      permissionBroker: opts.permissionBroker,
      profileHash: opts.profileHash ?? null,
      reasoning: opts.reasoning ?? null,
      enableFollowUps: opts.enableFollowUps,
    });
  }

  async releaseSession(sessionId: string, expectedOwner?: RuntimeSessionOwner): Promise<void> {
    await this.manager.releaseSession(sessionId, expectedOwner);
  }

  async listModes(_sessionId: string): Promise<SessionMode[]> {
    return [];
  }

  async listModels(): Promise<ModelInfo[]> {
    // Serve the snapshot without re-probing: a probe is a full CLI start-up,
    // and listModels runs on every picker open. server.ts calls
    // refreshModels() once per backend start to update the snapshot.
    if (this.modelCatalog?.cached) return this.modelCatalog.cached;
    if (this.modelCatalog && (!this.listProbeAttempted || this.modelCatalog.refreshing)) {
      try {
        return await this.refreshModels();
      } catch (err) {
        this.host.observability.log('warn', 'chat', 'claude model probe failed; using static catalog', { error: (err as Error).message });
      }
    }
    return staticClaudeModels();
  }

  /**
   * Ask the CLI for the account's current model list and persist it. A failed
   * or empty probe keeps the previous snapshot. No-op (static list) when the
   * runtime was built without live catalog wiring.
   */
  async refreshModels(): Promise<ModelInfo[]> {
    if (!this.modelCatalog) return staticClaudeModels();
    this.listProbeAttempted = true;
    return this.modelCatalog.refresh();
  }

  /** Legacy aliases (`opus`, `sonnet`, …) map onto the concrete ids the CLI lists. */
  canonicalModelId(modelId: string): string {
    return resolveClaudeCliModelId(modelId);
  }

  async shutdown(): Promise<void> {
    this.unsubscribeDefaultModel();
    await this.manager.shutdown();
  }
}

function staticClaudeModels(): ModelInfo[] {
  return Object.entries(CLAUDE_MODEL_CATALOG).map(([id, entry]) => ({
    id,
    label: id,
    description: `Context: ${(entry.contextWindow / 1000).toFixed(0)}K tokens`,
    supportsReasoning: entry.supportsReasoning,
    supportedReasoningLevels: entry.supportedReasoningLevels,
    defaultReasoning: entry.defaultReasoning,
  }));
}

function resolveSessionOwner(owner: RuntimeSessionOwner | undefined, sessionId?: string): RuntimeSessionOwner {
  if (owner) {
    if (ownerMode(owner) === 'headless' && sessionId && sessionId !== owner.key) {
      throw new Error('Agent Run public session id must equal attemptId');
    }
    return owner;
  }
  return interactiveOwner(sessionId ?? randomUUID());
}
