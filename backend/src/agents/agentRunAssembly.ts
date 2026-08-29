import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { readdir, readFile, rm } from 'node:fs/promises';
import {
  AgentPolicyCategory,
  AgentPolicyDecision,
  AgentRunStatus,
  MAX_RUN_TTL_MS,
  type AgentPermissionPolicyV1,
  type AgentRunDtoV1,
} from 'michi-shared';
import { AgentDefinitionService } from '../services/agentDefinitionService';
import { AgentDefinitionsRepository } from '../services/agentDefinitionsRepository';
import {
  AgentCapabilityCatalog,
  AgentRunToolCapabilitySource,
  BuiltinAgentCapabilitySource,
} from '../services/agentCapabilityCatalog';
import { AgentRunsRepository } from '../services/agentRunsRepository';
import { getDb, runInTransaction } from '../services/db';
import { getMichiDataDir } from '../services/dataDir';
import { getWorkspace, listWorkspaces } from '../services/dbRepository';
import { workspaceOwnerMatches } from '../services/agentOwner';
import { AgentRunApiService, type AgentRunRouteService } from '../routes/agentRuns';
import type { AgentRunSseDeps } from '../routes/agentRunSse';
import { AgentRunCoordinator } from './runs/agentRunCoordinator';
import { AgentRunWatchCoordinator } from './runs/agentRunWatchCoordinator';
import { AgentRunRetention } from './runs/agentRunRetention';
import { DefaultExecutionEnvironmentProvider } from './runs/executionEnvironment';
import { GitWorktreeEnvironment } from './runs/gitWorktreeEnvironment';
import { FileRunContextSnapshotStore } from './runs/runContextSnapshotStore';
import { RuntimeRunExecutor } from './runs/runtimeRunExecutor';
import { RuntimeRunAdapterRegistry } from './runs/runtimeRunAdapterRegistry';
import { PiRunAdapter } from './runs/piRunAdapter';
import { ClaudeRunAdapter } from './runs/claudeRunAdapter';
import { KiroRunAdapter } from './runs/kiroRunAdapter';
import { CodexRunAdapter } from './runs/codexRunAdapter';
import {
  systemAgentRunClock,
  type AgentRunClock,
  type AgentRunCleanupResources,
  type AgentRunExecutor,
  type AgentRunNotifier,
  type AgentRunRepositoryPort,
  type AgentRunResourceCleaner,
  type AgentRunWorkspaceResolver,
  type ParentContinuationSink,
  type RunContextSnapshotStore,
} from './runs/ports';
import { createAgentRunToolBridge, type AgentRunToolInvoker } from './runToolBridge';
import type { ActiveTurnResolver, AgentRunCaller } from './agentRunInvocation';
import {
  AgentRunParentDelivery,
  type ParentContinuationDeliveryInput,
  type ParentDeliveryRecord,
  type ParentDeliveryRecordStore,
} from './agentRunParentDelivery';
import type { ChatManager } from '../services/chatManager';
import { chatHub as defaultChatHub, type ChatHub } from './chatHub';
import { log } from '../services/logger';

const execFileAsync = promisify(execFile);

const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_MAINTENANCE_MS = 60_000;

const DEFAULT_PLATFORM_POLICY: AgentPermissionPolicyV1 = {
  version: 1,
  preset: 'build',
  categories: {
    [AgentPolicyCategory.ExternalAction]: AgentPolicyDecision.Ask,
    [AgentPolicyCategory.SpawnAgent]: AgentPolicyDecision.Allow,
  },
  maxDelegationDepth: 4,
  maxConcurrentRuns: 8,
  maxWallTimeMs: 24 * 60 * 60 * 1_000,
  maxAttempts: 3,
  maxTokens: null,
  maxSpendMicros: null,
};

export interface RecoveryRunRecord {
  run: AgentRunDtoV1;
  leaseExpiresAt: number | null;
}

export interface AgentRunRecoverySource {
  list(afterId: string | null, limit: number): RecoveryRunRecord[];
  reclaimExpired(record: RecoveryRunRecord, now: number, instanceId: string): boolean;
}

