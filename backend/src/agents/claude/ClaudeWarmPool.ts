/**
 * Warm pool of pre-spawned, init-completed ClaudeSession instances.
 *
 * Why this exists: cold-spawning a claude CLI subprocess takes ~7.7s for
 * its `system/init` handshake even with --bare. Sessions become responsive
 * within ~1.5s on subsequent turns within the same process. The pool
 * pre-pays init in the background so the user's first chat in a workspace
 * doesn't wait for it.
 *
 * Two independent LRU dimensions:
 *   - workspaceSet: most-recently-active cwds (capacity 3 by default)
 *   - model_set:    current global model + at most one in-grace old model
 *
 * Pool entries are the Cartesian product. Steady state: 3. Peak (during
 * a model grace period): 6.
 *
 * Design doc: docs/superpowers/specs/2026-05-23-claude-warm-pool-design.md
 */

import type { ClaudeSession } from './ClaudeSession';
import * as perf from '../../services/perf';

export type Spawner = (cwd: string, model: string) => Promise<ClaudeSession>;

interface PoolEntry {
    cwd: string;
    model: string;
    session: ClaudeSession;
    warmedAt: number;
    ttlTimer: NodeJS.Timeout;
}

interface ModelEntry {
    graceTimer: NodeJS.Timeout | null;
}

export interface WarmPoolOptions {
    /** Called when the pool needs a new warm session. Must return a session
     *  that has already paid `system/init` (typically via warmInit()). */
    spawner: Spawner;
    /** The globally-active model at construction time. */
    currentModel: string;
    /** Max distinct cwds tracked. Default 3. */
    workspaceCapacity?: number;
    /** How long an old model lingers after a switch before its entries are
     *  killed. Default 1h. */
    modelGraceMs?: number;
    /** Max idle time for a single warm entry. Default 1h. */
    idleTtlMs?: number;
    /** Escape hatch — when true, take() always returns null and the pool
     *  is effectively a no-op. Controlled by env in production. */
    disabled?: boolean;
}

function entryKey(cwd: string, model: string): string {
    return `${cwd}|${model}`;
}

export class ClaudeWarmPool {
    readonly workspaceCapacity: number;
    readonly modelGraceMs: number;
    readonly idleTtlMs: number;
    private readonly spawner: Spawner;
    private readonly disabled: boolean;

    private currentModel: string;
    /** MRU-first: head = most-recently-activated cwd. */
    private workspaceSet: string[] = [];
    private modelSet = new Map<string, ModelEntry>();
    private entries = new Map<string, PoolEntry>();
    private inflight = new Map<string, Promise<void>>();
    private shuttingDown = false;

    constructor(opts: WarmPoolOptions) {
        this.spawner = opts.spawner;
        this.currentModel = opts.currentModel;
        this.workspaceCapacity = opts.workspaceCapacity ?? 3;
        this.modelGraceMs = opts.modelGraceMs ?? 3_600_000;
        this.idleTtlMs = opts.idleTtlMs ?? 3_600_000;
        this.disabled = opts.disabled ?? false;
        this.modelSet.set(this.currentModel, { graceTimer: null });
    }

    /** Number of warm entries currently held. */
    size(): number {
        return this.entries.size;
    }

    /** Evict the oldest warm entry. Used by ClaudeSessionManager when the
     * global Claude subprocess budget needs room for an active chat. */
    async evictOldest(reason: string = 'evicted'): Promise<boolean> {
        let oldestKey: string | null = null;
        let oldestEntry: PoolEntry | null = null;
        for (const [k, entry] of this.entries) {
            if (!oldestEntry || entry.warmedAt < oldestEntry.warmedAt) {
                oldestKey = k;
                oldestEntry = entry;
            }
        }
        if (!oldestKey || !oldestEntry) return false;
        this.entries.delete(oldestKey);
        clearTimeout(oldestEntry.ttlTimer);
        await oldestEntry.session.dispose?.().catch(() => {});
        perf.mark(`warmpool:${reason}`, { cwd: oldestEntry.cwd, model: oldestEntry.model });
        return true;
    }

