import { randomUUID } from 'node:crypto';
import {
  AgentDefinitionStatus,
  AgentRunCompletionMode,
  AgentRunEventType,
  AgentRunStatus,
  type AgentRunInputRequestV1,
  type AgentRunDtoV1,
  type JsonValue,
  type EffectiveAgentDefinitionV1,
  type ResultBundleV1,
  type RuntimeProfileV1,
  type StructuredRunErrorV1,
} from 'michi-shared';
import { AgentRunEventBus } from './agentRunEventBus';
import { AgentRunInteractions } from './agentRunInteractions';
import { intersectPermissionPolicies } from './effectivePermissionPolicy';
import { deriveParentPermissionSnapshot, type ParentPermissionPort } from './parentPermissionSnapshot';
import { normalizeContextManifest } from './contextManifest';
import { normalizeResultBundle } from './resultBundle';
import { deriveRunExpiresAt } from './agentRunRetention';
import { isTerminalRunStatus } from './agentRunStateMachine';
import { planAgentRunRecovery } from './agentRunRecovery';
import type {
  AgentRunCoordinatorPorts,
  AgentRunExecutionOutcome,
  AgentRunHandle,
  PreparedExecutionEnvironment,
  SpawnCoordinatedRunInput,
} from './ports';
import { systemAgentRunClock } from './ports';

interface LiveAttempt {
  ownerUserId: string;
  leaseToken: string;
  attemptId: string;
  handle: AgentRunHandle;
  environment: PreparedExecutionEnvironment;
  profileIndex: number;
  recoveryEnvelope: Parameters<typeof planAgentRunRecovery>[0]['recoveryEnvelope'];
}

interface PreparedResource {
  environment: PreparedExecutionEnvironment;
  cleanupOwnerId: string;
}

export class AgentRunCoordinator {
  readonly events = new AgentRunEventBus();
  readonly interactions: AgentRunInteractions;
  private readonly clock;
  private readonly nextId;
  private readonly leaseDurationMs;
  private readonly live = new Map<string, LiveAttempt>();
  private readonly prepared = new Map<string, PreparedResource>();
  private readonly quiescing = new Set<string>();
  private readonly administrativeQuiescing = new Set<string>();

  constructor(private readonly ports: AgentRunCoordinatorPorts) {
    this.clock = ports.clock ?? systemAgentRunClock;
    this.nextId = ports.nextId ?? ((kind: 'lease' | 'operation') => `${kind}-${randomUUID()}`);
    this.leaseDurationMs = ports.leaseDurationMs ?? 30_000;
    this.interactions = new AgentRunInteractions(ports.repository, this.events);
  }

  async spawn(input: SpawnCoordinatedRunInput): Promise<AgentRunDtoV1> {
    if ((input.definitionId === null) === (input.ephemeralDefinition === null)) {
      throw new Error('spawn requires exactly one saved or ephemeral Agent definition');
    }
    const workspace = this.ports.workspaces.resolve(input.ownerUserId, input.workspaceId);
    const resolved = this.resolveEffectiveDefinition(input, workspace.permissionPolicy);
    const manifest = normalizeContextManifest(await this.ports.contexts.snapshot({
      ownerUserId: input.ownerUserId,
      workspaceId: input.workspaceId,
      runOperationId: input.operationId,
      manifest: input.contextManifest,
    }));
    let environment: PreparedExecutionEnvironment | null = null;
    try {
      environment = await this.ports.environments.prepare({
        // T03 currently mints the final Run id inside createRun. The stable
        // operation id owns pre-create resources until repository support for
        // caller-allocated Run ids is added.
        runId: input.operationId,
        workspaceId: input.workspaceId,
        workspaceCwd: workspace.cwd,
        request: input.environment,
        permissionPolicy: resolved.effective.permissionPolicy,
      });
      const expiresAt = deriveRunExpiresAt({
        now: this.clock.now(), invocationMode: input.invocationMode,
        requestedTtlMs: input.runTtlMs, definitionDefaultTtlMs: resolved.defaultRunTtlMs,
        platformMaxTtlMs: this.ports.maxRunTtlMs,
      });
      const run = this.ports.repository.createRun({
        operationId: input.operationId, ownerUserId: input.ownerUserId,
        workspaceId: input.workspaceId, definitionId: resolved.definitionId,
        definitionRevision: resolved.definitionRevision, effectiveDefinition: resolved.effective,
        invocationMode: input.invocationMode, completionMode: input.completionMode,
        parentRunId: input.parentRunId, parentAttemptId: input.parentAttemptId, parentNodeId: input.parentNodeId,
        parentTurnId: input.parentTurnId, parentMessageId: input.parentMessageId,
        parentToolCallId: input.parentToolCallId, task: input.task,
        contextManifest: manifest, expectedResult: input.expectedResult,
        executionEnvironment: environment.snapshot, expiresAt,
        initialEvent: {
          type: AgentRunEventType.RunStatusChanged,
          payload: { version: 1, from: null, to: AgentRunStatus.Queued },
        },
      });
      this.prepared.set(run.id, { environment, cleanupOwnerId: input.operationId });
      return run;
    } catch (error) {
      if (environment) await environment.cleanup(input.operationId).catch(() => undefined);
      await this.ports.contexts.cleanup(input.operationId).catch(() => undefined);
      throw error;
    }
  }

