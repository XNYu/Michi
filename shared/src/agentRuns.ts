/**
 * Michi Custom Agent Contracts V1
 * 
 * This file defines the versioned DTOs and enums used across the backend and frontend
 * for Custom Agent Definitions and Durable Agent Runs.
 */

export enum AgentRunStatus {
  Queued = 'queued',
  Preparing = 'preparing',
  Running = 'running',
  Waiting = 'waiting',
  Recovering = 'recovering',
  Completed = 'completed',
  Failed = 'failed',
  Cancelled = 'cancelled',
  Terminal = 'terminal',
}

export enum AgentRunWaitingReason {
  UserInput = 'user_input',
  Permission = 'permission',
  Steering = 'steering',
  ParentDelivery = 'parent_delivery',
  ExternalEvent = 'external_event',
}

export enum AgentRunInvocationMode {
  Synchronous = 'synchronous',
  Notify = 'notify',
  Wake = 'wake',
  Detach = 'detach',
}

export enum AgentRunCompletionMode {
  StructuredResult = 'structured_result',
  InferredFallback = 'inferred_fallback',
}

export enum AgentRunEventType {
  StatusChange = 'status_change',
  InteractionRequested = 'interaction_requested',
  InteractionResolved = 'interaction_resolved',
  EventLog = 'event_log',
  ResultBundleUpdated = 'result_bundle_updated',
  WatchFired = 'watch_fired',
  AttemptStarted = 'attempt_started',
  AttemptFinished = 'attempt_finished',
}

export enum AgentPolicyCategory {
  Security = 'security',
  Resource = 'resource',
  Access = 'access',
  Execution = 'execution',
}

export enum AgentEnvironmentRequest {
  ReadOnly = 'read_only',
  SharedWrite = 'shared_write',
  IsolatedWorktree = 'isolated_worktree',
}

export type AgentDefinitionStatus = 'Draft' | 'Enabled' | 'Disabled';

export interface RuntimeProfileV1 {
  runtimeId: string;
  modelId: string;
  version: string;
  config: Record<string, any>;
  fingerprint: string;
}

export interface EffectiveCapabilitySnapshotV1 {
  capabilityRefs: string[];
  schemaHash: string;
  contentHash: string;
  configHash: string;
  bindingIds: string[]; // Opaque credential-binding IDs
}

export interface AgentDefinitionDtoV1 {
  id: string;
  ownerId: string;
  workspaceId: string;
  name: string;
  instructions: string;
  runtimeProfile: RuntimeProfileV1;
  capabilities: string[];
  fallback?: string[];
  defaultRunTtlMs?: number;
  status: AgentDefinitionStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRunDtoV1 {
  id: string;
  definitionId: string;
  definitionSnapshot: AgentDefinitionDtoV1;
  ownerId: string;
  workspaceId: string;
  status: AgentRunStatus;
  waitingReason?: AgentRunWaitingReason;
  currentAttemptId?: string;
  expiresAt: string | null; // ISO date or null for indefinite
  createdAt: string;
  updatedAt: string;
}

export interface AgentRunAttemptDtoV1 {
  id: string;
  runId: string;
  status: AgentRunStatus;
  startTime: string;
  endTime?: string;
  executorId: string;
  profileHash: string;
  nativeResumeToken?: string;
}

export interface AgentRunEventV1 {
  seq: number;
  timestamp: string;
  type: AgentRunEventType;
  payload: any;
}

export interface AgentRunInteractionDtoV1 {
  id: string;
  runId: string;
  attemptId: string;
  type: string;
  status: 'pending' | 'resolved' | 'cancelled';
  requestedAt: string;
  resolvedAt?: string;
  input?: any;
  resolution?: any;
}

export interface AgentRunWatchDtoV1 {
  id: string;
  runId: string;
  condition: any;
  quorum: number;
  deadline?: string;
  status: 'active' | 'fired' | 'expired';
  firedAt?: string;
}

export interface AgentRunContextManifestV1 {
  version: string;
  entries: Array<{
    id: string;
    type: string;
    reference: string;
    hash: string;
  }>;
}

export interface ResultBundleV1 {
  resultId: string;
  summary: string;
  artifacts: Array<{
    id: string;
    type: string;
    uri: string;
    hash: string;
  }>;
  mutations: Array<{
    id: string;
    type: string;
    receipt: any;
  }>;
  changeSet: {
    baseCommit: string;
    patchHash: string;
    summary: string;
  };
  handoff: {
    parentMessageId: string;
    parentToolCallId?: string;
    deliveryId: string;
    requestedTurnId: string;
  };
  unresolvedIssues: string[];
}

export interface AgentRunRequestDtoV1 {
  operationId: string;
  runId: string;
  payload: any;
}

export interface AgentRunSseEnvelopeV1 {
  event: string;
  data: any;
  timestamp: string;
  cursor: number;
}

/**
 * Pure validation helpers for untrusted input
 */
export const AgentRunValidators = {
  validateStatus: (status: any): status is AgentRunStatus => 
    Object.values(AgentRunStatus).includes(status),
  
  validateDefinitionStatus: (status: any): status is AgentDefinitionStatus => 
    ['Draft', 'Enabled', 'Disabled'].includes(status),

  validateTtl: (ttl: any): ttl is number => 
    typeof ttl === 'number' && ttl >= 0,
};
