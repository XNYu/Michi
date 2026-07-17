import { randomUUID } from 'node:crypto';
import type { AgentSession, NewAgentSessionOptions } from '../types';
import type { AgentToolBridge } from '../toolBridge';
import type { McpSlotRegistry } from '../../services/mcpServer';
import { setNodeExternalSessionId } from '../../services/dbRepository';
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
}

export interface CreateClaudeSessionOptions {
  id: string;
  cwd: string;
  parentChatId?: string;
  workspaceId?: string | null;
  model?: string | null;
  firstTurnPrefix?: string;
  ownerUserId?: string | null;
}

export interface LoadClaudeSessionOptions {
  id: string;
  cwd: string;
  workspaceId?: string | null;
  model?: string | null;
  externalSessionId: string;
  ownerUserId?: string | null;
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
    });
  }

  get(id: string): ClaudeSession | undefined {
    return this.active.get(id);
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
    const existing = this.active.get(opts.id);
    if (existing) return existing;

    const model = opts.model ?? resolveModel('claude');
    let session = this.pool.take(opts.cwd, model);
    let releaseReservation: (() => void) | undefined;
    let releasePending: (() => void) | undefined;

    try {
      if (!session && !this.deps.poolDisabled && this.deps.waitForWarm) {
        session = await this.pool.waitForInflight(opts.cwd, model);
      }
      if (session) {
        session.rebindIdentity(opts.id, opts.id, {
          workspaceId: opts.workspaceId ?? null,
          ownerUserId: opts.ownerUserId ?? null,
        });
        const externalSessionId = session.getExternalSessionId();
        if (externalSessionId) {
          try {
            setNodeExternalSessionId(opts.id, externalSessionId);
          } catch (err) {
            console.warn(`[ClaudeSessionManager] setNodeExternalSessionId after warm handoff failed:`, err);
          }
        }
      } else {
        perf.mark('warmpool:cold_spawn', { cwd: opts.cwd, model, waitForWarm: !!this.deps.waitForWarm });
        releaseReservation = await this.reserveSlot('active');
        session = new ClaudeSession(opts.id, {
          nodeId: opts.id,
          cwd: opts.cwd,
          workspaceId: opts.workspaceId ?? null,
          parentChatId: opts.parentChatId,
          model: opts.model ?? undefined,
          systemPromptAppend: buildStableSystemPrompt(this.metadataOutputMode),
          mcpRegistry: this.deps.mcpRegistry,
          bridge: this.deps.bridge,
          mcpPort: this.deps.mcpPort,
          ownerUserId: opts.ownerUserId ?? null,
        });
        releasePending = this.trackPendingSession(session);
        await session.spawnFresh();
      }

      if (opts.firstTurnPrefix) {
        session.setFirstTurnPrefix(opts.firstTurnPrefix);
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
    const existing = this.active.get(opts.id);
    if (existing) return existing;

    const releaseReservation = await this.reserveSlot('active');
    const session = new ClaudeSession(opts.id, {
      nodeId: opts.id,
      cwd: opts.cwd,
      workspaceId: opts.workspaceId ?? null,
      model: opts.model ?? undefined,
      mcpRegistry: this.deps.mcpRegistry,
      bridge: this.deps.bridge,
      mcpPort: this.deps.mcpPort,
      ownerUserId: opts.ownerUserId ?? null,
    });
    const releasePending = this.trackPendingSession(session);

    try {
      await session.spawnResume(opts.externalSessionId);
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

  async releaseSession(sessionId: string): Promise<void> {
    const session = this.active.get(sessionId);
    if (session) {
      await session.dispose();
    }
    this.active.delete(sessionId);
    sessionRegistry.dropSession(sessionId);
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
    while (this.totalCount() >= this.deps.concurrencyCap) {
      if (await this.pool.evictOldest('capacity_evicted_for_warm')) continue;
      break;
    }
  }

  private totalCount(): number {
    return this.active.size + this.pool.size() + this.pendingSpawns;
  }

  private registerActiveSession(id: string, session: ClaudeSession): boolean {
    this.active.set(id, session);
    session.onDisposed(() => {
      this.active.delete(id);
      sessionRegistry.dropSession(id);
    });
    if (this.active.get(id) !== session) {
      return false;
    }
    sessionRegistry.registerSession(session as AgentSession);
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
    await session.dispose().catch(() => {});
    this.active.delete(id);
    sessionRegistry.dropSession(id);
    return true;
  }
}
