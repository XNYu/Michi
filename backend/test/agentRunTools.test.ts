import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';
import {
  AgentDefinitionStatus,
  AgentPolicyCategory,
  AgentPolicyDecision,
  AgentRunCompletionMode,
  AgentRunInvocationMode,
  AgentRunStatus,
  type AgentDefinitionDtoV1,
  type AgentPermissionPolicyV1,
  type AgentRunDtoV1,
  type AgentRunWatchDtoV1,
} from 'michi-shared';
import { createAgentRunToolBridge } from '../src/agents/runToolBridge';

const permission = (spawn: AgentPolicyDecision = AgentPolicyDecision.Allow): AgentPermissionPolicyV1 => ({
  version: 1,
  preset: 'custom',
  categories: { [AgentPolicyCategory.SpawnAgent]: spawn },
  maxDelegationDepth: 3,
  maxConcurrentRuns: 3,
  maxWallTimeMs: 60_000,
  maxAttempts: 2,
});

const definition = (overrides: Partial<AgentDefinitionDtoV1> = {}): AgentDefinitionDtoV1 => ({
  version: 1,
  id: 'agent-ready',
  ownerUserId: 'owner-a',
  scope: 'workspace',
  workspaceId: 'ws-a',
  name: 'Researcher',
  description: 'Researches one bounded topic.',
  instructions: 'Research the requested topic.',
  runtimeProfile: { version: 1, runtimeId: 'pi', modelId: 'model-a' },
  fallbackChain: [],
  toolRefs: [],
  skillRefs: [],
  mcpServerRefs: [],
  permissionPolicy: permission(),
  contextPolicy: { version: 1, includeWorkspaceInstructions: true, allowMessageContext: true, allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 10_000 },
  defaultRunTtlMs: null,
  status: AgentDefinitionStatus.Enabled,
  revision: 2,
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});

const run = (id: string, overrides: Partial<AgentRunDtoV1> = {}): AgentRunDtoV1 => ({
  version: 1,
  id,
  ownerUserId: 'owner-a',
  workspaceId: 'ws-a',
  definitionId: 'agent-ready',
  definitionRevision: 2,
  effectiveDefinition: {
    version: 1,
    name: 'Researcher',
    description: 'Researches one bounded topic.',
    instructions: 'Research.',
    runtimeProfile: { version: 1, runtimeId: 'pi', modelId: 'model-a' },
    fallbackChain: [],
    capabilitySnapshot: { version: 1, entries: [] },
    permissionPolicy: permission(),
    contextPolicy: { version: 1, includeWorkspaceInstructions: true, allowMessageContext: true, allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 10_000 },
  },
  invocationMode: AgentRunInvocationMode.Delegated,
  completionMode: AgentRunCompletionMode.Wait,
  parentRunId: null,
  parentAttemptId: null,
  parentNodeId: 'node-a',
  parentTurnId: 'turn-a',
  parentMessageId: 'message-a',
  parentToolCallId: null,
  task: `task for ${id}`,
  contextManifest: { version: 1, entries: [], assembledAt: 1, estimatedChars: 0 },
  expectedResult: null,
  executionEnvironment: { version: 1, kind: 'shared_workspace', cwd: '/workspace', sourceWorkspaceId: 'ws-a', snapshotHash: 'hash', createdAt: 1 },
  status: AgentRunStatus.Running,
  waitingReason: null,
  activeAttemptId: `${id}-attempt`,
  resultBundle: null,
  latestEventSeq: 1,
  createdAt: 1,
  startedAt: 1,
  completedAt: null,
  archivedAt: null,
  expiresAt: null,
  ...overrides,
});

