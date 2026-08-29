import {
  AGENT_RUN_LIMITS,
  AgentPolicyCategory,
  AgentPolicyDecision,
  AgentRunCompletionMode,
  AgentRunInvocationMode,
  AgentRunStatus,
  type AgentDefinitionDtoV1,
  type AgentPermissionPolicyV1,
  type AgentRunContextManifestV1,
  type AgentRunDtoV1,
  type AgentRunInputRequestV1,
  type AgentRunListQueryV1,
  type AgentRunWatchDtoV1,
  type EffectiveAgentDefinitionV1,
  type ExecutionEnvironmentRequestV1,
  type ExpectedResultContractV1,
  type ResultBundleV1,
  type WatchConditionV1,
} from 'michi-shared';
import { compactResultHandoff } from './runs/resultBundle';
import { isTerminalRunStatus } from './runs/agentRunStateMachine';
import type { SpawnCoordinatedRunInput } from './runs/ports';
import {
  resolveAgentRunInvocation,
  type ActiveTurnResolver,
  type AgentRunCaller,
} from './agentRunInvocation';

export const AGENT_RUN_TOOL_NAMES = [
  'list_agents',
  'spawn_agent',
  'check_agent',
  'wait_agent',
  'send_agent_input',
  'cancel_agent',
  'watch_agent_runs',
  'update_agent_watch',
] as const;
export type AgentRunToolName = typeof AGENT_RUN_TOOL_NAMES[number];

export interface AgentRunToolInvoker {
  invoke(name: AgentRunToolName, args: Record<string, unknown>, meta?: { runtimeToolCallId?: string | null }): Promise<Record<string, unknown>>;
}

interface DefinitionServicePort {
  discoverEnabled(ownerUserId: string, workspaceId: string): AgentDefinitionDtoV1[];
  getSpawnable?(ownerUserId: string, id: string, workspaceId: string): Promise<AgentDefinitionDtoV1 | null>;
}

interface CoordinatorPort {
  readonly events: {
    subscribeAll(listener: (event: { runId: string }) => void): () => void;
  };
  spawn(input: SpawnCoordinatedRunInput): Promise<AgentRunDtoV1>;
  start(ownerUserId: string, runId: string): Promise<AgentRunDtoV1 | null>;
  check(ownerUserId: string, runId: string): AgentRunDtoV1 | null;
  wait(ownerUserId: string, runId: string, timeoutMs: number): Promise<{ run: AgentRunDtoV1 | null; resultBundle: ResultBundleV1 | null; stillRunning: boolean }>;
  input(ownerUserId: string, runId: string, request: AgentRunInputRequestV1, operationId: string): Promise<boolean>;
  cancel(ownerUserId: string, runId: string, reason: string | null, expectedAttemptId?: string | null, operationId?: string): Promise<boolean>;
}

interface RepositoryPort {
  listRuns(ownerUserId: string, query: AgentRunListQueryV1): AgentRunDtoV1[];
  getWatch(ownerUserId: string, watchId: string): AgentRunWatchDtoV1 | null;
  updateWatch?(ownerUserId: string, watchId: string, addRunIds: readonly string[], condition?: WatchConditionV1): AgentRunWatchDtoV1 | null;
  updateWatchCondition?(ownerUserId: string, watchId: string, condition: WatchConditionV1): boolean;
}

interface WatchCoordinatorPort {
  create(ownerUserId: string, workspaceId: string, runIds: readonly string[], condition: WatchConditionV1,
    completionMode: 'notify' | 'wake', parent: { parentRunId: string | null; parentNodeId: string | null; parentTurnId: string | null },
    operationId: string): AgentRunWatchDtoV1;
  addRuns(ownerUserId: string, watchId: string, runIds: readonly string[]): number;
  evaluate(ownerUserId: string, watchId: string, manual?: boolean): Promise<boolean>;
}

export interface AgentRunToolBridgeDeps {
  caller: AgentRunCaller;
  activeTurns: ActiveTurnResolver;
  definitions: DefinitionServicePort;
  coordinator: CoordinatorPort;
  repository: RepositoryPort;
  watches: WatchCoordinatorPort;
  maxWaitMs?: number;
}

interface AgentRunToolState {
  armedWatches: Map<string, () => void>;
}