  private resolveEffectiveDefinition(input: SpawnCoordinatedRunInput,
    workspacePolicy: EffectiveAgentDefinitionV1['permissionPolicy']): {
      effective: EffectiveAgentDefinitionV1; definitionId: string | null;
      definitionRevision: number | null; defaultRunTtlMs: number | null;
    } {
    const parentSnapshot = deriveParentPermissionSnapshot({
      invocationMode: input.invocationMode,
      ownerUserId: input.ownerUserId,
      workspaceId: input.workspaceId,
      parentRunId: input.parentRunId,
      parentAttemptId: input.parentAttemptId,
      parentNodeId: input.parentNodeId,
      workspacePolicy,
    }, this.ports.parentPermissions ?? fallbackParentPermissionPort(this.ports.repository));
    if (input.definitionId) {
      const definition = this.ports.definitions.get(input.ownerUserId, input.definitionId);
      if (!definition || definition.status !== AgentDefinitionStatus.Enabled
        || (definition.workspaceId !== null && definition.workspaceId !== input.workspaceId)) {
        throw new Error('enabled Agent Definition not found');
      }
      this.ports.capabilities.assertRuntimeReady(definition.runtimeProfile.runtimeId);
      const capabilitySnapshot = this.ports.capabilities.resolve({
        ownerUserId: input.ownerUserId, workspaceId: input.workspaceId,
        definitionScope: definition.scope, toolRefs: definition.toolRefs,
        skillRefs: definition.skillRefs, mcpServerRefs: definition.mcpServerRefs,
      });
      return {
        definitionId: definition.id, definitionRevision: definition.revision,
        defaultRunTtlMs: definition.defaultRunTtlMs,
        effective: {
          version: 1, name: definition.name, description: definition.description,
          instructions: definition.instructions, runtimeProfile: definition.runtimeProfile,
          fallbackChain: definition.fallbackChain, capabilitySnapshot,
          permissionPolicy: intersectPermissionPolicies({
            platform: this.ports.platformPermissionPolicy, workspace: workspacePolicy,
            parent: parentSnapshot.policy, definition: definition.permissionPolicy,
            spawn: input.permissionRestriction,
          }),
          contextPolicy: definition.contextPolicy,
        },
      };
    }
    const ephemeral = input.ephemeralDefinition!;
    this.ports.capabilities.assertRuntimeReady(ephemeral.runtimeProfile.runtimeId);
    return {
      definitionId: null, definitionRevision: null, defaultRunTtlMs: null,
      effective: {
        ...ephemeral,
        capabilitySnapshot: { version: 1, entries: ephemeral.capabilitySnapshot.entries.map((entry) => ({ ...entry })) },
        permissionPolicy: intersectPermissionPolicies({
          platform: this.ports.platformPermissionPolicy, workspace: workspacePolicy,
          parent: parentSnapshot.policy, definition: ephemeral.permissionPolicy,
          spawn: input.permissionRestriction,
        }),
      },
    };
  }