    /**
     * Hand out a warm session matching (cwd, model). Returns null on miss,
     * on a dead entry, or if the pool is disabled. Callers MUST cold-spawn
     * on null.
     *
     * On a hit, removes the entry from the pool and schedules a background
     * replenish for the same slot — provided (cwd, model) is still in scope
     * (workspaceSet × modelSet).
     */
    take(cwd: string, model: string): ClaudeSession | null {
        if (this.disabled || this.shuttingDown) return null;
        const k = entryKey(cwd, model);
        const entry = this.entries.get(k);
        if (!entry) {
            perf.mark(this.inflight.has(k) ? 'warmpool:miss_inflight' : 'warmpool:miss', { cwd, model });
            return null;
        }
        // Liveness check; if dead, drop and miss
        if (!entry.session.isAlive?.()) {
            this.entries.delete(k);
            clearTimeout(entry.ttlTimer);
            perf.mark('warmpool:miss_dead', { cwd, model });
            return null;
        }
        this.entries.delete(k);
        clearTimeout(entry.ttlTimer);
        perf.mark('warmpool:hit', { cwd, model });
        // Background replenish (don't await — caller already has the session)
        if (this.workspaceSet.includes(cwd) && this.modelSet.has(model)) {
            void this.warmSlot(cwd, model);
        }
        return entry.session;
    }

    /**
     * If a matching warmSlot is already in flight, wait for it and
     * take the resulting entry. Does not start warming by itself; callers use
     * this to compare "cold spawn immediately" versus "wait for warm handoff".
     */
    async waitForInflight(cwd: string, model: string): Promise<ClaudeSession | null> {
        if (this.disabled || this.shuttingDown) return null;
        const k = entryKey(cwd, model);
        const existing = this.inflight.get(k);
        if (!existing) return null;

        const t0 = perf.now();
        perf.mark('warmpool:wait_inflight_start', { cwd, model });
        await existing.catch(() => {});

        const session = this.take(cwd, model);
        perf.measure(session ? 'warmpool:wait_inflight_hit' : 'warmpool:wait_inflight_miss', t0, {
            cwd,
            model,
        });
        return session;
    }

    /**
     * Promote `cwd` to MRU in workspaceSet. If `cwd` is new to the set,
     * warm one entry per active model. If LRU pushes the capacity, evict
     * the oldest cwd (kill all its entries).
     *
     * Idempotent for cwds already in the set — only adjusts MRU order.
     * Resolves once all warm spawns for new entries complete. Spawn
     * failures are logged + swallowed so a bad cwd doesn't block warming
     * for other models.
     */
    async registerWorkspace(cwd: string): Promise<void> {
        if (this.disabled || this.shuttingDown) return;
        const idx = this.workspaceSet.indexOf(cwd);
        if (idx === 0) return;
        if (idx > 0) {
            this.workspaceSet.splice(idx, 1);
            this.workspaceSet.unshift(cwd);
            return;
        }
        // New cwd
        this.workspaceSet.unshift(cwd);
        if (this.workspaceSet.length > this.workspaceCapacity) {
            const evicted = this.workspaceSet.pop()!;
            this.evictWorkspace(evicted);
        }
        // Warm one entry per active model
        const warmups = Array.from(this.modelSet.keys()).map((m) => this.warmSlot(cwd, m));
        await Promise.all(warmups);
    }

    private async warmSlot(cwd: string, model: string): Promise<void> {
        if (this.disabled || this.shuttingDown) return;
        const k = entryKey(cwd, model);
        if (this.entries.has(k)) return;
        const existing = this.inflight.get(k);
        if (existing) return existing;

        let task!: Promise<void>;
        task = this.spawnWarmSlot(k, cwd, model).finally(() => {
            if (this.inflight.get(k) === task) {
                this.inflight.delete(k);
            }
        });
        this.inflight.set(k, task);
        return task;
    }

    private async spawnWarmSlot(k: string, cwd: string, model: string): Promise<void> {
        try {
            const t0 = perf.now();
            const session = await this.spawner(cwd, model);
            // It's possible the cwd or model fell out of scope while we were
            // spawning (user switched away mid-warm). If so, dispose and skip.
            if (this.shuttingDown || !this.workspaceSet.includes(cwd) || !this.modelSet.has(model)) {
                try {
                    await (session as unknown as { dispose?: () => Promise<void> }).dispose?.();
                } catch { /* best-effort */ }
                return;
            }
            const ttlTimer = setTimeout(() => this.expireEntry(k), this.idleTtlMs);
            ttlTimer.unref?.();
            this.entries.set(k, { cwd, model, session, warmedAt: Date.now(), ttlTimer });
            session.onDisposed?.(() => {
                const current = this.entries.get(k);
                if (current?.session !== session) return;
                clearTimeout(current.ttlTimer);
                this.entries.delete(k);
            });
            perf.measure('warmpool:slot_ready', t0, { cwd, model });
        } catch (err) {
            perf.mark('warmpool:slot_failed', { cwd, model, error: (err as Error).message });
            // Swallow — next take() returns null, caller cold-spawns.
        }
    }