function harness(caller: any = { kind: 'conversation', ownerUserId: 'owner-a', workspaceId: 'ws-a', parentNodeId: 'node-a' }) {
  const runs = new Map<string, AgentRunDtoV1>();
  const watches = new Map<string, AgentRunWatchDtoV1>();
  const spawnInputs: any[] = [];
  const waits: string[] = [];
  const inputs: any[] = [];
  const cancels: any[] = [];
  const emitter = new EventEmitter();
  let spawned = 0;
  const coordinator = {
    events: {
      subscribeAll(listener: (event: { runId: string }) => void) {
        emitter.on('event', listener);
        return () => emitter.off('event', listener);
      },
    },
    async spawn(input: any) {
      spawnInputs.push(input);
      const value = run(`run-${++spawned}`, {
        parentRunId: input.parentRunId,
        parentAttemptId: input.parentAttemptId,
        parentNodeId: input.parentNodeId,
        parentTurnId: input.parentTurnId,
        parentMessageId: input.parentMessageId,
        parentToolCallId: input.parentToolCallId,
        task: input.task,
      });
      runs.set(value.id, value);
      return value;
    },
    async start(_owner: string, id: string) { return runs.get(id) ?? null; },
    check(_owner: string, id: string) { return runs.get(id) ?? null; },
    async wait(_owner: string, id: string, _timeout: number) {
      waits.push(id);
      const value = runs.get(id) ?? null;
      return { run: value, resultBundle: value?.resultBundle ?? null, stillRunning: !!value && value.status === AgentRunStatus.Running };
    },
    async input(...args: any[]) { inputs.push(args); return true; },
    async cancel(...args: any[]) { cancels.push(args); return true; },
  };
  const definitions = {
    discoverEnabled: () => [definition()],
    async getSpawnable(_owner: string, id: string, workspaceId: string) {
      return id === 'agent-ready' && workspaceId === 'ws-a' ? definition() : null;
    },
  };
  const repository = {
    listRuns: () => [...runs.values()],
    getWatch: (_owner: string, id: string) => watches.get(id) ?? null,
    updateWatchCondition: (_owner: string, id: string, condition: any) => {
      const current = watches.get(id);
      if (!current) return false;
      watches.set(id, { ...current, condition });
      return true;
    },
  };
  const watchCoordinator = {
    create(_owner: string, workspaceId: string, runIds: string[], condition: any, completionMode: 'notify' | 'wake', parent: any) {
      const value: AgentRunWatchDtoV1 = {
        version: 1, id: `watch-${watches.size + 1}`, ownerUserId: 'owner-a', workspaceId,
        runIds: [...runIds], condition, completionMode, status: 'active', deliveryId: 'delivery-1',
        requestedTurnId: 'requested-1', ...parent, createdAt: 1, firedAt: null,
      };
      watches.set(value.id, value);
      return value;
    },
    addRuns(_owner: string, id: string, runIds: string[]) {
      const current = watches.get(id)!;
      watches.set(id, { ...current, runIds: [...new Set([...current.runIds, ...runIds])] });
      return runIds.length;
    },
    async evaluate(_owner: string, id: string) {
      const current = watches.get(id);
      if (!current || !current.runIds.length) return false;
      const members = current.runIds.map((runId) => runs.get(runId)!);
      const fired = current.condition.kind === 'all' && members.every((item) => [AgentRunStatus.Completed, AgentRunStatus.Failed, AgentRunStatus.Cancelled].includes(item.status));
      if (fired) watches.set(id, { ...current, status: 'fired', firedAt: 2 });
      return fired;
    },
  };
  const bridge = createAgentRunToolBridge({
    caller,
    activeTurns: { resolve: ({ runtimeToolCallId }: any) => ({ turnId: 'turn-a', messageId: 'message-a', toolCallId: runtimeToolCallId }) },
    definitions,
    coordinator: coordinator as any,
    repository: repository as any,
    watches: watchCoordinator as any,
    maxWaitMs: 25,
  });
  return { bridge, runs, watches, spawnInputs, waits, inputs, cancels, emitter, definitions, coordinator, repository, watchCoordinator };
}

