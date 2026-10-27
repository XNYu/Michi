import { randomUUID } from 'node:crypto';
import { PendingSessionAcquisitions } from '../../core/sessionAcquisition';
import { assertOwner, interactiveOwner, sameOwner } from '../../contract/types';
import { assertReleaseOwnership } from '../../core/release';
import type {
  AgentReasoning,
  AgentSession,
  ChatMessage,
  RuntimePermissionBroker,
  RuntimeSessionOwner,
  RuntimeToolProfile,
} from '../../contract/types';
import type { AgentToolBridge } from '../../contract/tools';
import type { McpSlotProvider } from '../../contract/mcp';
import { ownerMode, type MetadataOutputMode, type RuntimeHost } from '../../contract/host';
import type { ClaudeAdapterOptions } from './claudeAdapterOptions';
import { ClaudeSession, type SelfTurnInfo } from './ClaudeSession';
import { ClaudeWarmPool } from './ClaudeWarmPool';

/** How long after its last use an idle session holding background work is never reclaimed. */
export const BACKGROUND_RECLAIM_PROTECT_MS = 6 * 60 * 60_000;

export class ClaudeConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeConcurrencyError';
  }
}

export interface ClaudeSessionManagerDeps {
  bridge: AgentToolBridge;
  mcpRegistry: McpSlotProvider;
  options: ClaudeAdapterOptions;
  concurrencyCap: number;
  currentModel: string;
  poolDisabled?: boolean;
  waitForWarm?: boolean;
  sessionsPerSlot?: number;
  onSelfTurn?: (info: SelfTurnInfo & { session: AgentSession }) => void;
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
  parentChatId?: string;
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
  enableFollowUps?: boolean;
}

export interface ClaudeSessionManagerStats {
  cap: number;
  active: number;
  warm: number;
  pending: number;
  total: number;
}

export class ClaudeSessionManager {
  private readonly acquisitions = new PendingSessionAcquisitions<ClaudeSession>();
  private readonly active = new Map<string, ClaudeSession>();
  private readonly pendingSessions = new Set<ClaudeSession>();
  private readonly pool: ClaudeWarmPool;
  private readonly metadataOutputMode: MetadataOutputMode;
  private readonly host: RuntimeHost;
  private pendingSpawns = 0;
  private shuttingDown = false;

  constructor(private readonly deps: ClaudeSessionManagerDeps) {
    this.host = deps.options.host;
    this.metadataOutputMode = this.host.prompt.followUpsMetadataOutputMode(
      deps.options.followUpsHookPoc(),
      this.host.prompt.followUpsExperimentMode(),
    );
    this.pool = new ClaudeWarmPool({
      spawner: (cwd, model) => this.spawnWarmSession(cwd, model),
      perf: deps.options.host.observability.perf,
      currentModel: deps.currentModel,
      disabled: deps.poolDisabled,
      sessionsPerSlot: deps.sessionsPerSlot,
    });
  }

  waitForRelease(id: string): Promise<void> { return this.acquisitions.waitForRelease(id); }

  get(id: string): ClaudeSession | undefined {
    return this.active.get(id);
  }

  getCompatible(
    id: string,
    owner: RuntimeSessionOwner,
    profileHash: string | null,
    ownerUserId?: string | null,
  ): ClaudeSession | undefined {
    const existing = this.active.get(id);
    if (!existing) return undefined;
    if (!existing.matchesOwner(owner)) {
      throw new Error(`session ${id} is already bound to a different owner`);
    }
    if (ownerUserId !== undefined && existing.getOwnerUserId() !== ownerUserId) throw new Error('session user owner mismatch');
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
    const targetModel = model ?? this.host.config.defaultModel('claude');
    if (targetModel) {
      await this.pool.notifyModelChange(targetModel);
    }
    await this.pool.registerWorkspace(cwd);
  }

  async notifyModelChange(model: string): Promise<void> {
    await this.pool.notifyModelChange(model);
  }