export interface AgentRunRecoverySummary {
  launched: number;
  reclaimed: number;
  waiting: number;
  watchesEvaluated: number;
  deliveriesRetried: number;
  failures: Array<{ id: string; message: string }>;
}

export interface AgentRunAssemblyDeps {
  enabled?: boolean;
  instanceId?: string;
  clock?: AgentRunClock;
  dataDir?: string;
  defaultCwd?: string;
  heartbeatIntervalMs?: number;
  maintenanceIntervalMs?: number;
  shutdownDrainTimeoutMs?: number;
  repository?: AgentRunsRepository;
  definitionService?: AgentDefinitionService;
  coordinator?: AgentRunCoordinator;
  watches?: AgentRunWatchCoordinator;
  retention?: AgentRunRetention;
  executor?: AgentRunExecutor;
  registry?: RuntimeRunAdapterRegistry;
  contexts?: RunContextSnapshotStore;
  notifier?: AgentRunNotifier;
  parentSink?: ParentContinuationSink;
  resourceCleaner?: AgentRunResourceCleaner;
  workspaces?: AgentRunWorkspaceResolver;
  activeTurns?: ActiveTurnResolver;
  recoverySource?: AgentRunRecoverySource;
  chatManager?: ChatManager;
  chatHub?: ChatHub;
  platformPermissionPolicy?: AgentPermissionPolicyV1;
}

class SqliteRecoverySource implements AgentRunRecoverySource {
  constructor(private readonly repository: AgentRunsRepository) {}

  list(afterId: string | null, limit: number): RecoveryRunRecord[] {
    const params: Array<string | number> = [];
    const cursor = afterId ? 'AND id > ?' : '';
    if (afterId) params.push(afterId);
    params.push(Math.max(1, Math.min(limit, 100)));
    const rows = getDb().prepare(`SELECT id, owner_user_id, lease_expires_at FROM agent_runs
      WHERE status IN ('queued','preparing','running','waiting','recovering') ${cursor}
      ORDER BY id LIMIT ?`).all(...params) as Array<{
        id: string;
        owner_user_id: string;
        lease_expires_at: number | null;
      }>;
    return rows.flatMap((row) => {
      const run = this.repository.getRun(row.owner_user_id, row.id);
      return run ? [{ run, leaseExpiresAt: row.lease_expires_at }] : [];
    });
  }

  reclaimExpired(record: RecoveryRunRecord, now: number, instanceId: string): boolean {
    const run = record.run;
    if (run.status !== AgentRunStatus.Preparing && run.status !== AgentRunStatus.Running) return false;
    return runInTransaction(() => {
      const nextSeq = run.latestEventSeq + 1;
      const changed = getDb().prepare(`UPDATE agent_runs SET
        status = 'recovering', waiting_reason = NULL,
        lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
        latest_event_seq = ?, updated_at = ?
        WHERE id = ? AND owner_user_id = ? AND latest_event_seq = ?
          AND status IN ('preparing','running') AND lease_expires_at <= ?`).run(
        nextSeq, now, run.id, run.ownerUserId, run.latestEventSeq, now,
      );
      if (Number(changed.changes) !== 1) return false;
      if (run.activeAttemptId) {
        const error = JSON.stringify({
          version: 1,
          code: 'backend_restart',
          category: 'transient',
          message: `Attempt lease expired before recovery by ${instanceId}`,
          retryable: true,
        });
        getDb().prepare(`UPDATE agent_run_attempts SET status = 'failed', completed_at = ?, error = ?
          WHERE id = ? AND run_id = ? AND status NOT IN ('completed','failed','cancelled')`)
          .run(now, error, run.activeAttemptId, run.id);
      }
      getDb().prepare(`INSERT INTO agent_run_events
        (run_id, seq, attempt_id, type, payload, created_at) VALUES (?, ?, ?, 'recovery_started', ?, ?)`)
        .run(run.id, nextSeq, run.activeAttemptId, JSON.stringify({
          version: 1,
          reason: 'expired_lease',
          previousStatus: run.status,
          recoveryInstanceId: instanceId,
        }), now);
      return true;
    });
  }
}

