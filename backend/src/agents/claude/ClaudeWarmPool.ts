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
 * Pool entries are the Cartesian product. Each (cwd, model) slot holds up
 * to `sessionsPerSlot` pre-warmed sessions (default 2) so fan-out /
 * follow-up branch bursts don't cold-spawn. Steady state:
 * 3 cwds × 1 model × 2 sessions = 6. Peak (during a model grace period):
 * 3 × 2 × 2 = 12.
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
    /** Number of pre-warmed sessions per (cwd, model) slot. Default 2. */
    sessionsPerSlot?: number;
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
    readonly sessionsPerSlot: number;
    readonly modelGraceMs: number;
    readonly idleTtlMs: number;
    private readonly spawner: Spawner;
    private readonly disabled: boolean;

    private currentModel: string;
    /** MRU-first: head = most-recently-activated cwd. */
    private workspaceSet: string[] = [];
    private modelSet = new Map<string, ModelEntry>();
    /** Each slot (cwd|model) holds an array of up to sessionsPerSlot entries. */
    private entries = new Map<string, PoolEntry[]>();
    private inflight = new Map<string, Promise<void>>();
    private shuttingDown = false;

    constructor(opts: WarmPoolOptions) {
        this.spawner = opts.spawner;
        this.currentModel = opts.currentModel;
        this.workspaceCapacity = opts.workspaceCapacity ?? 3;
        this.sessionsPerSlot = opts.sessionsPerSlot ?? 2;
        this.modelGraceMs = opts.modelGraceMs ?? 3_600_000;
        this.idleTtlMs = opts.idleTtlMs ?? 3_600_000;
        this.disabled = opts.disabled ?? false;
        this.modelSet.set(this.currentModel, { graceTimer: null });
    }

    /** Number of warm entries currently held. */
    size(): number {
        let total = 0;
        for (const arr of this.entries.values()) {
            total += arr.length;
        }
        return total;
    }

    /** Evict the oldest warm entry. Used by ClaudeSessionManager when the
     * global Claude subprocess budget needs room for an active chat. */
    async evictOldest(reason: string = 'evicted'): Promise<boolean> {
        let oldestKey: string | null = null;
        let oldestIdx = -1;
        let oldestEntry: PoolEntry | null = null;
        for (const [k, arr] of this.entries) {
            for (let i = 0; i < arr.length; i++) {
                if (!oldestEntry || arr[i].warmedAt < oldestEntry.warmedAt) {
                    oldestKey = k;
                    oldestIdx = i;
                    oldestEntry = arr[i];
                }
            }
        }
        if (!oldestKey || !oldestEntry || oldestIdx < 0) return false;
        const arr = this.entries.get(oldestKey)!;
        arr.splice(oldestIdx, 1);
        if (arr.length === 0) this.entries.delete(oldestKey);
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
        const arr = this.entries.get(k);
        if (!arr || arr.length === 0) {
            perf.mark(this.inflight.has(k) ? 'warmpool:miss_inflight' : 'warmpool:miss', { cwd, model });
            return null;
        }
        // Find the first alive entry (newest first for freshness)
        for (let i = arr.length - 1; i >= 0; i--) {
            const entry = arr[i];
            if (!entry.session.isAlive?.()) {
                arr.splice(i, 1);
                clearTimeout(entry.ttlTimer);
                perf.mark('warmpool:miss_dead', { cwd, model });
                continue;
            }
            // Found a live one — take it
            arr.splice(i, 1);
            if (arr.length === 0) this.entries.delete(k);
            clearTimeout(entry.ttlTimer);
            perf.mark('warmpool:hit', { cwd, model, remaining: arr.length });
            // Background replenish (don't await — caller already has the session)
            if (this.workspaceSet.includes(cwd) && this.modelSet.has(model)) {
                void this.warmSlot(cwd, model);
            }
            return entry.session;
        }
        // All entries were dead
        this.entries.delete(k);
        perf.mark('warmpool:miss', { cwd, model });
        return null;
    }

    /**
     * If a matching warmSlot is already in flight, wait for it and
     * take the resulting entry. Does not start warming by itself; callers use
     * this to compare "cold spawn immediately" versus "wait for warm handoff".
     */
    async waitForInflight(cwd: string, model: string): Promise<ClaudeSession | null> {
        if (this.disabled || this.shuttingDown) return null;
        const k = entryKey(cwd, model);
        // Check for any inflight spawn for this slot (sub-keys are `${k}#N`)
        const inflightPromises: Promise<void>[] = [];
        for (const [key, promise] of this.inflight) {
            if (key.startsWith(k + '#') || key === k) {
                inflightPromises.push(promise);
            }
        }
        if (inflightPromises.length === 0) return null;

        const t0 = perf.now();
        perf.mark('warmpool:wait_inflight_start', { cwd, model });
        await Promise.race(inflightPromises).catch(() => {});

        const session = this.take(cwd, model);
        perf.measure(session ? 'warmpool:wait_inflight_hit' : 'warmpool:wait_inflight_miss', t0, {
            cwd,
            model,
        });
        return session;
    }

    /**
     * Promote `cwd` to MRU in workspaceSet. If `cwd` is new to the set,
     * warm entries per active model (up to sessionsPerSlot each). If LRU
     * pushes the capacity, evict the oldest cwd (kill all its entries).
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
        // Warm sessionsPerSlot entries per active model
        const warmups: Promise<void>[] = [];
        for (const m of this.modelSet.keys()) {
            for (let i = 0; i < this.sessionsPerSlot; i++) {
                warmups.push(this.warmSlot(cwd, m));
            }
        }
        await Promise.all(warmups);
    }

    private async warmSlot(cwd: string, model: string): Promise<void> {
        if (this.disabled || this.shuttingDown) return;
        const k = entryKey(cwd, model);
        const arr = this.entries.get(k) ?? [];
        if (arr.length >= this.sessionsPerSlot) return;
        // Use a sub-key to deduplicate concurrent warmSlot calls for the same
        // logical slot. Each inflight spawn uses `${k}#${index}`.
        const subKey = `${k}#${arr.length}`;
        const existing = this.inflight.get(subKey);
        if (existing) return existing;

        let task!: Promise<void>;
        task = this.spawnWarmSlot(k, cwd, model).finally(() => {
            if (this.inflight.get(subKey) === task) {
                this.inflight.delete(subKey);
            }
        });
        this.inflight.set(subKey, task);
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
            // Check capacity again (another spawn may have landed while we were in-flight)
            const arr = this.entries.get(k) ?? [];
            if (arr.length >= this.sessionsPerSlot) {
                try {
                    await (session as unknown as { dispose?: () => Promise<void> }).dispose?.();
                } catch { /* best-effort */ }
                return;
            }
            const ttlTimer = setTimeout(() => this.expireEntry(k, session), this.idleTtlMs);
            ttlTimer.unref?.();
            const entry: PoolEntry = { cwd, model, session, warmedAt: Date.now(), ttlTimer };
            if (!this.entries.has(k)) this.entries.set(k, []);
            this.entries.get(k)!.push(entry);
            session.onDisposed?.(() => {
                const currentArr = this.entries.get(k);
                if (!currentArr) return;
                const idx = currentArr.findIndex(e => e.session === session);
                if (idx >= 0) {
                    clearTimeout(currentArr[idx].ttlTimer);
                    currentArr.splice(idx, 1);
                    if (currentArr.length === 0) this.entries.delete(k);
                }
            });
            perf.measure('warmpool:slot_ready', t0, { cwd, model, depth: (this.entries.get(k)?.length ?? 0) });
            // Continue filling the slot if not at capacity yet
            if ((this.entries.get(k)?.length ?? 0) < this.sessionsPerSlot) {
                void this.warmSlot(cwd, model);
            }
        } catch (err) {
            perf.mark('warmpool:slot_failed', { cwd, model, error: (err as Error).message });
            // Swallow — next take() returns null, caller cold-spawns.
        }
    }

    private expireEntry(k: string, session: ClaudeSession): void {
        const arr = this.entries.get(k);
        if (!arr) return;
        const idx = arr.findIndex(e => e.session === session);
        if (idx < 0) return;
        const entry = arr[idx];
        arr.splice(idx, 1);
        if (arr.length === 0) this.entries.delete(k);
        try {
            void (entry.session as unknown as { dispose?: () => Promise<void> }).dispose?.();
        } catch { /* best-effort */ }
        perf.mark('warmpool:ttl_expired', { cwd: entry.cwd, model: entry.model });
        // No replenish here: TTL expiry means the workspace has been idle for
        // the full TTL, so let the slot drain. take()-hit replenish restores
        // depth as soon as the workspace becomes active again.
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
        const warmups: Promise<void>[] = [];
        for (const cwd of this.workspaceSet) {
            for (let i = 0; i < this.sessionsPerSlot; i++) {
                warmups.push(this.warmSlot(cwd, newModel));
            }
        }
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
        for (const [k, arr] of this.entries) {
            if (arr[0]?.model === model) {
                for (const e of arr) {
                    clearTimeout(e.ttlTimer);
                    try {
                        void (e.session as unknown as { dispose?: () => Promise<void> }).dispose?.();
                    } catch { /* best-effort */ }
                }
                this.entries.delete(k);
            }
        }
        perf.mark('warmpool:model_evicted', { model });
    }

    private evictWorkspace(cwd: string): void {
        for (const [k, arr] of this.entries) {
            if (arr[0]?.cwd === cwd) {
                for (const entry of arr) {
                    clearTimeout(entry.ttlTimer);
                    try {
                        void (entry.session as unknown as { dispose?: () => Promise<void> }).dispose?.();
                    } catch { /* best-effort */ }
                }
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
        for (const arr of this.entries.values()) {
            for (const e of arr) {
                clearTimeout(e.ttlTimer);
                try {
                    await (e.session as unknown as { dispose?: () => Promise<void> }).dispose?.();
                } catch {
                    /* best-effort */
                }
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