    private expireEntry(k: string): void {
        const entry = this.entries.get(k);
        if (!entry) return;
        this.entries.delete(k);
        try {
            void (entry.session as unknown as { dispose?: () => Promise<void> }).dispose?.();
        } catch { /* best-effort */ }
        perf.mark('warmpool:ttl_expired', { cwd: entry.cwd, model: entry.model });
    }

    /**
     * Handle a global-model switch. Implements the 3 cases documented in the
     * spec:
     *
     *   Case 1: newModel was the in-grace model → user switched back.
     *           Cancel newModel's grace timer; start grace on the
     *           just-demoted oldModel. No warming needed.
     *
     *   Case 2: newModel is brand new and modelSet only has currentModel.
     *           Add newModel, warm (cwd, newModel) for every cwd, start
     *           grace on oldModel.
     *
     *   Case 3: newModel is brand new and modelSet already has 2 models
     *           (user switching during grace, third model arrives).
     *           Evict the in-grace model immediately (SIGTERM all its
     *           entries) so modelSet stays at 2, then Case 2.
     */
    async notifyModelChange(newModel: string): Promise<void> {
        if (this.disabled || this.shuttingDown) return;
        if (newModel === this.currentModel) return;
        const oldModel = this.currentModel;
        this.currentModel = newModel;

        // Case 1: newModel was already in modelSet — it must be the in-grace one
        if (this.modelSet.has(newModel)) {
            const newEntry = this.modelSet.get(newModel)!;
            if (newEntry.graceTimer) {
                clearTimeout(newEntry.graceTimer);
                newEntry.graceTimer = null;
            }
            this.startGrace(oldModel);
            return;
        }

        // Case 3: modelSet at capacity (2). Evict whichever isn't oldModel.
        if (this.modelSet.size >= 2) {
            for (const [m, entry] of this.modelSet) {
                if (m !== oldModel && entry.graceTimer) {
                    clearTimeout(entry.graceTimer);
                    this.evictModel(m);
                    break;
                }
            }
        }

        // Case 2: add newModel, warm for all cwds, start grace on oldModel
        this.modelSet.set(newModel, { graceTimer: null });
        // Start grace BEFORE awaiting warm so the clock starts immediately
        this.startGrace(oldModel);
        const warmups = this.workspaceSet.map((cwd) => this.warmSlot(cwd, newModel));
        await Promise.all(warmups);
    }

    private startGrace(model: string): void {
        const entry = this.modelSet.get(model);
        if (!entry) return;
        if (entry.graceTimer) clearTimeout(entry.graceTimer);
        entry.graceTimer = setTimeout(() => this.evictModel(model), this.modelGraceMs);
        entry.graceTimer.unref?.();
    }

    private evictModel(model: string): void {
        const entry = this.modelSet.get(model);
        if (entry?.graceTimer) clearTimeout(entry.graceTimer);
        this.modelSet.delete(model);
        for (const [k, e] of this.entries) {
            if (e.model === model) {
                clearTimeout(e.ttlTimer);
                try {
                    void (e.session as unknown as { dispose?: () => Promise<void> }).dispose?.();
                } catch { /* best-effort */ }
                this.entries.delete(k);
            }
        }
        perf.mark('warmpool:model_evicted', { model });
    }

    private evictWorkspace(cwd: string): void {
        for (const [k, entry] of this.entries) {
            if (entry.cwd === cwd) {
                clearTimeout(entry.ttlTimer);
                try {
                    void (entry.session as unknown as { dispose?: () => Promise<void> }).dispose?.();
                } catch { /* best-effort */ }
                this.entries.delete(k);
            }
        }
        perf.mark('warmpool:workspace_evicted', { cwd });
    }

    /**
     * Tear everything down. Called from ClaudeRuntime shutdown paths.
     */
    async shutdown(): Promise<void> {
        this.shuttingDown = true;
        this.workspaceSet = [];
        for (const e of this.entries.values()) {
            clearTimeout(e.ttlTimer);
            try {
                await (e.session as unknown as { dispose?: () => Promise<void> }).dispose?.();
            } catch {
                /* best-effort */
            }
        }
        this.entries.clear();
        for (const m of this.modelSet.values()) {
            if (m.graceTimer) clearTimeout(m.graceTimer);
        }
        this.modelSet.clear();
        if (this.inflight.size > 0) {
            await Promise.allSettled(this.inflight.values());
            this.inflight.clear();
        }
    }
}