  async start(ownerUserId: string, runId: string): Promise<AgentRunDtoV1 | null> {
    const initial = this.ports.repository.getRun(ownerUserId, runId);
    if (!initial || isTerminalRunStatus(initial.status) || initial.status === AgentRunStatus.Waiting) return initial;
    const recovery = initial.status === AgentRunStatus.Recovering
      ? this.ports.repository.getLatestAttemptRecovery?.(ownerUserId, runId) ?? null
      : null;
    const leaseToken = this.nextId('lease');
    const claimed = this.ports.repository.claimRun(ownerUserId, runId, this.ports.instanceId,
      leaseToken, this.clock.now() + this.leaseDurationMs, initial.latestEventSeq);
    if (!claimed) return null;
    this.events.publishCommitted(claimed);
    return this.executeClaimed(ownerUserId, runId, leaseToken,
      recovery?.profileIndex ?? 0, recovery?.recoveryEnvelope ?? null, recovery?.nativeResumeToken ?? null);
  }

  private async executeClaimed(ownerUserId: string, runId: string, leaseToken: string,
    profileIndex: number, recoveryEnvelope: Parameters<typeof planAgentRunRecovery>[0]['recoveryEnvelope'],
    nativeResumeToken: JsonValue | null = null): Promise<AgentRunDtoV1> {
    let run = this.requireRun(ownerUserId, runId);
    const profile = runtimeProfileAt(run, profileIndex);
    const attempt = this.ports.repository.createAttempt({
      operationId: `${runId}:attempt:${this.nextId('operation')}`,
      ownerUserId, runId, profileIndex, runtimeProfile: profile,
      publicSessionId: this.nextId('operation'), recoveryEnvelope,
    });
    try {
      this.ports.capabilities.validateBindings?.(ownerUserId, run.workspaceId, run.effectiveDefinition.capabilitySnapshot);
    } catch (error) {
      return this.finalize(ownerUserId, run, attempt.id, leaseToken, 'failed', AgentRunStatus.Failed, null, {
        version: 1, code: 'capability_binding_unavailable', category: 'auth_permission',
        message: error instanceof Error ? error.message : String(error), retryable: false,
      });
    }
    const environment = this.prepared.get(runId)?.environment ?? environmentLeaseFromSnapshot(run);
    const emit = async (runtimeEvent: Parameters<AgentRunCoordinatorPorts['executor']['start']>[1] extends (event: infer E) => any ? E : never) => {
      const current = this.requireRun(ownerUserId, runId);
      if (runtimeEvent.nativeResumeToken !== undefined) {
        this.ports.repository.checkpointAttempt(ownerUserId, runId, attempt.id, leaseToken, runtimeEvent.nativeResumeToken ?? null);
      }
      const committed = this.ports.repository.appendEventAndProject(ownerUserId, runId, current.latestEventSeq, {
        type: runtimeEvent.type, payload: runtimeEvent.payload, attemptId: attempt.id,
      });
      this.events.publishCommitted(committed);
    };
    const spec = {
      runId, attemptId: attempt.id, workspaceId: run.workspaceId, ownerUserId,
      task: run.task, effectiveDefinition: run.effectiveDefinition,
      contextManifest: run.contextManifest, expectedResult: run.expectedResult,
      executionEnvironment: run.executionEnvironment, recoveryEnvelope,
    };
    const handle = nativeResumeToken === null
      ? await this.ports.executor.start(spec, emit)
      : await this.ports.executor.resume(spec, nativeResumeToken, emit);
    const live: LiveAttempt = {
      ownerUserId,
      leaseToken,
      attemptId: attempt.id,
      handle,
      environment,
      profileIndex,
      recoveryEnvelope,
    };
    run = this.requireRun(ownerUserId, runId);
    const runningEvent = this.ports.repository.appendEventAndProject(ownerUserId, runId, run.latestEventSeq, {
      type: AgentRunEventType.RunStatusChanged, attemptId: attempt.id,
      payload: { version: 1, from: run.status, to: AgentRunStatus.Running },
    }, { status: AgentRunStatus.Running, activeAttemptId: attempt.id, startedAt: run.startedAt ?? this.clock.now() });
    this.live.set(runId, live);
    this.events.publishCommitted(runningEvent);
    const outcome = await handle.completion;
    return this.settleOutcome(runId, outcome, profileIndex, recoveryEnvelope, ownerUserId);
  }

