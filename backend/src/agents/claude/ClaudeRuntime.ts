import { randomUUID } from 'node:crypto';
import type {
  AgentCapabilities,
  AgentRuntime,
  AgentSession,
  LoadAgentSessionOptions,
  ModelInfo,
  NewAgentSessionOptions,
  RuntimeSessionOwner,
  RuntimeId,
  SessionMode,
} from '../types';
import type { AgentToolBridge } from '../toolBridge';
import type { McpSlotRegistry } from '../../services/mcpServer';
import { CLAUDE_MODEL_CATALOG } from './claudeModelCatalog';
import { getNode } from '../../services/dbRepository';
import * as sessionRegistry from '../sessionRegistry';
import { preflightClaudeAuth } from './claudeBinary';
import { buildFirstTurnPrefix } from '../preamble';
import { getWorkspaceInstructions } from '../../services/dbRepository';
import { agentConfigEvents, resolveModel, resolveClaudeConfigDir } from '../../services/agentConfig';
import type { ModelChangedEvent } from '../../services/agentConfig';
import { ClaudeSessionManager, ClaudeConcurrencyError } from './ClaudeSessionManager';
import { chatHub } from '../chatHub';
import type { CapabilityDescriptor } from 'michi-shared';
import { describeRuntimeCapabilities } from '../capabilityDescriptors';
import { NativeResumeUnavailableError } from '../../services/nativeResume';

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

export class ClaudeRuntime implements AgentRuntime {
  public readonly id: RuntimeId = 'claude';
  public readonly label = 'Claude';
  public readonly capabilities = CLAUDE_CAPABILITIES;
  public readonly capabilityDescriptor: CapabilityDescriptor = describeRuntimeCapabilities('claude');

  private readonly manager: ClaudeSessionManager;
  private readonly modelChangedHandler: (evt: ModelChangedEvent) => void;

  constructor(
    bridge: AgentToolBridge,
    mcpRegistry: McpSlotRegistry,
    mcpPort: number,
  ) {
    const concurrencyCap = parseInt(process.env.MICHI_CLAUDE_MAX_CONCURRENT ?? '15', 10);
    const sessionsPerSlot = parseInt(process.env.MICHI_CLAUDE_POOL_SESSIONS_PER_CWD ?? '2', 10);
    const waitForWarmFlag = (process.env.MICHI_CLAUDE_WAIT_FOR_WARM ?? '').trim().toLowerCase();
    const waitForWarm = !['0', 'false', 'off', 'no'].includes(waitForWarmFlag);
    // Pre-flight auth check at construction — fail fast if credentials are absent
    // rather than letting the first spawn hang on a stdin auth prompt.
    try {
      preflightClaudeAuth(resolveClaudeConfigDir());
    } catch (err) {
      console.warn('[ClaudeRuntime] Auth pre-flight warning:', (err as Error).message);
    }

    this.manager = new ClaudeSessionManager({
      bridge,
      mcpRegistry,
      mcpPort,
      concurrencyCap,
      currentModel: resolveModel('claude'),
      poolDisabled: process.env.MICHI_CLAUDE_POOL_DISABLED === '1',
      waitForWarm,
      sessionsPerSlot,
      onSelfTurn: (info) => chatHub.startSelfTurn(info),
    });

    // Keep the pool's model_set aligned with the user's global model choice.
    this.modelChangedHandler = (evt) => {
      if (evt.runtime !== 'claude') return;
      void this.manager.notifyModelChange(evt.model);
    };
    agentConfigEvents.on('model_changed', this.modelChangedHandler);
  }

  async warm(cwd: string, opts?: { model?: string | null }): Promise<void> {
    await this.manager.warm(cwd, opts?.model ?? resolveModel('claude'));
  }

  async newSession(opts: NewAgentSessionOptions): Promise<AgentSession> {
    const owner = resolveSessionOwner(opts.owner, opts.sessionId);
    const id = owner.kind === 'agent_run' ? owner.attemptId : (opts.sessionId ?? owner.nodeId);

    // Invariant 9: double-load guard
    const existing = this.manager.getCompatible(id, owner, opts.profileHash ?? null);
    if (existing) return existing;

    const cwd = opts.cwd;

    // Ancestor chain is needed by the per-chat preamble regardless of warm
    // hit vs cold spawn.
    const ancestorChain: AgentSession[] = [];
    if (owner.kind === 'chat_node' && opts.parentChatId) {
      sessionRegistry.ensureAncestorChainLoaded(opts.parentChatId);
      const parent = sessionRegistry.getSession(opts.parentChatId);
      if (parent) {
        ancestorChain.push(...sessionRegistry.getAncestors(opts.parentChatId), parent);
      }
    }

    // Per-chat preamble is prepended to the first real user message by
    // ClaudeSession.send(). This is what carries cwd files, ancestor history,
    // merged contexts.
    const workspaceInstructions = opts.workspaceId
      ? getWorkspaceInstructions(opts.workspaceId)
      : null;

    const firstTurnPrefix = buildFirstTurnPrefix({
      cwd,
      contextManifest: opts.contextManifest,
      extraContexts: opts.extraContexts,
      ancestors: ancestorChain,
      mergeContexts: opts.mergeContexts,
      workspaceInstructions,
    });
    const effectiveFirstTurnPrefix = [firstTurnPrefix, opts.bootstrapInstructions].filter(Boolean).join('\n\n');

    return this.manager.createSession({
      id,
      owner,
      cwd,
      parentChatId: owner.kind === 'chat_node' ? opts.parentChatId : undefined,
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
    const existing = this.manager.getCompatible(opts.sessionId, owner, opts.profileHash ?? null);
    if (existing) return existing;

    // Chat sessions resolve their native id from the node. Run attempts carry
    // the opaque resume token explicitly and never query a nodes row.
    const node = owner.kind === 'chat_node' ? getNode(owner.nodeId) : null;
    const explicitResumeToken = typeof opts.nativeResumeToken === 'string'
      ? opts.nativeResumeToken
      : null;
    const externalSessionId = owner.kind === 'agent_run'
      ? explicitResumeToken
      : node?.external_session_id ?? null;
    if (!externalSessionId) {
      throw new ClaudeSessionNotResumableError(
        `Node ${opts.sessionId} has no external_session_id — cannot resume claude session`,
      );
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
    });
  }

  async releaseSession(sessionId: string, expectedOwner?: RuntimeSessionOwner): Promise<void> {
    await this.manager.releaseSession(sessionId, expectedOwner);
  }

  async listModes(_sessionId: string): Promise<SessionMode[]> {
    return [];
  }

  async listModels(): Promise<ModelInfo[]> {
    return Object.entries(CLAUDE_MODEL_CATALOG).map(([id, entry]) => ({
      id,
      label: id,
      description: `Context: ${(entry.contextWindow / 1000).toFixed(0)}K tokens`,
      supportsReasoning: entry.supportsReasoning,
      supportedReasoningLevels: entry.supportedReasoningLevels,
      defaultReasoning: entry.defaultReasoning,
    }));
  }

  async shutdown(): Promise<void> {
    agentConfigEvents.off('model_changed', this.modelChangedHandler);
    await this.manager.shutdown();
  }
}

function resolveSessionOwner(owner: RuntimeSessionOwner | undefined, sessionId?: string): RuntimeSessionOwner {
  if (owner) {
    if (owner.kind === 'agent_run' && sessionId && sessionId !== owner.attemptId) {
      throw new Error('Agent Run public session id must equal attemptId');
    }
    return owner;
  }
  return { kind: 'chat_node', nodeId: sessionId ?? randomUUID() };
}