describe('generic Agent Run tools', () => {
  test('lists only model-discoverable definitions with public readiness and active counts', async () => {
    const h = harness();
    h.runs.set('active', run('active'));
    const result = await h.bridge.invoke('list_agents', {});
    assert.deepEqual((result.agents as any[]).map((agent) => ({ id: agent.id, readiness: agent.readiness, activeRunCount: agent.activeRunCount })), [
      { id: 'agent-ready', readiness: 'ready', activeRunCount: 1 },
    ]);
    assert.equal(JSON.stringify(result).includes('instructions'), false);
  });

  test('rejects draft, disabled, and wrong-Workspace saved Definitions before coordinator spawn', async () => {
    for (const id of ['agent-draft', 'agent-disabled', 'agent-other-workspace']) {
      const h = harness();
      await assert.rejects(() => h.bridge.invoke('spawn_agent', { agentId: id, task: 'Do work' }), /enabled Agent Definition/);
      assert.equal(h.spawnInputs.length, 0);
    }
  });

  test('keeps one durable message anchor and distinct runtime tool-call anchors for sibling spawns', async () => {
    const h = harness();
    await h.bridge.invoke('spawn_agent', { agentId: 'agent-ready', task: 'First' }, { runtimeToolCallId: 'tool-1' });
    await h.bridge.invoke('spawn_agent', { agentId: 'agent-ready', task: 'Second' }, { runtimeToolCallId: 'tool-2' });
    assert.deepEqual(h.spawnInputs.map((input) => input.parentMessageId), ['message-a', 'message-a']);
    assert.deepEqual(h.spawnInputs.map((input) => input.parentAttemptId), [null, null]);
    assert.deepEqual(h.spawnInputs.map((input) => input.parentToolCallId), ['tool-1', 'tool-2']);
    assert.notEqual(h.spawnInputs[0].operationId, h.spawnInputs[1].operationId);
  });

  test('uses a stable fallback operation id when the runtime has no tool-call id', async () => {
    const h = harness();
    await h.bridge.invoke('spawn_agent', { agentId: 'agent-ready', task: 'Same task' });
    await h.bridge.invoke('spawn_agent', { agentId: 'agent-ready', task: 'Same task' });
    assert.equal(h.spawnInputs[0].parentMessageId, 'message-a');
    assert.equal(h.spawnInputs[0].parentToolCallId, null);
    assert.equal(h.spawnInputs[0].operationId, h.spawnInputs[1].operationId);
  });

  test('denies recursive spawn without explicit permission and does not resolve a Chat turn', async () => {
    let resolved = false;
    const h = harness({ kind: 'agent_run', ownerUserId: 'owner-a', workspaceId: 'ws-a', parentRunId: 'parent', parentAttemptId: 'attempt-a' });
    h.runs.set('parent', run('parent', { activeAttemptId: 'attempt-a', effectiveDefinition: { ...run('x').effectiveDefinition, permissionPolicy: permission(AgentPolicyDecision.Deny) } }));
    const bridge = createAgentRunToolBridge({
      caller: { kind: 'agent_run', ownerUserId: 'owner-a', workspaceId: 'ws-a', parentRunId: 'parent', parentAttemptId: 'attempt-a' },
      activeTurns: { resolve: () => { resolved = true; return null; } },
      definitions: h.definitions,
      coordinator: h.coordinator,
      repository: h.repository,
      watches: h.watchCoordinator,
    } as any);
    await assert.rejects(() => bridge.invoke('spawn_agent', { agentId: 'agent-ready', task: 'Child' }), /permission denied/);
    assert.equal(resolved, false);
  });

  test('nested spawn captures the exact active Parent Attempt without conversation anchors', async () => {
    const h = harness({ kind: 'agent_run', ownerUserId: 'owner-a', workspaceId: 'ws-a', parentRunId: 'parent', parentAttemptId: 'attempt-a' });
    h.runs.set('parent', run('parent', { activeAttemptId: 'attempt-a' }));
    await h.bridge.invoke('spawn_agent', { agentId: 'agent-ready', task: 'Child' }, { runtimeToolCallId: 'nested-tool' });
    assert.equal(h.spawnInputs[0].parentRunId, 'parent');
    assert.equal(h.spawnInputs[0].parentAttemptId, 'attempt-a');
    assert.equal(h.spawnInputs[0].parentNodeId, null);
    assert.equal(h.spawnInputs[0].parentMessageId, null);
    assert.equal(h.spawnInputs[0].parentToolCallId, 'nested-tool');
  });

  test('nested spawn rejects a stale Parent Attempt identity', async () => {
    const h = harness({ kind: 'agent_run', ownerUserId: 'owner-a', workspaceId: 'ws-a', parentRunId: 'parent', parentAttemptId: 'stale-attempt' });
    h.runs.set('parent', run('parent', { activeAttemptId: 'active-attempt' }));
    await assert.rejects(() => h.bridge.invoke('spawn_agent', { agentId: 'agent-ready', task: 'Child' }), /not the active Attempt/);
    assert.equal(h.spawnInputs.length, 0);
  });

  test('bounded wait returns stillRunning without cancellation or automatic repeated waits', async () => {
    const h = harness();
    h.runs.set('slow', run('slow'));
    const result = await h.bridge.invoke('wait_agent', { runId: 'slow', timeoutMs: 9999 });
    assert.equal(result.stillRunning, true);
    assert.deepEqual(h.waits, ['slow']);
    assert.equal(h.cancels.length, 0);
  });

  test('input defaults to queued mode and immediate redirect remains explicit and Attempt-scoped', async () => {
    const h = harness();
    h.runs.set('steer', run('steer', { activeAttemptId: 'attempt-current' }));
    const queued = await h.bridge.invoke('send_agent_input', { runId: 'steer', text: 'Use the new evidence' });
    const immediate = await h.bridge.invoke('send_agent_input', { runId: 'steer', text: 'Stop and redirect', mode: 'immediate' });
    assert.equal(queued.mode, 'queued');
    assert.equal(immediate.mode, 'immediate');
    assert.equal(h.inputs[0][2].mode, 'queued');
    assert.equal(h.inputs[0][2].expectedAttemptId, 'attempt-current');
    assert.equal(h.inputs[1][2].mode, 'immediate');
  });

  test('wake Watch captures the same durable Parent turn anchor without a message transcript', async () => {
    const h = harness();
    h.runs.set('run-a', run('run-a'));
    const result = await h.bridge.invoke('watch_agent_runs', {
      runIds: ['run-a'], condition: { kind: 'all' }, completionMode: 'wake',
    }, { runtimeToolCallId: 'watch-tool' });
    const watch = result.watch as AgentRunWatchDtoV1;
    assert.equal(watch.parentNodeId, 'node-a');
    assert.equal(watch.parentTurnId, 'turn-a');
    assert.equal(watch.completionMode, 'wake');
    assert.equal(JSON.stringify(result).includes('message-a'), false);
  });

  test('created Watch is evaluated from committed Run events without Parent polling', async () => {
    const h = harness();
    h.runs.set('run-a', run('run-a'));
    const created = await h.bridge.invoke('watch_agent_runs', {
      runIds: ['run-a'], condition: { kind: 'all' }, completionMode: 'wake',
    });
    const watchId = (created.watch as AgentRunWatchDtoV1).id;
    h.runs.set('run-a', run('run-a', { status: AgentRunStatus.Completed, completedAt: 2 }));
    h.emitter.emit('event', { runId: 'run-a' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.watches.get(watchId)?.status, 'fired');
    assert.deepEqual(h.waits, []);
  });

  test('Watch wait resolves on first failure while a sibling remains active and uncancelled', async () => {
    const h = harness();
    h.runs.set('failed-later', run('failed-later'));
    h.runs.set('sibling', run('sibling'));
    h.watches.set('watch-a', {
      version: 1, id: 'watch-a', ownerUserId: 'owner-a', workspaceId: 'ws-a', runIds: ['failed-later', 'sibling'],
      condition: { version: 1, kind: 'all' }, completionMode: 'notify', status: 'active', deliveryId: 'delivery-a',
      requestedTurnId: 'turn-watch-a', parentRunId: null, parentNodeId: 'node-a', parentTurnId: 'turn-a', createdAt: 1, firedAt: null,
    });
    const waiting = h.bridge.invoke('wait_agent', { watchId: 'watch-a', timeoutMs: 25 });
    queueMicrotask(() => {
      h.runs.set('failed-later', run('failed-later', { status: AgentRunStatus.Failed, completedAt: 2 }));
      h.emitter.emit('event', { runId: 'failed-later' });
    });
    const result = await waiting;
    assert.equal(result.stillRunning, false);
    assert.equal(h.runs.get('sibling')?.status, AgentRunStatus.Running);
    assert.equal(h.cancels.length, 0);
  });

  test('empty historical Watch is inert and non-fireable', async () => {
    const h = harness();
    h.watches.set('empty', {
      version: 1, id: 'empty', ownerUserId: 'owner-a', workspaceId: 'ws-a', runIds: [],
      condition: { version: 1, kind: 'all' }, completionMode: 'wake', status: 'active', deliveryId: 'delivery-empty',
      requestedTurnId: 'turn-empty', parentRunId: null, parentNodeId: 'deleted', parentTurnId: 'old-turn', createdAt: 1, firedAt: null,
    });
    const result = await h.bridge.invoke('wait_agent', { watchId: 'empty', timeoutMs: 25 });
    assert.equal(result.stillRunning, false);
    assert.equal((result.watch as AgentRunWatchDtoV1).status, 'active');
  });

  test('tool results expose compact handoff and never a transcript', async () => {
    const h = harness();
    h.runs.set('done', run('done', {
      status: AgentRunStatus.Completed,
      completedAt: 2,
      resultBundle: {
        version: 1, status: 'completed', source: 'submitted',
        handoff: { conclusion: 'Done', artifactsOrChanges: 'report.md', unresolvedIssues: 'None' },
        artifacts: [], resourceMutations: [], externalActions: [],
      },
    }));
    const result = await h.bridge.invoke('check_agent', { runId: 'done' });
    const text = JSON.stringify(result);
    assert.match(text, /Done/);
    assert.equal(text.includes('transcript'), false);
    assert.equal(text.includes('events'), false);
  });
});