  private async settleOutcome(runId: string, outcome: AgentRunExecutionOutcome, profileIndex: number,
    recoveryEnvelope: Parameters<typeof planAgentRunRecovery>[0]['recoveryEnvelope'],
    quiescedOwnerUserId?: string): Promise<AgentRunDtoV1> {
    const live = this.live.get(runId);
    if (!live) {
      if (quiescedOwnerUserId) return this.requireRun(quiescedOwnerUserId, runId);
      throw new Error('Run handle disappeared');
    }
    const { ownerUserId, leaseToken, attemptId } = live;
    if (this.administrativeQuiescing.has(runId)) return this.requireRun(ownerUserId, runId);
    let run = this.requireRun(ownerUserId, runId);
    if (this.quiescing.has(runId)) return this.checkpointForShutdown(runId, live);
    if (outcome.status === 'waiting') {
      this.interactions.request(ownerUserId, runId, attemptId, outcome.kind, outcome.request,
        `${runId}:interaction:${this.nextId('operation')}`);
      return this.requireRun(ownerUserId, runId);
    }
    this.live.delete(runId);
    if (outcome.status === 'completed') {
      const bundle = normalizeResultBundle(outcome.resultBundle);
      return this.finalize(ownerUserId, run, attemptId, leaseToken, 'completed', AgentRunStatus.Completed, bundle, null);
    }
    if (outcome.status === 'cancelled') {
      return this.finalize(ownerUserId, run, attemptId, leaseToken, 'cancelled', AgentRunStatus.Cancelled, null,
        outcome.error ?? structuredError('cancelled', 'Run was cancelled', false));
    }
    const attempts = this.ports.repository.listAttempts(ownerUserId, runId);
    const plan = planAgentRunRecovery({ run, attempts, error: outcome.error, recoveryEnvelope: outcome.recoveryEnvelope ?? recoveryEnvelope });
    if (plan.action === 'fail') {
      return this.finalize(ownerUserId, run, attemptId, leaseToken, 'failed', AgentRunStatus.Failed, null, outcome.error);
    }
    const recoveryEvent = this.ports.repository.finishAttemptForRecovery(ownerUserId, runId, attemptId,
      leaseToken, outcome.error, run.latestEventSeq, plan.recoveryEnvelope);
    this.events.publishCommitted(recoveryEvent);
    if (plan.action === 'wait') {
      this.interactions.request(ownerUserId, runId, attemptId, 'user_input', {
        version: 1, reason: 'unsafe_recovery', message: outcome.error.message,
      }, `${runId}:unsafe-recovery:${this.nextId('operation')}`);
      return this.requireRun(ownerUserId, runId);
    }
    run = this.requireRun(ownerUserId, runId);
    const nextLease = this.nextId('lease');
    const claim = this.ports.repository.claimRun(ownerUserId, runId, this.ports.instanceId,
      nextLease, this.clock.now() + this.leaseDurationMs, run.latestEventSeq);
    if (!claim) return this.requireRun(ownerUserId, runId);
    this.events.publishCommitted(claim);
    return this.executeClaimed(ownerUserId, runId, nextLease, plan.profileIndex, plan.recoveryEnvelope);
  }