export function createAgentRunToolBridge(deps: AgentRunToolBridgeDeps): AgentRunToolInvoker {
  const maxWaitMs = Math.min(deps.maxWaitMs ?? AGENT_RUN_LIMITS.waitMs, AGENT_RUN_LIMITS.waitMs);
  const ownerUserId = deps.caller.ownerUserId;
  const workspaceId = deps.caller.workspaceId;
  const state: AgentRunToolState = { armedWatches: new Map() };

  return {
    async invoke(name, args, meta = {}) {
      switch (name) {
        case 'list_agents': return listAgents(deps, ownerUserId, workspaceId);
        case 'spawn_agent': return spawnAgent(deps, args, meta.runtimeToolCallId ?? null);
        case 'check_agent': return checkAgent(deps, requiredString(args.runId, 'runId'));
        case 'wait_agent': return waitAgent(deps, args, boundedTimeout(args.timeoutMs, maxWaitMs));
        case 'send_agent_input': return sendAgentInput(deps, args, meta.runtimeToolCallId ?? null);
        case 'cancel_agent': return cancelAgent(deps, args, meta.runtimeToolCallId ?? null);
        case 'watch_agent_runs': return createWatch(deps, state, args, meta.runtimeToolCallId ?? null);
        case 'update_agent_watch': return updateWatch(deps, args);
      }
    },
  };
}

async function listAgents(deps: AgentRunToolBridgeDeps, ownerUserId: string, workspaceId: string) {
  const definitions = deps.definitions.discoverEnabled(ownerUserId, workspaceId);
  const activeRuns = deps.repository.listRuns(ownerUserId, { version: 1, workspaceId, limit: 100 });
  const agents = await Promise.all(definitions.map(async (definition) => {
    let readiness: 'ready' | 'unavailable' = 'ready';
    if (deps.definitions.getSpawnable) {
      try { if (!await deps.definitions.getSpawnable(ownerUserId, definition.id, workspaceId)) readiness = 'unavailable'; }
      catch { readiness = 'unavailable'; }
    }
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      scope: definition.scope,
      runtimeProfile: publicRuntimeProfile(definition.runtimeProfile),
      readiness,
      activeRunCount: activeRuns.filter((run) => run.definitionId === definition.id && !isTerminalRunStatus(run.status)).length,
    };
  }));
  return { version: 1, agents };
}

async function spawnAgent(deps: AgentRunToolBridgeDeps, args: Record<string, unknown>, runtimeToolCallId: string | null) {
  const invocation = await resolveAgentRunInvocation(deps.caller, deps.activeTurns, runtimeToolCallId);
  if (deps.caller.kind === 'agent_run') {
    assertRecursiveDelegation(deps, deps.caller.parentRunId, deps.caller.parentAttemptId);
  }
  const agentId = optionalString(args.agentId);
  const ephemeralDefinition = objectOrNull(args.ephemeralDefinition) as EffectiveAgentDefinitionV1 | null;
  if ((agentId === null) === (ephemeralDefinition === null)) throw new Error('spawn_agent requires exactly one agentId or ephemeralDefinition');
  if (agentId && deps.definitions.getSpawnable && !await deps.definitions.getSpawnable(deps.caller.ownerUserId, agentId, deps.caller.workspaceId)) {
    throw new Error('enabled Agent Definition not found in this Workspace');
  }
  const task = requiredString(args.task, 'task');
  const contextManifest = (objectOrNull(args.contextManifest) ?? emptyContextManifest()) as AgentRunContextManifestV1;
  const operationId = invocation.operationId({ tool: 'spawn_agent', agentId, ephemeralDefinition, task, contextManifest });
  const run = await deps.coordinator.spawn({
    operationId,
    ownerUserId: deps.caller.ownerUserId,
    workspaceId: deps.caller.workspaceId,
    definitionId: agentId,
    ephemeralDefinition,
    invocationMode: AgentRunInvocationMode.Delegated,
    completionMode: completionMode(args.completionMode),
    ...invocation.anchor,
    task,
    contextManifest,
    permissionRestriction: (objectOrNull(args.permissionRestriction) as AgentPermissionPolicyV1 | null),
    environment: (objectOrNull(args.environment) ?? { version: 1, kind: 'auto' }) as ExecutionEnvironmentRequestV1,
    expectedResult: objectOrNull(args.expectedResult) as ExpectedResultContractV1 | null,
    runTtlMs: nullableNumber(args.runTtlMs),
  });
  void deps.coordinator.start(deps.caller.ownerUserId, run.id).catch(() => undefined);
  return { version: 1, run: compactRun(run) };
}