class WatchDeliveryRecordStore implements ParentDeliveryRecordStore {
  get(deliveryId: string): ParentDeliveryRecord | null {
    const row = getDb().prepare(`SELECT delivery_id, requested_turn_id, delivery_status
      FROM agent_run_watches WHERE delivery_id = ?`).get(deliveryId) as {
        delivery_id: string;
        requested_turn_id: string;
        delivery_status: 'pending' | 'delivered' | 'undeliverable';
      } | undefined;
    if (!row) return null;
    return {
      deliveryId: row.delivery_id,
      requestedTurnId: row.requested_turn_id,
      state: row.delivery_status,
    };
  }

  createPending(input: ParentContinuationDeliveryInput): ParentDeliveryRecord {
    const existing = this.get(input.deliveryId);
    if (!existing) throw new Error('Parent delivery record was not committed by its Watch');
    if (existing.requestedTurnId !== input.requestedTurnId) throw new Error('Parent delivery requested turn mismatch');
    return existing;
  }

  markDelivering(deliveryId: string): ParentDeliveryRecord {
    const record = this.get(deliveryId);
    if (!record) throw new Error('Parent delivery record not found');
    return record.state === 'pending' ? { ...record, state: 'delivering' } : record;
  }

  markTerminal(deliveryId: string, state: 'delivered' | 'undeliverable'): ParentDeliveryRecord {
    const now = Date.now();
    getDb().prepare(`UPDATE agent_run_watches SET delivery_status = ?, delivered_at = ?, updated_at = ?
      WHERE delivery_id = ? AND delivery_status = 'pending'`).run(state, now, now, deliveryId);
    return this.get(deliveryId) ?? { deliveryId, requestedTurnId: '', state };
  }
}

export class ProductionParentTarget {
  constructor(
    private readonly chatManager: ChatManager,
    private readonly hub: ChatHub,
    private readonly coordinator: AgentRunCoordinator,
  ) {}

  async continueParent(input: ParentContinuationDeliveryInput): Promise<'delivered' | 'undeliverable'> {
    const prompt = [
      'Background Agent work reached its Watch condition.',
      `Run IDs: ${input.runIds.join(', ')}`,
      input.handoff,
      'Continue the Parent task using only this compact handoff. Do not assume access to worker transcripts.',
    ].join('\n\n');
    if (input.parentNodeId) {
      const session = await this.chatManager.ensureParentSession({
        ownerUserId: input.ownerUserId,
        workspaceId: input.workspaceId,
        nodeId: input.parentNodeId,
      });
      if (!session) return 'undeliverable';
      const turn = await this.hub.startRequestedSelfTurn({
        chatId: session.id,
        nodeId: input.parentNodeId,
        ownerUserId: input.ownerUserId,
        turnId: input.requestedTurnId,
        text: prompt,
        session,
      });
      await turn.done;
      return this.hub.requestedTurnStatus(input.requestedTurnId) === 'completed'
        ? 'delivered'
        : 'undeliverable';
    }
    if (input.parentRunId) {
      const parent = this.coordinator.check(input.ownerUserId, input.parentRunId);
      if (!parent?.activeAttemptId) return 'undeliverable';
      try {
        const accepted = await this.coordinator.input(input.ownerUserId, parent.id, {
          version: 1,
          text: prompt,
          mode: 'queued',
          expectedAttemptId: parent.activeAttemptId,
        }, input.deliveryId);
        return accepted ? 'delivered' : 'undeliverable';
      } catch {
        return 'undeliverable';
      }
    }
    return 'undeliverable';
  }
}

class DefaultWorkspaceResolver implements AgentRunWorkspaceResolver {
  constructor(
    private readonly defaultCwd: string,
    private readonly policy: AgentPermissionPolicyV1,
  ) {}

