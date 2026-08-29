import type {
  AgentAttemptStatus,
  AgentDefinitionDtoV1,
  AgentInteractionKind,
  AgentInteractionStatus,
  AgentPermissionPolicyV1,
  AgentRunCompletionMode,
  AgentRunContextManifestV1,
  AgentRunDtoV1,
  AgentRunEventType,
  AgentRunEventV1,
  AgentRunInteractionDtoV1,
  AgentRunListQueryV1,
  AgentRunWatchDtoV1,
  EffectiveAgentDefinitionV1,
  EffectiveCapabilitySnapshotV1,
  ExecutionEnvironmentRequestV1,
  ExpectedResultContractV1,
  JsonValue,
  RecoveryEnvelopeV1,
  ResultBundleV1,
  RuntimeProfileV1,
  StructuredRunErrorV1,
  WatchConditionV1,
} from 'michi-shared';
import type {
  AgentRunProjectionPatch,
  CreateAgentRunInput,
  CreateAttemptInput,
} from '../../services/agentRunsRepository';
import type {
  ExecutionEnvironmentLease,
  ExecutionEnvironmentProvider,
} from './executionEnvironment';
import type { ParentPermissionPort } from './parentPermissionSnapshot';

export interface AgentRunClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemAgentRunClock: AgentRunClock = {
  now: Date.now,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface AgentRunRepositoryPort {
  createRun(input: CreateAgentRunInput): AgentRunDtoV1;
  getRun(ownerUserId: string, runId: string): AgentRunDtoV1 | null;
  listRuns(ownerUserId: string, query: AgentRunListQueryV1): AgentRunDtoV1[];
  listAttempts(ownerUserId: string, runId: string): Array<{ id: string; attemptIndex: number; profileIndex: number; status: AgentAttemptStatus }>;
  /** Private recovery metadata. Native resume tokens must never be exposed by
   * the public Attempt DTO/list APIs. */
  getLatestAttemptRecovery?(ownerUserId: string, runId: string): {
    attemptId: string;
    profileIndex: number;
    recoveryEnvelope: RecoveryEnvelopeV1 | null;
    nativeResumeToken: JsonValue | null;
  } | null;
  listEvents(ownerUserId: string, runId: string, afterSeq?: number, limit?: number): AgentRunEventV1[];
  claimRun(ownerUserId: string, runId: string, leaseOwner: string, leaseToken: string,
    leaseExpiresAt: number, expectedLatestSeq: number): AgentRunEventV1 | null;
  heartbeat(ownerUserId: string, runId: string, leaseToken: string, leaseExpiresAt: number): boolean;
  createAttempt(input: CreateAttemptInput): { id: string; attemptIndex: number };
  checkpointAttempt(ownerUserId: string, runId: string, attemptId: string, leaseToken: string,
    nativeResumeToken: JsonValue | null): boolean;
  appendEventAndProject(ownerUserId: string, runId: string, expectedLatestSeq: number,
    event: { type: AgentRunEventType; payload: JsonValue; attemptId?: string | null },
    patch?: AgentRunProjectionPatch): AgentRunEventV1;
  finalizeAttempt(ownerUserId: string, runId: string, attemptId: string, leaseToken: string,
    attemptStatus: Extract<AgentAttemptStatus, 'completed' | 'failed' | 'cancelled'>,
    runStatus: AgentRunDtoV1['status'], resultBundle: ResultBundleV1 | null,
    error: StructuredRunErrorV1 | null, expectedLatestSeq: number,
    event: { type: AgentRunEventType; payload: JsonValue }): AgentRunDtoV1;
  /** Required for fallback: terminalize the old Attempt and atomically return
   * the Run to recovering without making the Run terminal. */
  finishAttemptForRecovery(ownerUserId: string, runId: string, attemptId: string,
    leaseToken: string, error: StructuredRunErrorV1, expectedLatestSeq: number,
    recoveryEnvelope?: RecoveryEnvelopeV1 | null): AgentRunEventV1;
  releaseLease(ownerUserId: string, runId: string, leaseToken: string): boolean;
  /** Administrative terminalization. A null lease token is accepted only
   * when no live lease exists (or the durable lease already expired). */
  administrativelyCancelRun(ownerUserId: string, runId: string,
    leaseToken: string | null, reason: string): AgentRunEventV1 | null;
  createInteraction(ownerUserId: string, runId: string, attemptId: string | null,
    kind: AgentInteractionKind, request: JsonValue, operationId: string): AgentRunInteractionDtoV1;
  getInteraction(ownerUserId: string, interactionId: string): AgentRunInteractionDtoV1 | null;
  listInteractions?(ownerUserId: string, runId: string): AgentRunInteractionDtoV1[];
  resolveInteraction(ownerUserId: string, interactionId: string,
    status: Exclude<AgentInteractionStatus, 'pending'>, response: JsonValue,
    operationId: string): AgentRunInteractionDtoV1 | null;
  createWatch(ownerUserId: string, workspaceId: string, runIds: readonly string[],
    condition: WatchConditionV1, completionMode: 'notify' | 'wake',
    parent: { parentRunId: string | null; parentNodeId: string | null; parentTurnId: string | null },
    operationId: string): AgentRunWatchDtoV1;
  getWatch(ownerUserId: string, watchId: string): AgentRunWatchDtoV1 | null;
  /** Startup-only cross-owner scans. Results are ordered by Watch id so the
   * caller can recover in bounded pages without loading the full table. */
  listActiveWatchesForRecovery(afterId?: string | null, limit?: number): AgentRunWatchDtoV1[];
  listFiredWatchesPendingDelivery(afterId?: string | null, limit?: number): AgentRunWatchDtoV1[];
  addWatchMembers(ownerUserId: string, watchId: string, runIds: readonly string[]): number;
  updateWatchCondition?(ownerUserId: string, watchId: string, condition: WatchConditionV1): boolean;
  fireWatch(ownerUserId: string, watchId: string): boolean;
  markWatchDelivery(ownerUserId: string, watchId: string,
    status: 'pending' | 'delivered' | 'undeliverable'): boolean;
  listTtlCandidates(ownerUserId: string, workspaceId: string, now: number, limit?: number): AgentRunDtoV1[];
  archiveRun(ownerUserId: string, runId: string, archivedAt?: number): boolean;
  deleteRun(ownerUserId: string, runId: string): boolean;
}

export interface AgentDefinitionSource {
  get(ownerUserId: string, definitionId: string): AgentDefinitionDtoV1 | null;
}

export interface AgentCapabilityResolver {
  assertRuntimeReady(runtimeId: string): void;
  resolve(input: {
    ownerUserId: string;
    workspaceId: string | null;
    definitionScope: 'global' | 'workspace';
    toolRefs: readonly string[];
    skillRefs: readonly string[];
    mcpServerRefs: readonly string[];
  }): EffectiveCapabilitySnapshotV1;
  validateBindings?(ownerUserId: string, workspaceId: string,
    snapshot: EffectiveCapabilitySnapshotV1): void;
}

export interface RunContextSnapshotStore {
  snapshot(input: {
    ownerUserId: string;
    workspaceId: string;
    runOperationId: string;
    manifest: AgentRunContextManifestV1;
  }): Promise<AgentRunContextManifestV1>;
  cleanup(runId: string): Promise<void>;
}

export interface AgentRunSpec {
  runId: string;
  attemptId: string;
  workspaceId: string;
  ownerUserId: string;
  task: string;
  effectiveDefinition: EffectiveAgentDefinitionV1;
  contextManifest: AgentRunContextManifestV1;
  expectedResult: ExpectedResultContractV1 | null;
  executionEnvironment: AgentRunDtoV1['executionEnvironment'];
  recoveryEnvelope: RecoveryEnvelopeV1 | null;
}

export interface AgentRunExecutionEvent {
  type: AgentRunEventType;
  payload: JsonValue;
  nativeResumeToken?: JsonValue | null;
}

export type AgentRunExecutionOutcome =
  | { status: 'completed'; resultBundle: ResultBundleV1 }
  | { status: 'failed'; error: StructuredRunErrorV1; recoveryEnvelope: RecoveryEnvelopeV1 | null }
  | { status: 'cancelled'; error?: StructuredRunErrorV1 }
  | { status: 'waiting'; kind: AgentInteractionKind; request: JsonValue };

export interface AgentRunHandle {
  completion: Promise<AgentRunExecutionOutcome>;
  /** Present for runtimes whose stream pauses on a durable interaction and
   * continues after input on the same Attempt/session. */
  continueAfterInput?(): Promise<AgentRunExecutionOutcome>;
  input(text: string, mode?: 'queued' | 'immediate'): Promise<void>;
  cancel(reason: string | null): Promise<void>;
}

export interface AgentRunExecutor {
  start(spec: AgentRunSpec, emit: (event: AgentRunExecutionEvent) => Promise<void>): Promise<AgentRunHandle>;
  resume(spec: AgentRunSpec, nativeResumeToken: JsonValue,
    emit: (event: AgentRunExecutionEvent) => Promise<void>): Promise<AgentRunHandle>;
}

export interface AgentRunNotifier {
  notify(ownerUserId: string, run: AgentRunDtoV1): Promise<void>;
}

export interface ParentContinuationSink {
  deliver(input: {
    deliveryId: string;
    requestedTurnId: string;
    ownerUserId: string;
    workspaceId: string;
    parentRunId: string | null;
    parentNodeId: string | null;
    parentTurnId: string | null;
    runIds: string[];
    handoff: string;
  }): Promise<'delivered' | 'undeliverable'>;
}

export interface AgentRunResourceCleaner {
  cleanup(runId: string): Promise<void>;
  cleanupResources?(runId: string, resources: AgentRunCleanupResources): Promise<void>;
}

export interface AgentRunCleanupResources {
  contextManifest: AgentRunContextManifestV1;
  executionEnvironment: AgentRunDtoV1['executionEnvironment'];
}

export interface AgentRunWorkspaceResolver {
  resolve(ownerUserId: string, workspaceId: string): {
    cwd: string;
    permissionPolicy: AgentPermissionPolicyV1;
  };
}

export interface AgentRunCoordinatorPorts {
  repository: AgentRunRepositoryPort;
  definitions: AgentDefinitionSource;
  capabilities: AgentCapabilityResolver;
  contexts: RunContextSnapshotStore;
  environments: ExecutionEnvironmentProvider;
  executor: AgentRunExecutor;
  workspaces: AgentRunWorkspaceResolver;
  notifier: AgentRunNotifier;
  parentSink: ParentContinuationSink;
  resourceCleaner: AgentRunResourceCleaner;
  /** Port for resolving the Parent's effective permission policy at spawn time.
   * Optional for backward compatibility; when absent, delegated Runs from a
   * Parent Run will use the workspace policy as the ceiling. */
  parentPermissions?: ParentPermissionPort;
  clock?: AgentRunClock;
  instanceId: string;
  nextId?: (kind: 'lease' | 'operation') => string;
  leaseDurationMs?: number;
  platformPermissionPolicy: AgentPermissionPolicyV1;
  maxRunTtlMs: number;
}

export interface SpawnCoordinatedRunInput {
  operationId: string;
  ownerUserId: string;
  workspaceId: string;
  definitionId: string | null;
  ephemeralDefinition: EffectiveAgentDefinitionV1 | null;
  invocationMode: 'delegated' | 'manual';
  completionMode: AgentRunCompletionMode;
  parentRunId: string | null;
  parentAttemptId: string | null;
  parentNodeId: string | null;
  parentTurnId: string | null;
  parentMessageId: string | null;
  parentToolCallId: string | null;
  task: string;
  contextManifest: AgentRunContextManifestV1;
  permissionRestriction: AgentPermissionPolicyV1 | null;
  environment: ExecutionEnvironmentRequestV1;
  expectedResult: ExpectedResultContractV1 | null;
  runTtlMs: number | null;
}

export type PreparedExecutionEnvironment = ExecutionEnvironmentLease;
export type AttemptRuntimeProfile = RuntimeProfileV1;