function checkAgent(deps: AgentRunToolBridgeDeps, runId: string) {
  const run = deps.coordinator.check(deps.caller.ownerUserId, runId);
  if (!run || run.workspaceId !== deps.caller.workspaceId) throw new Error('Run not found');
  return { version: 1, run: compactRun(run) };
}

async function waitAgent(deps: AgentRunToolBridgeDeps, args: Record<string, unknown>, timeoutMs: number) {
  const runId = optionalString(args.runId);
  const watchId = optionalString(args.watchId);
  if ((runId === null) === (watchId === null)) throw new Error('wait_agent requires exactly one runId or watchId');
  if (runId) {
    const current = deps.coordinator.check(deps.caller.ownerUserId, runId);
    if (!current || current.workspaceId !== deps.caller.workspaceId) throw new Error('Run not found');
    const result = await deps.coordinator.wait(deps.caller.ownerUserId, runId, timeoutMs);
    return { version: 1, run: result.run ? compactRun(result.run) : null, resultBundle: compactBundle(result.resultBundle), stillRunning: result.stillRunning };
  }
  return waitForWatch(deps, watchId!, timeoutMs);
}

async function waitForWatch(deps: AgentRunToolBridgeDeps, watchId: string, timeoutMs: number) {
  let watch = deps.repository.getWatch(deps.caller.ownerUserId, watchId);
  if (!watch || watch.workspaceId !== deps.caller.workspaceId) throw new Error('Watch not found');
  // Historical Watches may outlive deleted Runs. Empty membership is inert and
  // must not accidentally satisfy all/any or create a continuation.
  if (watch.runIds.length === 0) return { version: 1, watch, runs: [], stillRunning: false };
  await deps.watches.evaluate(deps.caller.ownerUserId, watchId);
  watch = deps.repository.getWatch(deps.caller.ownerUserId, watchId) ?? watch;
  if (watch.status !== 'active') return watchResult(deps, watch, false);

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; stop(); clearTimeout(timer); resolve(); };
    const stop = deps.coordinator.events.subscribeAll((event) => {
      if (!watch!.runIds.includes(event.runId)) return;
      const changed = deps.coordinator.check(deps.caller.ownerUserId, event.runId);
      if (changed?.status === AgentRunStatus.Failed || changed?.status === AgentRunStatus.Cancelled) { finish(); return; }
      void deps.watches.evaluate(deps.caller.ownerUserId, watchId).then((fired) => { if (fired) finish(); });
    });
    const timer = setTimeout(finish, timeoutMs);
  });
  watch = deps.repository.getWatch(deps.caller.ownerUserId, watchId) ?? watch;
  const runs = watch.runIds.map((id) => deps.coordinator.check(deps.caller.ownerUserId, id)).filter((run): run is AgentRunDtoV1 => !!run);
  const failed = runs.some((run) => run.status === AgentRunStatus.Failed || run.status === AgentRunStatus.Cancelled);
  return { version: 1, watch, runs: runs.map(compactRun), stillRunning: watch.status === 'active' && !failed };
}

async function sendAgentInput(deps: AgentRunToolBridgeDeps, args: Record<string, unknown>, runtimeToolCallId: string | null) {
  const runId = requiredString(args.runId, 'runId');
  const run = ownedRun(deps, runId);
  const invocation = await resolveAgentRunInvocation(deps.caller, deps.activeTurns, runtimeToolCallId);
  const mode = args.mode === 'immediate' ? 'immediate' : 'queued';
  const accepted = await deps.coordinator.input(deps.caller.ownerUserId, runId, {
    version: 1, text: requiredString(args.text, 'text'), mode, expectedAttemptId: optionalString(args.expectedAttemptId) ?? run.activeAttemptId,
  }, invocation.operationId({ tool: 'send_agent_input', runId, text: args.text, mode }));
  return { version: 1, runId, accepted, mode };
}