  resolve(ownerUserId: string, workspaceId: string) {
    const workspace = getWorkspace(workspaceId);
    if (!workspace || !workspaceOwnerMatches(workspace.owner_user_id ?? null, ownerUserId)) {
      throw new Error('workspace not found');
    }
    return { cwd: workspace.cwd ?? this.defaultCwd, permissionPolicy: this.policy };
  }
}

export class FileSystemRunCleaner implements AgentRunResourceCleaner {
  private readonly contextsRoot: string;
  private readonly worktreesRoot: string;
  private readonly leasesRoot: string;

  constructor(private readonly dataDir: string, private readonly contexts: RunContextSnapshotStore) {
    this.contextsRoot = path.resolve(dataDir, 'agent-runs', 'context-snapshots');
    this.worktreesRoot = path.resolve(dataDir, 'agent-runs', 'worktrees');
    this.leasesRoot = path.resolve(dataDir, 'agent-runs', 'environment-leases');
  }

  async cleanup(runId: string): Promise<void> {
    const row = getDb().prepare('SELECT context_manifest, execution_environment FROM agent_runs WHERE id = ?')
      .get(runId) as { context_manifest: string; execution_environment: string } | undefined;
    if (!row) return;
    await this.cleanupResources(runId, {
      contextManifest: JSON.parse(row.context_manifest),
      executionEnvironment: JSON.parse(row.execution_environment),
    });
  }