  private finalize(ownerUserId: string, run: AgentRunDtoV1, attemptId: string, leaseToken: string,
    attemptStatus: 'completed' | 'failed' | 'cancelled', runStatus: AgentRunStatus.Completed | AgentRunStatus.Failed | AgentRunStatus.Cancelled,
    bundle: ResultBundleV1 | null, error: StructuredRunErrorV1 | null): AgentRunDtoV1 {
    const finalized = this.ports.repository.finalizeAttempt(ownerUserId, run.id, attemptId, leaseToken,
      attemptStatus, runStatus, bundle, error, run.latestEventSeq, {
        type: AgentRunEventType.RunStatusChanged,
        payload: { version: 1, from: run.status, to: runStatus },
      });
    const committed = this.ports.repository.listEvents(ownerUserId, run.id, run.latestEventSeq, 1)[0];
    if (committed) this.events.publishCommitted(committed);
    if (finalized.completionMode === AgentRunCompletionMode.Notify) {
      void this.ports.notifier.notify(ownerUserId, finalized);
    }
    return finalized;
  }

  check(ownerUserId: string, runId: string): AgentRunDtoV1 | null {
    return this.ports.repository.getRun(ownerUserId, runId);
  }

  async wait(ownerUserId: string, runId: string, timeoutMs: number): Promise<{
    run: AgentRunDtoV1 | null; resultBundle: ResultBundleV1 | null; stillRunning: boolean;
  }> {
    let run = this.ports.repository.getRun(ownerUserId, runId);
    if (!run || isTerminalRunStatus(run.status)) return { run, resultBundle: run?.resultBundle ?? null, stillRunning: false };
    await this.events.waitForEvent(runId, run.latestEventSeq, timeoutMs, this.clock);
    run = this.ports.repository.getRun(ownerUserId, runId);
    return { run, resultBundle: run?.resultBundle ?? null, stillRunning: !!run && !isTerminalRunStatus(run.status) };
  }

  async input(ownerUserId: string, runId: string, request: AgentRunInputRequestV1, operationId: string): Promise<boolean> {
    const run = this.ports.repository.getRun(ownerUserId, runId);
    if (!run) return false;
    const live = this.live.get(runId);
    if (!live || live.ownerUserId !== ownerUserId) throw new Error('live Run not found');
    if (request.expectedAttemptId && request.expectedAttemptId !== live.attemptId) throw new Error('expected Attempt does not match the active Attempt');
    const pending = this.ports.repository.listInteractions?.(ownerUserId, runId)
      .filter((interaction) => interaction.status === 'pending').at(-1);
    let current = this.requireRun(ownerUserId, runId);
    const queued = this.ports.repository.appendEventAndProject(ownerUserId, runId, current.latestEventSeq, {
      type: AgentRunEventType.SteeringQueued, attemptId: live.attemptId,
      payload: { version: 1, operationId, mode: request.mode, text: request.text },
    });
    this.events.publishCommitted(queued);
    await live.handle.input(request.text, request.mode);
    if (pending) this.interactions.resolve(ownerUserId, pending.id,
      { version: 1, text: request.text }, `${operationId}:interaction`);
    current = this.requireRun(ownerUserId, runId);
    const applied = this.ports.repository.appendEventAndProject(ownerUserId, runId, current.latestEventSeq, {
      type: AgentRunEventType.SteeringApplied, attemptId: live.attemptId,
      payload: { version: 1, operationId, mode: request.mode },
    });
    this.events.publishCommitted(applied);
    if (pending) this.continueLiveAttempt(runId, live);
    return true;
  }

  async respondInteraction(ownerUserId: string, runId: string, interactionId: string,
    response: JsonValue, operationId: string) {
    const interaction = this.ports.repository.getInteraction(ownerUserId, interactionId);
    if (!interaction || interaction.runId !== runId) return null;
    const live = this.live.get(runId);
    if (!live || live.ownerUserId !== ownerUserId) throw new Error('live Run not found; interaction remains waiting');
    await live.handle.input(interactionResponseText(response), 'queued');
    const resolved = this.interactions.resolve(ownerUserId, interactionId, response, operationId);
    if (!resolved) return null;
    this.continueLiveAttempt(runId, live);
    return resolved;
  }