  async createSession(opts: CreateClaudeSessionOptions): Promise<ClaudeSession> {
    return this.acquireSession(opts, () => this.createFreshSession(opts));
  }

  private acquireSession(opts: CreateClaudeSessionOptions | LoadClaudeSessionOptions,
    create: () => Promise<ClaudeSession>): Promise<ClaudeSession> {
    const owner = opts.owner ?? interactiveOwner(opts.id);
    return this.acquisitions.acquire(opts.id, create, (session) => {
      assertOwner(session.owner, owner);
      if ((session.runtimeProfileHash ?? null) !== (opts.profileHash ?? null)) {
        throw new Error(`session ${opts.id} runtime profile hash mismatch`);
      }
      if (session.getOwnerUserId() !== (opts.ownerUserId ?? null)) throw new Error('session user owner mismatch');
      return session;
    });
  }

  private async createFreshSession(opts: CreateClaudeSessionOptions): Promise<ClaudeSession> {
    if (this.shuttingDown) {
      throw new ClaudeConcurrencyError('ClaudeRuntime is shutting down');
    }
    const owner = opts.owner ?? interactiveOwner(opts.id);
    const existing = this.getCompatible(opts.id, owner, opts.profileHash ?? null, opts.ownerUserId ?? null);
    if (existing) return existing;

    const model = opts.model ?? this.host.config.defaultModel('claude');
    // Warm sessions are intentionally profile-neutral chat resources: their
    // processes run unrestricted. A Run attempt, or any session with a tool
    // profile or permission broker, has immutable tools/permissions/profile
    // state and must cold-spawn unless a future pool explicitly keys those
    // dimensions.
    const poolable = ownerMode(owner) === 'interactive' && !opts.profileHash && !opts.forkFromNativeSessionId
      && !opts.toolProfile && !opts.permissionBroker;
    let session = poolable ? this.pool.take(opts.cwd, model) : undefined;
    let releaseReservation: (() => void) | undefined;
    let releasePending: (() => void) | undefined;

    try {
      if (!session && poolable && !this.deps.poolDisabled && this.deps.waitForWarm) {
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
        this.host.observability.perf.mark('warmpool:cold_spawn', { cwd: opts.cwd, model, waitForWarm: !!this.deps.waitForWarm });
        releaseReservation = await this.reserveSlot('active');
        session = new ClaudeSession(opts.id, {
          nodeId: opts.id,
          owner,
          cwd: opts.cwd,
          workspaceId: opts.workspaceId ?? null,
          parentChatId: opts.parentChatId,
          model: opts.model ?? undefined,
          // The assistant has no AskUserQuestion, nor the ordinary chat tools
          // the stable prompt advertises; it gets its own short tool note.
          systemPromptAppend: this.host.profile.isRestricted(opts.toolProfile)
            ? this.host.prompt.stableSystemPrompt(this.metadataOutputMode, false, false, true, opts.toolProfile)
            : this.host.prompt.stableSystemPrompt(this.metadataOutputMode, true, true),
          mcpRegistry: this.deps.mcpRegistry,
          bridge: this.deps.bridge,
          options: this.deps.options,
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
    return this.acquireSession(opts, () => this.restoreSession(opts));
  }

  private async restoreSession(opts: LoadClaudeSessionOptions): Promise<ClaudeSession> {
    if (this.shuttingDown) {
      throw new ClaudeConcurrencyError('ClaudeRuntime is shutting down');
    }
    const owner = opts.owner ?? interactiveOwner(opts.id);
    const existing = this.getCompatible(opts.id, owner, opts.profileHash ?? null, opts.ownerUserId ?? null);
    if (existing) return existing;

    const releaseReservation = await this.reserveSlot('active');
    const session = new ClaudeSession(opts.id, {
      nodeId: opts.id,
      owner,
      cwd: opts.cwd,
      workspaceId: opts.workspaceId ?? null,
      parentChatId: opts.parentChatId,
      model: opts.model ?? undefined,
      systemPromptAppend: this.host.prompt.stableSystemPrompt(this.metadataOutputMode, !this.host.profile.isRestricted(opts.toolProfile), !this.host.profile.isRestricted(opts.toolProfile), this.host.profile.isRestricted(opts.toolProfile), opts.toolProfile),
      mcpRegistry: this.deps.mcpRegistry,
      bridge: this.deps.bridge,
      options: this.deps.options,
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
      if (opts.enableFollowUps === false) session.setEnableFollowUps(false);
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
    return this.acquisitions.release(sessionId, () => this.disposeSession(sessionId, expectedOwner));
  }

  private async disposeSession(sessionId: string, expectedOwner?: RuntimeSessionOwner): Promise<void> {
    const session = this.active.get(sessionId);
    if (session && expectedOwner) assertReleaseOwnership(session.owner, expectedOwner);
    if (session) {
      await session.dispose();
    }
    if (this.active.get(sessionId) === session) {
      this.active.delete(sessionId);
      this.host.sessions.dropSession(sessionId);
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
      owner: interactiveOwner(anonymousId),
      cwd,
      workspaceId: null,
      model,
      systemPromptAppend: this.host.prompt.stableSystemPrompt(this.metadataOutputMode, true, true),
      mcpRegistry: this.deps.mcpRegistry,
      bridge: this.deps.bridge,
      options: this.deps.options,
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
      this.host.sessions.dropSession(id);
    });
    if (this.active.get(id) !== session) {
      return false;
    }
    const onSelfTurn = this.deps.onSelfTurn;
    if (onSelfTurn && ownerMode(session.owner) === 'interactive') {
      session.onSelfTurn((info) => {
        // ClaudeSession always reports its own owner, so sameOwner holds in
        // production; the binding constraint is info.owner.key === id, the
        // session's registered public id. Keep both.
        if (this.active.get(id) !== session
          || info.chatId !== id
          || ownerMode(session.owner) !== 'interactive'
          || !sameOwner(info.owner, session.owner) || info.owner.key !== id
          || info.ownerUserId !== session.getOwnerUserId()) {
          // The Session catches callback failures and drains the claimed
          // iterator before releasing its idle-pump mutex.
          throw new Error('self turn runtime no longer matches its registered owner');
        }
        onSelfTurn({ ...info, session });
      });
    }
    this.host.sessions.registerSession(session as AgentSession, session.getOwnerUserId(), session.owner);
    return true;
  }

  private async reclaimActiveSession(): Promise<boolean> {
    const now = Date.now();
    // An idle chat may still run a background workflow or subagent inside
    // its CLI process; reclaiming it kills that work or loses a completion
    // no turn has reported yet. Protected for BACKGROUND_RECLAIM_PROTECT_MS
    // after its last use, then reclaimable only after every other idle
    // session, so work whose completion never arrives cannot hold a slot
    // forever. The renderer then reads its agents as interrupted.
    const holdsBackground = (session: ClaudeSession) => session.getState() === 'idle' && session.hasBackgroundWork();
    const candidates = [...this.active.entries()]
      .filter(([, session]) => {
        const state = session.getState();
        if (holdsBackground(session) && now - session.getLastUsedAt() < BACKGROUND_RECLAIM_PROTECT_MS) return false;
        return state === 'crashed' || state === 'disposed' || state === 'idle';
      })
      .sort(([, a], [, b]) => {
        const stateRank = (s: ClaudeSession) => {
          const state = s.getState();
          if (state === 'crashed' || state === 'disposed') return 0;
          return holdsBackground(s) ? 2 : 1;
        };
        return stateRank(a) - stateRank(b) || a.getLastUsedAt() - b.getLastUsedAt();
      });

    const first = candidates[0];
    if (!first) return false;
    const [id, session] = first;
    await session.dispose();
    if (this.active.get(id) === session) {
      this.active.delete(id);
      this.host.sessions.dropSession(id);
    }
    return true;
  }
}
