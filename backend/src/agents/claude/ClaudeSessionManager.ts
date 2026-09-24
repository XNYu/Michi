import { randomUUID } from 'node:crypto';
import type {
  AgentReasoning,
  AgentSession,
  ChatMessage,
  RuntimePermissionBroker,
  RuntimeSessionOwner,
  RuntimeToolProfile,
} from '../types';
import type { AgentToolBridge } from '../toolBridge';
import type { McpSlotRegistry } from '../../services/mcpServer';
import { resolveModel } from '../../services/agentConfig';
import * as sessionRegistry from '../sessionRegistry';
import { buildStableSystemPrompt, type MetadataOutputMode } from '../preamble';
import {
  followUpsMetadataOutputMode,
  resolveFollowUpsExperimentMode,
} from '../followUpsExperiment';
import { ClaudeSession, type SelfTurnCallback } from './ClaudeSession';
import { isClaudeFollowUpsHookPocEnabled } from './claudeFollowUpsHookPoc';
import { ClaudeWarmPool } from './ClaudeWarmPool';
import * as perf from '../../services/perf';

export class ClaudeConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeConcurrencyError';
  }
}

export interface ClaudeSessionManagerDeps {
  bridge: AgentToolBridge;
  mcpRegistry: McpSlotRegistry;
  mcpPort: number;
  concurrencyCap: number;
  currentModel: string;
  poolDisabled?: boolean;
  waitForWarm?: boolean;
  sessionsPerSlot?: number;
  onSelfTurn?: SelfTurnCallback;
}

export interface CreateClaudeSessionOptions {
  id: string;
  forkFromNativeSessionId?: string;
  owner?: RuntimeSessionOwner;
  cwd: string;
  parentChatId?: string;
  workspaceId?: string | null;
  model?: string | null;
  firstTurnPrefix?: string;
  ownerUserId?: string | null;
  /** Default true. Gates only the per-turn follow-up reminder. */
  enableFollowUps?: boolean;
  replayHistory?: ChatMessage[];
  toolProfile?: RuntimeToolProfile;
  permissionBroker?: RuntimePermissionBroker;
  profileHash?: string | null;
  reasoning?: AgentReasoning | null;
}

export interface LoadClaudeSessionOptions {
  id: string;
  owner?: RuntimeSessionOwner;
  cwd: string;
  workspaceId?: string | null;
  model?: string | null;
  externalSessionId: string;
  ownerUserId?: string | null;
  replayHistory?: ChatMessage[];
  bootstrapInstructions?: string;
  toolProfile?: RuntimeToolProfile;
  permissionBroker?: RuntimePermissionBroker;
  profileHash?: string | null;
  reasoning?: AgentReasoning | null;
}

export interface ClaudeSessionManagerStats {
  cap: number;
  active: number;
  warm: number;
  pending: number;
  total: number;
}

export class ClaudeSessionManager {
  private readonly active = new Map<string, ClaudeSession>();
  private readonly pendingSessions = new Set<ClaudeSession>();
  private readonly pool: ClaudeWarmPool;
  private readonly metadataOutputMode: MetadataOutputMode;
  private pendingSpawns = 0;
  private shuttingDown = false;

  constructor(private readonly deps: ClaudeSessionManagerDeps) {
    this.metadataOutputMode = followUpsMetadataOutputMode(
      isClaudeFollowUpsHookPocEnabled(),
      resolveFollowUpsExperimentMode(),
    );
    this.pool = new ClaudeWarmPool({
      spawner: (cwd, model) => this.spawnWarmSession(cwd, model),
      currentModel: deps.currentModel,
      disabled: deps.poolDisabled,
      sessionsPerSlot: deps.sessionsPerSlot,
    });
  }

  get(id: string): ClaudeSession | undefined {
    return this.active.get(id);
  }

  getCompatible(
    id: string,
    owner: RuntimeSessionOwner,
    profileHash: string | null,
  ): ClaudeSession | undefined {
    const existing = this.active.get(id);
    if (!existing) return undefined;
    if (!existing.matchesOwner(owner)) {
      throw new Error(`session ${id} is already bound to a different owner`);
    }
    if ((existing.runtimeProfileHash ?? null) !== profileHash) {
      throw new Error(`session ${id} runtime profile hash mismatch`);
    }
    return existing;
  }

  stats(): ClaudeSessionManagerStats {
    const active = this.active.size;
    const warm = this.pool.size();
    const pending = this.pendingSpawns;
    return {
      cap: this.deps.concurrencyCap,
      active,
      warm,
      pending,
      total: active + warm + pending,
    };
  }

  async warm(cwd: string, model?: string | null): Promise<void> {
    if (this.deps.poolDisabled) return;
    const targetModel = model ?? resolveModel('claude');
    if (targetModel) {
      await this.pool.notifyModelChange(targetModel);
    }
    await this.pool.registerWorkspace(cwd);
  }

