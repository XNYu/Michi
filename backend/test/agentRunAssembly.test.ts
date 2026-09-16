import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRunStatus, type AgentRunDtoV1 } from 'michi-shared';
import { createAgentRunAssembly, type AgentRunRecoverySource } from '../src/agents/agentRunAssembly';
import { closeDb, initDb } from '../src/services/db';

class FakeClock {
  nowValue = 1_000;
  next = 0;
  timers = new Map<number, () => void>();
  now = () => this.nowValue;
  setTimeout = (callback: () => void) => { const id = ++this.next; this.timers.set(id, callback); return id; };
  clearTimeout = (handle: unknown) => { this.timers.delete(handle as number); };
}

const HASH = 'a'.repeat(64);
function run(id: string, status: AgentRunStatus): AgentRunDtoV1 {
  return {
    version: 1, id, ownerUserId: 'owner-1', workspaceId: 'workspace-1', definitionId: null, definitionRevision: null,
    effectiveDefinition: { version: 1, name: 'Worker', description: 'Works', instructions: 'Work',
      runtimeProfile: { version: 1, runtimeId: 'pi' }, fallbackChain: [], capabilitySnapshot: { version: 1, entries: [] },
      permissionPolicy: { version: 1, preset: 'research', categories: {}, maxDelegationDepth: 1, maxConcurrentRuns: 1, maxWallTimeMs: 60_000, maxAttempts: 1 },
      contextPolicy: { version: 1, includeWorkspaceInstructions: false, allowMessageContext: true, allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 1_000 } },
    invocationMode: 'manual' as any, completionMode: 'detach' as any,
    parentRunId: null, parentAttemptId: null, parentNodeId: null, parentTurnId: null, parentMessageId: null, parentToolCallId: null,
    task: 'Work', contextManifest: { version: 1, entries: [], assembledAt: 1, estimatedChars: 0 }, expectedResult: null,
    executionEnvironment: { version: 1, kind: 'shared_workspace', cwd: '/tmp', sourceWorkspaceId: 'workspace-1', snapshotHash: HASH, createdAt: 1 },
    status, waitingReason: status === AgentRunStatus.Waiting ? 'user_input' as any : null, activeAttemptId: null,
    resultBundle: null, latestEventSeq: 0, createdAt: 1, startedAt: status === AgentRunStatus.Queued ? null : 1,
    completedAt: null, archivedAt: null, expiresAt: null,
  };
}

function fakeCoordinator(starts: string[] = [], completion: Promise<unknown> = Promise.resolve(null)) {
  return {
    events: { subscribeAll: () => () => {} },
    start: async (_owner: string, runId: string) => { starts.push(runId); await completion; return null; },
    check: () => null, input: async () => false, cancel: async () => false,
    wait: async () => ({ run: null, resultBundle: null, stillRunning: false }),
    shutdown: async () => {},
  } as any;
}

const fakeWatches = (summary = { activeEvaluated: 0, deliveriesRetried: 0, failures: [] as Array<{ watchId: string; message: string }> }) => ({
  recoverStartupWatches: async () => summary,
  create: () => { throw new Error('unused'); }, addRuns: () => 0, evaluate: async () => false,
}) as any;