  async cleanupResources(runId: string, resources: AgentRunCleanupResources): Promise<void> {
    const manifest = resources.contextManifest as { entries?: Array<{ snapshotPath?: string }> };
    const snapshotRoots = new Set<string>();
    for (const entry of manifest.entries ?? []) {
      if (!entry.snapshotPath) continue;
      const candidate = path.resolve(entry.snapshotPath, '..', '..');
      if (inside(this.contextsRoot, candidate)) snapshotRoots.add(candidate);
    }
    for (const root of snapshotRoots) await rm(root, { recursive: true, force: true });
    await this.contexts.cleanup(runId);

    const environment = resources.executionEnvironment as { kind?: string; cwd?: string };
    if (environment.kind !== 'git_worktree' || !environment.cwd) return;
    const worktree = path.resolve(environment.cwd);
    if (!inside(this.worktreesRoot, worktree)) throw new Error('Run worktree escaped the Michi data directory');
    for (const name of await readdir(this.leasesRoot).catch(() => [] as string[])) {
      const directory = path.join(this.leasesRoot, name);
      const markerPath = path.join(directory, 'lease.json');
      let marker: { sourceRepositoryRoot?: string; worktreePath?: string };
      try { marker = JSON.parse(await readFile(markerPath, 'utf8')); } catch { continue; }
      if (path.resolve(marker.worktreePath ?? '') !== worktree || !marker.sourceRepositoryRoot) continue;
      await execFileAsync('git', ['worktree', 'remove', '--force', worktree], {
        cwd: marker.sourceRepositoryRoot,
        timeout: 20_000,
      }).catch((error) => { throw new Error(`Run worktree cleanup failed: ${(error as Error).message}`); });
      await rm(worktree, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
      return;
    }
    if (await exists(worktree)) throw new Error('Run worktree ownership marker is missing');
  }
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function exists(filePath: string): Promise<boolean> {
  try { await readFile(path.join(filePath, '.git')); return true; }
  catch {
    try { return (await readdir(filePath)).length >= 0; } catch { return false; }
  }
}

export class AgentRunAssembly {
  readonly enabled: boolean;
  readonly repository: AgentRunsRepository;
  readonly definitionService: AgentDefinitionService;
  readonly coordinator: AgentRunCoordinator;
  readonly watches: AgentRunWatchCoordinator;
  readonly routeService: AgentRunRouteService;
  readonly sse: AgentRunSseDeps;
  readonly resourceCleaner: AgentRunResourceCleaner;

  private readonly clock: AgentRunClock;
  private readonly instanceId: string;
  private readonly recoverySource: AgentRunRecoverySource;
  private readonly retention: AgentRunRetention;
  private readonly heartbeatIntervalMs: number;
  private readonly maintenanceIntervalMs: number;
  private readonly shutdownDrainTimeoutMs: number;
  private readonly timerHandles = new Set<unknown>();
  private readonly background = new Set<Promise<unknown>>();
  private readonly activeTurns: ActiveTurnResolver;
  private watchSubscription: (() => void) | null = null;
  private started = false;
  private stopping = false;
  private accepting = true;
  private watchEvaluationRunning = false;
  private watchEvaluationDirty = false;

  constructor(private readonly deps: AgentRunAssemblyDeps) {
    this.enabled = deps.enabled ?? process.env.MICHI_CUSTOM_AGENTS === '1';
    this.clock = deps.clock ?? systemAgentRunClock;
    this.instanceId = deps.instanceId ?? `agent-run-${process.pid}`;
    this.heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
    this.maintenanceIntervalMs = deps.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_MS;
    this.shutdownDrainTimeoutMs = deps.shutdownDrainTimeoutMs ?? 5_000;
    const dataDir = deps.dataDir ?? getMichiDataDir();
    const defaultCwd = deps.defaultCwd ?? process.cwd();
    const platformPolicy = deps.platformPermissionPolicy ?? DEFAULT_PLATFORM_POLICY;
    const catalog = deps.definitionService?.capabilityCatalog ?? new AgentCapabilityCatalog(
      this.enabled
        ? [new BuiltinAgentCapabilitySource(), new AgentRunToolCapabilitySource()]
        : [new BuiltinAgentCapabilitySource()],
    );
    const registry = deps.registry ?? new RuntimeRunAdapterRegistry([
      new PiRunAdapter(),
      new ClaudeRunAdapter(),
      new KiroRunAdapter(),
      new CodexRunAdapter(),
    ]);
    this.definitionService = deps.definitionService ?? new AgentDefinitionService({
      capabilityCatalog: catalog,
      repository: new AgentDefinitionsRepository({ capabilityCatalog: catalog }),
      adapterRegistry: registry,
    });
    this.repository = deps.repository ?? new AgentRunsRepository({ now: () => this.clock.now() });
    const workspaces = deps.workspaces ?? new DefaultWorkspaceResolver(defaultCwd, platformPolicy);
    const allowedRoots = [dataDir, ...listWorkspaces().flatMap((workspace) => workspace.cwd ? [workspace.cwd] : [])];
    const contexts = deps.contexts ?? new FileRunContextSnapshotStore({ dataDir, allowedSourceRoots: allowedRoots });
    const cleaner = deps.resourceCleaner ?? new FileSystemRunCleaner(dataDir, contexts);
    this.resourceCleaner = cleaner;
    const environments = new DefaultExecutionEnvironmentProvider({
      worktrees: new GitWorktreeEnvironment({ dataRoot: dataDir, now: () => this.clock.now() }),
      now: () => this.clock.now(),
    });
    const notifier = deps.notifier ?? { notify: async () => {} };
    const placeholderSink: ParentContinuationSink = { deliver: async () => 'undeliverable' };
    this.coordinator = deps.coordinator ?? new AgentRunCoordinator({
      repository: this.repository,
      definitions: this.definitionService.repository,
      capabilities: catalog,
      contexts,
      environments,
      executor: deps.executor ?? new RuntimeRunExecutor({ registry }),
      workspaces,
      notifier,
      parentSink: placeholderSink,
      resourceCleaner: cleaner,
      clock: this.clock,
      instanceId: this.instanceId,
      platformPermissionPolicy: platformPolicy,
      maxRunTtlMs: MAX_RUN_TTL_MS,
    });
    const hub = deps.chatHub ?? defaultChatHub;
    const productionParentSink = deps.parentSink ?? (deps.chatManager
      ? new AgentRunParentDelivery(new WatchDeliveryRecordStore(), new ProductionParentTarget(deps.chatManager, hub, this.coordinator))
      : placeholderSink);
    this.watches = deps.watches ?? new AgentRunWatchCoordinator(this.repository, notifier, productionParentSink, this.clock);
    const api = new AgentRunApiService(this.coordinator, this.repository, this.watches);
    this.routeService = this.guardedRouteService(api);
    this.sse = { source: this.repository, events: this.coordinator.events, now: () => this.clock.now() };
    this.retention = deps.retention ?? new AgentRunRetention(this.repository, cleaner);
    this.recoverySource = deps.recoverySource ?? new SqliteRecoverySource(this.repository);
    this.activeTurns = deps.activeTurns ?? {
      resolve: (input) => hub.resolveActiveInvocationAnchor({
        runtimeSessionId: input.runtimeSessionId,
        nodeId: input.parentNodeId,
        ownerUserId: input.ownerUserId,
        runtimeToolCallId: input.runtimeToolCallId,
      }),
    };
  }

  createToolInvoker(caller: AgentRunCaller): AgentRunToolInvoker {
    if (!this.enabled || !this.accepting) throw new Error('Custom Agents are disabled or shutting down');
    return createAgentRunToolBridge({
      caller,
      activeTurns: this.activeTurns,
      definitions: this.definitionService,
      coordinator: this.coordinator,
      repository: this.repository,
      watches: this.watches,
    });
  }

  async recoverStartup(): Promise<AgentRunRecoverySummary> {
    const summary: AgentRunRecoverySummary = {
      launched: 0,
      reclaimed: 0,
      waiting: 0,
      watchesEvaluated: 0,
      deliveriesRetried: 0,
      failures: [],
    };
    if (!this.enabled) return summary;
    await this.recoverRunnableRuns(summary);
    const watchRecovery = await this.watches.recoverStartupWatches();
    summary.watchesEvaluated = watchRecovery.activeEvaluated;
    summary.deliveriesRetried = watchRecovery.deliveriesRetried;
    summary.failures.push(...watchRecovery.failures.map((failure) => ({ id: failure.watchId, message: failure.message })));
    return summary;
  }

  private async recoverRunnableRuns(summary: AgentRunRecoverySummary): Promise<void> {
    let afterId: string | null = null;
    while (true) {
      const page = this.recoverySource.list(afterId, 100);
      if (!page.length) break;
      for (const record of page) {
        const run = record.run;
        if (run.status === AgentRunStatus.Waiting) {
          summary.waiting += 1;
          continue;
        }
        if (run.status === AgentRunStatus.Preparing || run.status === AgentRunStatus.Running) {
          if (record.leaseExpiresAt === null || record.leaseExpiresAt > this.clock.now()) continue;
          if (!this.recoverySource.reclaimExpired(record, this.clock.now(), this.instanceId)) continue;
          summary.reclaimed += 1;
        }
        summary.launched += 1;
        this.trackBackground(this.coordinator.start(run.ownerUserId, run.id).catch((error) => {
          summary.failures.push({ id: run.id, message: error instanceof Error ? error.message : String(error) });
          return null;
        }));
      }
      afterId = page.at(-1)!.run.id;
      if (page.length < 100) break;
    }
  }

  async runMaintenance(): Promise<void> {
    if (!this.enabled || this.stopping) return;
    const recovery: AgentRunRecoverySummary = {
      launched: 0, reclaimed: 0, waiting: 0, watchesEvaluated: 0,
      deliveriesRetried: 0, failures: [],
    };
    await this.recoverRunnableRuns(recovery);
    for (const failure of recovery.failures) {
      log.warn('boot', 'Agent Run lease recovery failed; will retry', failure);
    }
    const scopes = getDb().prepare('SELECT DISTINCT owner_user_id, workspace_id FROM agent_runs')
      .all() as Array<{ owner_user_id: string; workspace_id: string }>;
    for (const scope of scopes) {
      await this.retention.cleanupExpired(scope.owner_user_id, scope.workspace_id, this.clock.now());
    }
  }

  async start(): Promise<AgentRunRecoverySummary> {
    if (!this.enabled) return this.recoverStartup();
    if (this.started) return this.recoverStartup();
    this.started = true;
    this.accepting = true;
    this.watchSubscription = this.coordinator.events.subscribeAll(() => this.scheduleWatchEvaluation());
    const summary = await this.recoverStartup();
    this.scheduleRecurring(() => {
      const coordinator = this.coordinator as AgentRunCoordinator & { heartbeatAll?: () => number };
      coordinator.heartbeatAll?.();
    }, this.heartbeatIntervalMs);
    this.scheduleRecurring(() => { void this.runMaintenance().catch((error) => {
      log.warn('boot', 'Agent Run maintenance failed; will retry', { error: error instanceof Error ? error.message : String(error) });
    }); }, this.maintenanceIntervalMs);
    return summary;
  }

  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.accepting = false;
    for (const handle of this.timerHandles) this.clock.clearTimeout(handle);
    this.timerHandles.clear();
    this.watchSubscription?.();
    this.watchSubscription = null;
    const coordinator = this.coordinator as AgentRunCoordinator & { shutdown?: () => Promise<void> };
    await coordinator.shutdown?.();
    await this.drainBackground();
    this.background.clear();
    this.started = false;
  }

  activeTimerCount(): number { return this.timerHandles.size; }

  private scheduleRecurring(callback: () => void, intervalMs: number): void {
    if (intervalMs <= 0 || this.stopping) return;
    const tick = () => {
      this.timerHandles.delete(handle);
      if (this.stopping) return;
      callback();
      this.scheduleRecurring(callback, intervalMs);
    };
    const handle = this.clock.setTimeout(tick, intervalMs);
    this.timerHandles.add(handle);
  }

  private trackBackground<T>(promise: Promise<T>): Promise<T> {
    this.background.add(promise);
    void promise.then(
      () => this.background.delete(promise),
      (error) => {
        this.background.delete(promise);
        log.warn('boot', 'Agent Run background task failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return promise;
  }

  private async drainBackground(): Promise<void> {
    if (this.background.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      // Deliberately NOT unref'ed: when a detached Run promise never settles,
      // this timer is what guarantees shutdown() resolves within the bound.
      // An unref'ed timer lets the event loop drain first, leaving shutdown()
      // pending forever. The race clears it immediately after, so it never
      // outlives the drain window.
      timer = setTimeout(resolve, Math.max(0, this.shutdownDrainTimeoutMs));
    });
    await Promise.race([Promise.allSettled([...this.background]).then(() => undefined), timeout]);
    if (timer) clearTimeout(timer);
  }

  private scheduleWatchEvaluation(): void {
    if (this.watchEvaluationRunning) {
      this.watchEvaluationDirty = true;
      return;
    }
    this.watchEvaluationRunning = true;
    const task = (async () => {
      do {
        this.watchEvaluationDirty = false;
        await this.watches.recoverStartupWatches();
      } while (this.watchEvaluationDirty && !this.stopping);
    })().finally(() => { this.watchEvaluationRunning = false; });
    this.trackBackground(task);
  }

  private guardedRouteService(api: AgentRunApiService): AgentRunRouteService {
    return {
      spawn: (owner, request, operationId) => {
        if (!this.enabled || !this.accepting) return Promise.reject(new Error('Agent Run service is unavailable'));
        return api.spawn(owner, request, operationId);
      },
      list: (...args) => api.list(...args),
      getDetail: (...args) => api.getDetail(...args),
      events: (...args) => api.events(...args),
      input: (...args) => api.input(...args),
      cancel: (...args) => api.cancel(...args),
      respond: (...args) => api.respond(...args),
      createWatch: (...args) => api.createWatch(...args),
      updateWatch: (...args) => api.updateWatch(...args),
    };
  }
}

export function createAgentRunAssembly(deps: AgentRunAssemblyDeps = {}): AgentRunAssembly {
  return new AgentRunAssembly(deps);
}