  async notifyModelChange(model: string): Promise<void> {
    await this.pool.notifyModelChange(model);
  }

  async createSession(opts: CreateClaudeSessionOptions): Promise<ClaudeSession> {
    if (this.shuttingDown) {
      throw new ClaudeConcurrencyError('ClaudeRuntime is shutting down');
    }
    const owner = opts.owner ?? { kind: 'chat_node' as const, nodeId: opts.id };
    const existing = this.getCompatible(opts.id, owner, opts.profileHash ?? null);
    if (existing) return existing;

    const model = opts.model ?? resolveModel('claude');
    // Warm sessions are intentionally profile-neutral chat resources. A Run
    // attempt has immutable tools/permissions/profile state and must cold-spawn
    // unless a future pool explicitly keys those dimensions.
    let session = owner.kind === 'chat_node' && !opts.profileHash && !opts.forkFromNativeSessionId
      ? this.pool.take(opts.cwd, model)
      : undefined;
    let releaseReservation: (() => void) | undefined;
    let releasePending: (() => void) | undefined;

    try {
      if (!session && owner.kind === 'chat_node' && !opts.profileHash && !opts.forkFromNativeSessionId && !this.deps.poolDisabled && this.deps.waitForWarm) {
        session = await this.pool.waitForInflight(opts.cwd, model);
      }
      if (session) {
        session.rebindIdentity(opts.id, opts.id, {
          workspaceId: opts.workspaceId ?? null,
          ownerUserId: opts.ownerUserId ?? null,
          owner,
          profileHash: opts.profileHash ?? null,
          toolProfile: opts.toolProfile,
          permissionBroker: opts.permissionBroker,
          reasoning: opts.reasoning ?? null,
          replayHistory: opts.replayHistory,
        });
      } else {
        perf.mark('warmpool:cold_spawn', { cwd: opts.cwd, model, waitForWarm: !!this.deps.waitForWarm });
        releaseReservation = await this.reserveSlot('active');
        session = new ClaudeSession(opts.id, {
          nodeId: opts.id,
          owner,
          cwd: opts.cwd,
          workspaceId: opts.workspaceId ?? null,
          parentChatId: opts.parentChatId,
          model: opts.model ?? undefined,
          systemPromptAppend: buildStableSystemPrompt(this.metadataOutputMode),
          mcpRegistry: this.deps.mcpRegistry,
          bridge: this.deps.bridge,
          mcpPort: this.deps.mcpPort,
          ownerUserId: opts.ownerUserId ?? null,
          profileHash: opts.profileHash ?? null,
          replayHistory: opts.replayHistory,
          toolProfile: opts.toolProfile,
          permissionBroker: opts.permissionBroker,
          reasoning: opts.reasoning ?? null,
        });
        releasePending = this.trackPendingSession(session);
        await session.spawnFresh(opts.forkFromNativeSessionId);
      }

      if (opts.firstTurnPrefix) {
        session.setFirstTurnPrefix(opts.firstTurnPrefix);
      }
      if (opts.enableFollowUps === false) {
        session.setEnableFollowUps(false);
      }
      if (!this.registerActiveSession(opts.id, session)) {
        throw new Error('Claude session exited during creation');
      }
      return session;
    } catch (err) {
      await session?.dispose().catch(() => {});
      throw err;
    } finally {
      releasePending?.();
      releaseReservation?.();
    }
  }

  async loadSession(opts: LoadClaudeSessionOptions): Promise<ClaudeSession> {
    if (this.shuttingDown) {
      throw new ClaudeConcurrencyError('ClaudeRuntime is shutting down');
    }
    const owner = opts.owner ?? { kind: 'chat_node' as const, nodeId: opts.id };
    const existing = this.getCompatible(opts.id, owner, opts.profileHash ?? null);
    if (existing) return existing;

    const releaseReservation = await this.reserveSlot('active');
    const session = new ClaudeSession(opts.id, {
      nodeId: opts.id,
      owner,
      cwd: opts.cwd,
      workspaceId: opts.workspaceId ?? null,
      model: opts.model ?? undefined,
      mcpRegistry: this.deps.mcpRegistry,
      bridge: this.deps.bridge,
      mcpPort: this.deps.mcpPort,
      ownerUserId: opts.ownerUserId ?? null,
      profileHash: opts.profileHash ?? null,
      replayHistory: opts.replayHistory,
      toolProfile: opts.toolProfile,
      permissionBroker: opts.permissionBroker,
      reasoning: opts.reasoning ?? null,
    });
    const releasePending = this.trackPendingSession(session);

    try {
      await session.spawnResume(opts.externalSessionId);
      if (opts.bootstrapInstructions) session.setFirstTurnPrefix(opts.bootstrapInstructions);
      if (!this.registerActiveSession(opts.id, session)) {
        throw new Error('Claude session exited during resume');
      }
      return session;
    } catch (err) {
      await session.dispose().catch(() => {});
      throw err;
    } finally {
      releasePending();
      releaseReservation();
    }
  }