  heartbeatAll(): number {
    let renewed = 0;
    for (const [runId, live] of this.live) {
      if (this.ports.repository.heartbeat(live.ownerUserId, runId, live.leaseToken,
        this.clock.now() + this.leaseDurationMs)) renewed += 1;
    }
    return renewed;
  }

  async shutdown(): Promise<void> {
    const attempts = [...this.live.entries()];
    await Promise.allSettled(attempts.map(async ([runId, live]) => {
      this.quiescing.add(runId);
      void Promise.resolve().then(() => live.handle.cancel('backend_shutdown')).catch(() => undefined);
      await this.checkpointForShutdown(runId, live);
    }));
  }

  private async checkpointForShutdown(runId: string, live: LiveAttempt): Promise<AgentRunDtoV1> {
    try {
      const current = this.ports.repository.getRun(live.ownerUserId, runId);
      if (!current || isTerminalRunStatus(current.status) || current.status === AgentRunStatus.Recovering) {
        return current ?? this.requireRun(live.ownerUserId, runId);
      }
      const event = this.ports.repository.finishAttemptForRecovery(
        live.ownerUserId, runId, live.attemptId, live.leaseToken, {
          version: 1,
          code: 'backend_shutdown',
          category: 'transient',
          message: 'Backend shut down after checkpointing the active Attempt',
          retryable: true,
        }, current.latestEventSeq,
      );
      this.events.publishCommitted(event);
    } catch {
      this.ports.repository.releaseLease(live.ownerUserId, runId, live.leaseToken);
    } finally {
      this.live.delete(runId);
      this.quiescing.delete(runId);
    }
    return this.requireRun(live.ownerUserId, runId);
  }

  private continueLiveAttempt(runId: string, live: LiveAttempt): void {
    if (!live.handle.continueAfterInput) return;
    void live.handle.continueAfterInput()
      .then((outcome) => this.settleOutcome(runId, outcome, live.profileIndex, live.recoveryEnvelope, live.ownerUserId))
      .catch(() => undefined);
  }

  async cancel(ownerUserId: string, runId: string, reason: string | null,
    expectedAttemptId: string | null = null, operationId = this.nextId('operation')): Promise<boolean> {
    let run = this.ports.repository.getRun(ownerUserId, runId);
    if (!run) return false;
    if (isTerminalRunStatus(run.status)) return true;
    const live = this.live.get(runId);
    const activeAttemptId = live?.attemptId ?? run.activeAttemptId;
    if (expectedAttemptId && expectedAttemptId !== activeAttemptId) throw new Error('expected Attempt does not match the active Attempt');
    const duplicate = this.ports.repository.listEvents(ownerUserId, runId, -1, 1_000)
      .some((event) => event.type === AgentRunEventType.CancellationRequested
        && typeof event.payload === 'object' && event.payload !== null && !Array.isArray(event.payload)
        && event.payload.operationId === operationId);
    if (duplicate) return true;
    const requested = this.ports.repository.appendEventAndProject(ownerUserId, runId, run.latestEventSeq, {
      type: AgentRunEventType.CancellationRequested, attemptId: activeAttemptId,
      payload: { version: 1, operationId, reason },
    });
    this.events.publishCommitted(requested);
    if (live && live.ownerUserId === ownerUserId) {
      await live.handle.cancel(reason);
      return true;
    }
    run = this.requireRun(ownerUserId, runId);
    if (run.status === AgentRunStatus.Queued) {
      const settled = this.ports.repository.appendEventAndProject(ownerUserId, runId, run.latestEventSeq, {
        type: AgentRunEventType.RunStatusChanged,
        payload: { version: 1, from: AgentRunStatus.Queued, to: AgentRunStatus.Cancelled },
      }, { status: AgentRunStatus.Cancelled, completedAt: this.clock.now() });
      this.events.publishCommitted(settled);
    }
    return true;
  }