async function cancelAgent(deps: AgentRunToolBridgeDeps, args: Record<string, unknown>, runtimeToolCallId: string | null) {
  const runId = requiredString(args.runId, 'runId');
  const run = ownedRun(deps, runId);
  const invocation = await resolveAgentRunInvocation(deps.caller, deps.activeTurns, runtimeToolCallId);
  const accepted = await deps.coordinator.cancel(deps.caller.ownerUserId, runId, optionalString(args.reason),
    optionalString(args.expectedAttemptId) ?? run.activeAttemptId,
    invocation.operationId({ tool: 'cancel_agent', runId, reason: args.reason }));
  return { version: 1, runId, accepted };
}

async function createWatch(deps: AgentRunToolBridgeDeps, state: AgentRunToolState,
  args: Record<string, unknown>, runtimeToolCallId: string | null) {
  const runIds = stringArray(args.runIds, 'runIds');
  if (!runIds.length) throw new Error('watch_agent_runs requires at least one Run');
  runIds.forEach((id) => ownedRun(deps, id));
  const invocation = await resolveAgentRunInvocation(deps.caller, deps.activeTurns, runtimeToolCallId);
  const completionMode = args.completionMode === 'wake' ? 'wake' : 'notify';
  const watch = deps.watches.create(deps.caller.ownerUserId, deps.caller.workspaceId, runIds,
    watchCondition(args.condition), completionMode, {
      parentRunId: invocation.anchor.parentRunId,
      parentNodeId: invocation.anchor.parentNodeId,
      parentTurnId: invocation.anchor.parentTurnId,
    }, invocation.operationId({ tool: 'watch_agent_runs', runIds, condition: args.condition, completionMode }));
  armWatch(deps, state, watch.id);
  return { version: 1, watch };
}

function armWatch(deps: AgentRunToolBridgeDeps, state: AgentRunToolState, watchId: string): void {
  if (state.armedWatches.has(watchId)) return;
  const stop = deps.coordinator.events.subscribeAll((event) => {
    const watch = deps.repository.getWatch(deps.caller.ownerUserId, watchId);
    if (!watch || watch.status !== 'active' || watch.runIds.length === 0) {
      stop();
      state.armedWatches.delete(watchId);
      return;
    }
    if (!watch.runIds.includes(event.runId)) return;
    void deps.watches.evaluate(deps.caller.ownerUserId, watchId).then((fired) => {
      if (!fired) return;
      stop();
      state.armedWatches.delete(watchId);
    });
  });
  state.armedWatches.set(watchId, stop);
}

async function updateWatch(deps: AgentRunToolBridgeDeps, args: Record<string, unknown>) {
  const watchId = requiredString(args.watchId, 'watchId');
  const current = deps.repository.getWatch(deps.caller.ownerUserId, watchId);
  if (!current || current.workspaceId !== deps.caller.workspaceId) throw new Error('Watch not found');
  const addRunIds = args.addRunIds === undefined ? [] : stringArray(args.addRunIds, 'addRunIds');
  addRunIds.forEach((id) => ownedRun(deps, id));
  const condition = args.condition === undefined ? undefined : watchCondition(args.condition);
  if (deps.repository.updateWatch) {
    const watch = deps.repository.updateWatch(deps.caller.ownerUserId, watchId, addRunIds, condition);
    if (!watch) throw new Error('active Watch not found');
    return { version: 1, watch };
  }
  if (addRunIds.length) deps.watches.addRuns(deps.caller.ownerUserId, watchId, addRunIds);
  if (condition) {
    const memberCount = new Set([...current.runIds, ...addRunIds]).size;
    if (condition.kind === 'quorum' && condition.count > memberCount) throw new Error('Watch quorum exceeds member count');
    if (!deps.repository.updateWatchCondition?.(deps.caller.ownerUserId, watchId, condition)) {
      throw new Error('active Watch not found');
    }
  }
  return { version: 1, watch: deps.repository.getWatch(deps.caller.ownerUserId, watchId) };
}