  async releaseSession(sessionId: string, expectedOwner?: RuntimeSessionOwner): Promise<void> {
    const session = this.active.get(sessionId);
    if (session && expectedOwner && !session.matchesOwner(expectedOwner)) return;
    if (session) {
      await session.dispose();
    }
    if (this.active.get(sessionId) === session) {
      this.active.delete(sessionId);
      sessionRegistry.dropSession(sessionId);
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const poolShutdown = this.pool.shutdown();
    await Promise.allSettled([...this.pendingSessions].map((s) => s.dispose()));
    await poolShutdown;
    await Promise.allSettled([...this.active.values()].map((s) => s.dispose()));
    this.pendingSessions.clear();
    this.active.clear();
  }

  private async spawnWarmSession(cwd: string, model: string): Promise<ClaudeSession> {
    if (this.shuttingDown) {
      throw new ClaudeConcurrencyError('ClaudeRuntime is shutting down');
    }
    const releaseReservation = await this.reserveSlot('warm');
    const anonymousId = randomUUID();
    const session = new ClaudeSession(anonymousId, {
      nodeId: anonymousId,
      persistNativeIdentity: false,
      owner: { kind: 'chat_node', nodeId: anonymousId },
      cwd,
      workspaceId: null,
      model,
      systemPromptAppend: buildStableSystemPrompt(this.metadataOutputMode),
      mcpRegistry: this.deps.mcpRegistry,
      bridge: this.deps.bridge,
      mcpPort: this.deps.mcpPort,
    });
    const releasePending = this.trackPendingSession(session);

    try {
      await session.spawnFresh();
      await session.warmInit();
      return session;
    } catch (err) {
      await session.dispose().catch(() => {});
      throw err;
    } finally {
      releasePending();
      releaseReservation();
    }
  }

  private async reserveSlot(kind: 'active' | 'warm'): Promise<() => void> {
    if (this.shuttingDown) {
      throw new ClaudeConcurrencyError('ClaudeRuntime is shutting down');
    }
    if (kind === 'active') {
      await this.reclaimForActive();
    } else {
      await this.reclaimForWarm();
    }

    if (this.totalCount() >= this.deps.concurrencyCap) {
      throw new ClaudeConcurrencyError(
        `ClaudeRuntime concurrency limit ${this.deps.concurrencyCap} reached; no idle sessions were reclaimable`,
      );
    }

    this.pendingSpawns += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pendingSpawns = Math.max(0, this.pendingSpawns - 1);
    };
  }

  private trackPendingSession(session: ClaudeSession): () => void {
    this.pendingSessions.add(session);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pendingSessions.delete(session);
    };
  }

  private async reclaimForActive(): Promise<void> {
    while (this.totalCount() >= this.deps.concurrencyCap) {
      if (await this.pool.evictOldest('capacity_evicted_for_active')) continue;
      if (await this.reclaimActiveSession()) continue;
      break;
    }
  }

  private async reclaimForWarm(): Promise<void> {
    // Warm spawns never evict other warm entries: with multi-session slots,
    // a landed entry immediately triggers a refill, so evict-for-warm churns
    // the pool forever when the cap is at or below the warm target. At cap,
    // reserveSlot throws and spawnWarmSlot swallows it; take() misses and
    // the caller cold-spawns.
  }

  private totalCount(): number {
    return this.active.size + this.pool.size() + this.pendingSpawns;
  }

  private registerActiveSession(id: string, session: ClaudeSession): boolean {
    this.active.set(id, session);
    session.onDisposed(() => {
      if (this.active.get(id) !== session) return;
      this.active.delete(id);
      sessionRegistry.dropSession(id);
    });
    if (this.active.get(id) !== session) {
      return false;
    }
    if (this.deps.onSelfTurn && session.owner.kind === 'chat_node') {
      session.onSelfTurn(this.deps.onSelfTurn);
    }
    sessionRegistry.registerSession(session as AgentSession, session.getOwnerUserId(), session.owner);
    return true;
  }

  private async reclaimActiveSession(): Promise<boolean> {
    const candidates = [...this.active.entries()]
      .filter(([, session]) => {
        const state = session.getState();
        return state === 'crashed' || state === 'disposed' || state === 'idle';
      })
      .sort(([, a], [, b]) => {
        const stateRank = (s: ClaudeSession) => {
          const state = s.getState();
          if (state === 'crashed' || state === 'disposed') return 0;
          return 1;
        };
        return stateRank(a) - stateRank(b) || a.getLastUsedAt() - b.getLastUsedAt();
      });

    const first = candidates[0];
    if (!first) return false;
    const [id, session] = first;
    await session.dispose();
    if (this.active.get(id) === session) {
      this.active.delete(id);
      sessionRegistry.dropSession(id);
    }
    return true;
  }
}