  /** Quiesce one Run for destructive owner administration.
   *
   * Local live handles are cancelled before their lease-backed Attempt is
   * terminalized. A Run owned by another live instance is deliberately left
   * untouched: the repository rejects administrative cancellation until that
   * durable lease expires, so the caller can abort the user deletion safely.
   */
  async quiesceForAdministrativeDeletion(ownerUserId: string, runId: string): Promise<void> {
    const run = this.ports.repository.getRun(ownerUserId, runId);
    if (!run) return;
    const live = this.live.get(runId);
    if (live && live.ownerUserId === ownerUserId) {
      this.administrativeQuiescing.add(runId);
      try {
        await withTimeout(
          live.handle.cancel('administrative owner deletion'),
          5_000,
          'Run runtime did not acknowledge administrative cancellation',
        );
        const event = this.ports.repository.administrativelyCancelRun(
          ownerUserId,
          runId,
          live.leaseToken,
          'Run cancelled because its owner is being deleted',
        );
        this.live.delete(runId);
        this.quiescing.delete(runId);
        if (event) this.events.publishCommitted(event);
        return;
      } finally {
        this.administrativeQuiescing.delete(runId);
      }
    }
    const event = this.ports.repository.administrativelyCancelRun(
      ownerUserId,
      runId,
      null,
      'Run cancelled because its owner is being deleted',
    );
    if (event) this.events.publishCommitted(event);
  }

  heartbeat(ownerUserId: string, runId: string): boolean {
    const live = this.live.get(runId);
    return !!live && live.ownerUserId === ownerUserId
      && this.ports.repository.heartbeat(ownerUserId, runId, live.leaseToken, this.clock.now() + this.leaseDurationMs);
  }

  private requireRun(ownerUserId: string, runId: string): AgentRunDtoV1 {
    const run = this.ports.repository.getRun(ownerUserId, runId);
    if (!run) throw new Error('run not found');
    return run;
  }
}

function runtimeProfileAt(run: AgentRunDtoV1, profileIndex: number): RuntimeProfileV1 {
  if (profileIndex === 0) return run.effectiveDefinition.runtimeProfile;
  const profile = run.effectiveDefinition.fallbackChain[profileIndex - 1];
  if (!profile) throw new Error(`fallback profile ${profileIndex} is unavailable`);
  return profile;
}

function structuredError(code: string, message: string, retryable: boolean): StructuredRunErrorV1 {
  return { version: 1, code, category: 'terminal', message, retryable };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function interactionResponseText(response: JsonValue): string {
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object' && !Array.isArray(response)
    && typeof response.text === 'string') return response.text;
  return JSON.stringify(response);
}

function environmentLeaseFromSnapshot(run: AgentRunDtoV1): PreparedExecutionEnvironment {
  return {
    leaseId: `snapshot:${run.id}`, ownerRunId: run.id,
    access: run.executionEnvironment.kind === 'git_worktree' ? 'read_write' : 'read_only',
    snapshot: run.executionEnvironment,
    provenance: { version: 1, sourceRepositoryRoot: null, baseCommit: run.executionEnvironment.baseCommit ?? null,
      stagedPatchHash: null, unstagedPatchHash: null, untrackedFiles: [], skippedSensitivePaths: [] },
    async buildChangeSet() { return null; }, async cleanup() { return { removed: false }; },
  };
}

/**
 * Backward-compatible fallback: derives a minimal ParentPermissionPort from
 * the repository. Used when the explicit `parentPermissions` port is not
 * injected into the coordinator. This keeps existing spawn APIs working
 * without requiring callers to provide the new port immediately.
 */
function fallbackParentPermissionPort(repository: AgentRunCoordinatorPorts['repository']): ParentPermissionPort {
  return {
    getRunEffectivePolicy(ownerUserId: string, parentRunId: string) {
      const run = repository.getRun(ownerUserId, parentRunId);
      return run?.effectiveDefinition.permissionPolicy ?? null;
    },
  };
}