function assertRecursiveDelegation(deps: AgentRunToolBridgeDeps, parentRunId: string, parentAttemptId: string): void {
  const parent = ownedRun(deps, parentRunId);
  if (parent.activeAttemptId !== parentAttemptId) throw new Error('Parent Attempt is not the active Attempt');
  const policy = parent.effectiveDefinition.permissionPolicy;
  if (policy.categories[AgentPolicyCategory.SpawnAgent] !== AgentPolicyDecision.Allow) {
    throw new Error('recursive spawn_agent permission denied');
  }
  let depth = 1;
  let cursor = parent;
  const seen = new Set<string>();
  while (cursor.parentRunId) {
    if (seen.has(cursor.id)) throw new Error('invalid recursive delegation cycle');
    seen.add(cursor.id);
    depth += 1;
    const next = deps.coordinator.check(deps.caller.ownerUserId, cursor.parentRunId);
    if (!next) break;
    cursor = next;
  }
  if (depth >= policy.maxDelegationDepth) throw new Error('recursive delegation depth budget exhausted');
  const activeChildren = deps.repository.listRuns(deps.caller.ownerUserId, {
    version: 1, workspaceId: deps.caller.workspaceId, limit: 100,
  }).filter((run) => run.parentRunId === parentRunId && !isTerminalRunStatus(run.status));
  if (activeChildren.length >= policy.maxConcurrentRuns) throw new Error('recursive delegation concurrency budget exhausted');
}

function ownedRun(deps: AgentRunToolBridgeDeps, runId: string): AgentRunDtoV1 {
  const run = deps.coordinator.check(deps.caller.ownerUserId, runId);
  if (!run || run.workspaceId !== deps.caller.workspaceId) throw new Error('Run not found');
  return run;
}

function compactRun(run: AgentRunDtoV1) {
  return {
    id: run.id,
    agent: { name: run.effectiveDefinition.name, definitionId: run.definitionId, definitionRevision: run.definitionRevision },
    task: run.task,
    status: run.status,
    waitingReason: run.waitingReason,
    activeAttemptId: run.activeAttemptId,
    compactHandoff: run.resultBundle ? compactResultHandoff(run.resultBundle) : null,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
  };
}

function compactBundle(bundle: ResultBundleV1 | null) {
  return bundle ? { status: bundle.status, handoff: bundle.handoff, changeSet: bundle.changeSet ?? null } : null;
}

function watchResult(deps: AgentRunToolBridgeDeps, watch: AgentRunWatchDtoV1, stillRunning: boolean) {
  return {
    version: 1,
    watch,
    runs: watch.runIds.map((id) => deps.coordinator.check(deps.caller.ownerUserId, id)).filter((run): run is AgentRunDtoV1 => !!run).map(compactRun),
    stillRunning,
  };
}

function publicRuntimeProfile(profile: AgentDefinitionDtoV1['runtimeProfile']) {
  return { version: 1, runtimeId: profile.runtimeId, providerId: profile.providerId ?? null, modelId: profile.modelId ?? null, reasoning: profile.reasoning ?? null, modeId: profile.modeId ?? null };
}

function emptyContextManifest(): AgentRunContextManifestV1 {
  // The coordinator snapshots this manifest at spawn. Keep the tool payload
  // deterministic so a runtime retry without a native tool-call id reuses the
  // same operation receipt.
  return { version: 1, entries: [], assembledAt: 0, estimatedChars: 0 };
}

function completionMode(value: unknown): AgentRunCompletionMode {
  if (value === 'notify') return AgentRunCompletionMode.Notify;
  if (value === 'wake') return AgentRunCompletionMode.Wake;
  if (value === 'detach') return AgentRunCompletionMode.Detach;
  return AgentRunCompletionMode.Wait;
}

function watchCondition(value: unknown): WatchConditionV1 {
  const raw = objectOrNull(value) ?? { kind: 'all' };
  const kind = raw.kind;
  if (kind === 'quorum') return { version: 1, kind, count: requiredInteger(raw.count, 'condition.count', 1) };
  if (kind === 'deadline') return { version: 1, kind, at: requiredInteger(raw.at, 'condition.at', 0) };
  if (kind === 'all' || kind === 'any' || kind === 'manual') return { version: 1, kind };
  throw new Error('unsupported Watch condition');
}

function boundedTimeout(value: unknown, max: number): number {
  if (value === undefined) return Math.min(30_000, max);
  return Math.min(requiredInteger(value, 'timeoutMs', 0), max);
}

function requiredInteger(value: unknown, name: string, min: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) throw new Error(`${name} must be an integer >= ${min}`);
  return value as number;
}

function requiredString(value: unknown, name: string): string {
  const result = optionalString(value);
  if (!result) throw new Error(`${name} is required`);
  return result;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : requiredInteger(value, 'runTtlMs', 0);
}

function objectOrNull(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) throw new Error(`${name} must be an array of strings`);
  return [...new Set(value.map((item) => item.trim()))];
}