describe('AgentRunAssembly', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-run-assembly-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb(); initDb();
  });
  afterEach(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('feature-off assembly is inert and exposes neither timers nor tool/spawn entry points', async () => {
    const clock = new FakeClock();
    const assembly = createAgentRunAssembly({ enabled: false, dataDir: tmpDir, clock,
      coordinator: fakeCoordinator(), watches: fakeWatches(),
      recoverySource: { list: () => { throw new Error('disabled recovery must not inspect Runs'); }, reclaimExpired: () => false },
      retention: { cleanupExpired: async () => { throw new Error('disabled maintenance must be inert'); } } as any });
    assert.equal(assembly.enabled, false);
    assert.deepEqual(await assembly.start(), { launched: 0, reclaimed: 0, waiting: 0, watchesEvaluated: 0, deliveriesRetried: 0, failures: [] });
    assert.equal(assembly.activeTimerCount(), 0);
    const disabledInvoker = assembly.createToolInvoker({ kind: 'conversation', ownerUserId: 'owner-1', workspaceId: 'workspace-1', parentNodeId: 'node-1' });
    await assert.rejects(() => disabledInvoker.invoke('list_agents', {}), /disabled/);
    await assert.rejects(() => assembly.routeService.spawn('owner-1', {} as any, 'operation-1'), /unavailable/);
    await assembly.runMaintenance();
    assert.equal(clock.timers.size, 0);
  });

  test('dynamic feature gate can start lazily and immediately blocks new tool entry points when disabled', async () => {
    let enabled = false;
    const clock = new FakeClock();
    const assembly = createAgentRunAssembly({ isEnabled: () => enabled, dataDir: tmpDir, clock,
      coordinator: fakeCoordinator(), watches: fakeWatches(),
      recoverySource: { list: () => [], reclaimExpired: () => false },
      retention: { cleanupExpired: async () => [] } as any });

    assert.equal(assembly.enabled, false);
    await assembly.start();
    assert.equal(assembly.activeTimerCount(), 0);

    enabled = true;
    await assembly.start();
    assert.equal(assembly.enabled, true);
    assert.equal(assembly.activeTimerCount(), 2);
    await assert.rejects(() => assembly.routeService.spawn('owner-1', {} as any, 'before-enable-commit'), /unavailable/);
    assembly.completeFeatureEnable();
    const existingInvoker = assembly.createToolInvoker({ kind: 'conversation', ownerUserId: 'owner-1', workspaceId: 'workspace-1', parentNodeId: 'node-1' });

    enabled = false;
    assert.equal(assembly.enabled, false);
    const newlyDisabledInvoker = assembly.createToolInvoker({ kind: 'conversation', ownerUserId: 'owner-1', workspaceId: 'workspace-1', parentNodeId: 'node-1' });
    await assert.rejects(() => newlyDisabledInvoker.invoke('list_agents', {}), /disabled/);
    await assert.rejects(() => existingInvoker.invoke('list_agents', {}), /disabled/);
  });

  test('failed startup rolls back and a later enable installs maintenance timers', async () => {
    let recoveryAttempts = 0;
    const clock = new FakeClock();
    const watches = fakeWatches();
    watches.recoverStartupWatches = async () => {
      recoveryAttempts += 1;
      if (recoveryAttempts === 1) throw new Error('transient recovery failure');
      return { activeEvaluated: 0, deliveriesRetried: 0, failures: [] };
    };
    const assembly = createAgentRunAssembly({ enabled: true, dataDir: tmpDir, clock,
      coordinator: fakeCoordinator(), watches,
      recoverySource: { list: () => [], reclaimExpired: () => false },
      retention: { cleanupExpired: async () => [] } as any });

    await assert.rejects(() => assembly.start(), /transient recovery failure/);
    assert.equal(assembly.activeTimerCount(), 0);
    await assembly.start();
    assert.equal(assembly.activeTimerCount(), 2);
  });

  test('concurrent start calls share one recovery pass', async () => {
    let recoveryCalls = 0;
    let releaseRecovery!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    const watches = fakeWatches();
    watches.recoverStartupWatches = async () => {
      recoveryCalls += 1;
      await blocked;
      return { activeEvaluated: 0, deliveriesRetried: 0, failures: [] };
    };
    const assembly = createAgentRunAssembly({ enabled: true, dataDir: tmpDir, clock: new FakeClock(),
      coordinator: fakeCoordinator(), watches,
      recoverySource: { list: () => [], reclaimExpired: () => false },
      retention: { cleanupExpired: async () => [] } as any });

    const first = assembly.start();
    const second = assembly.start();
    releaseRecovery();
    await Promise.all([first, second]);

    assert.equal(recoveryCalls, 1);
  });

  test('disable closes admission before an in-flight spawn can commit', async () => {
    let releaseSpawn!: () => void;
    let markSpawnEntered!: () => void;
    const spawnBlocked = new Promise<void>((resolve) => { releaseSpawn = resolve; });
    const spawnEntered = new Promise<void>((resolve) => { markSpawnEntered = resolve; });
    const coordinator = {
      ...fakeCoordinator(),
      spawn: async () => {
        markSpawnEntered();
        await spawnBlocked;
        return run('spawned', AgentRunStatus.Queued);
      },
    } as any;
    const assembly = createAgentRunAssembly({ enabled: true, dataDir: tmpDir, clock: new FakeClock(),
      coordinator, watches: fakeWatches(),
      recoverySource: { list: () => [], reclaimExpired: () => false },
      retention: { cleanupExpired: async () => [] } as any });

    const admitted = assembly.routeService.spawn('owner-1', {} as any, 'admitted');
    await spawnEntered;
    assert.equal(assembly.beginFeatureDisable(), 1);
    await assert.rejects(() => assembly.routeService.spawn('owner-1', {} as any, 'blocked'), /unavailable/);
    releaseSpawn();
    await admitted;
  });

  test('startup audits queued, expired-running, waiting, and fired-pending state without awaiting long Run completion', async () => {
    const starts: string[] = [];
    const never = new Promise<unknown>(() => {});
    let page = 0;
    const records = [
      { run: run('queued', AgentRunStatus.Queued), leaseExpiresAt: null },
      { run: run('expired-running', AgentRunStatus.Running), leaseExpiresAt: 999 },
      { run: run('waiting', AgentRunStatus.Waiting), leaseExpiresAt: null },
    ];
    const recoverySource: AgentRunRecoverySource = {
      list: () => page++ === 0 ? records : [],
      reclaimExpired: (record) => record.run.id === 'expired-running',
    };
    const assembly = createAgentRunAssembly({ enabled: true, dataDir: tmpDir, clock: new FakeClock(),
      coordinator: fakeCoordinator(starts, never), recoverySource,
      watches: fakeWatches({ activeEvaluated: 1, deliveriesRetried: 1, failures: [] }),
      heartbeatIntervalMs: 0, maintenanceIntervalMs: 0 });
    const startedAt = Date.now();
    const summary = await assembly.start();
    assert(Date.now() - startedAt < 100, 'readiness must not wait for long Run completion');
    assert.deepEqual(summary, { launched: 2, reclaimed: 1, waiting: 1, watchesEvaluated: 1, deliveriesRetried: 1, failures: [] });
    assert.deepEqual(starts, ['queued', 'expired-running']);
  });

  test('maintenance periodically reclaims an expired active lease', async () => {
    const starts: string[] = [];
    let reclaimed = false;
    const record = { run: run('expired-running', AgentRunStatus.Running), leaseExpiresAt: 999 };
    const recoverySource: AgentRunRecoverySource = {
      list: (afterId) => afterId ? [] : [record],
      reclaimExpired: () => { if (reclaimed) return false; reclaimed = true; return true; },
    };
    const assembly = createAgentRunAssembly({ enabled: true, dataDir: tmpDir, clock: new FakeClock(),
      coordinator: fakeCoordinator(starts), recoverySource, watches: fakeWatches(),
      retention: { cleanupExpired: async () => [] } as any,
      heartbeatIntervalMs: 0, maintenanceIntervalMs: 0 });
    await assembly.runMaintenance();
    await Promise.resolve();
    assert.equal(reclaimed, true);
    assert.deepEqual(starts, ['expired-running']);
  });

  test('shutdown bounds the wait for background Runs that ignore cancellation', async () => {
    const never = new Promise<unknown>(() => {});
    let page = 0;
    const assembly = createAgentRunAssembly({ enabled: true, dataDir: tmpDir, clock: new FakeClock(),
      coordinator: fakeCoordinator([], never), watches: fakeWatches(),
      recoverySource: { list: () => page++ === 0
        ? [{ run: run('queued', AgentRunStatus.Queued), leaseExpiresAt: null }]
        : [], reclaimExpired: () => false },
      heartbeatIntervalMs: 0, maintenanceIntervalMs: 0, shutdownDrainTimeoutMs: 5 });
    await assembly.start();
    const startedAt = Date.now();
    await assembly.shutdown();
    assert(Date.now() - startedAt < 250, 'shutdown must not wait forever for a detached Run promise');
  });
});
