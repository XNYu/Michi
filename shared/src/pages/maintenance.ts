import type { BlockSource } from './blocks';
import type { MetaAgentResolvedRuntime } from '../metaAgent';
import type { ScheduledJobDto, ScheduledJobRunDto } from '../scheduledJobs';

export type MaintenanceResourceKind = 'page' | 'database';
export type MaintenanceTerminalOutcome = 'written' | 'proposed' | 'no_change' | 'skipped';
export type MaintenancePlanState = 'routing' | 'processing' | 'terminal' | 'attention' | 'cancelled';
export type MaintenanceSourceState = 'routing' | 'processing' | 'terminal' | 'attention' | 'skipped';
export type MaintenanceResourceState = 'pending' | MaintenanceTerminalOutcome | 'attention';

export interface MaintenanceConfig {
  workspaceId: string;
  ownerUserId: string;
  jobId: string;
  enabled: boolean;
  paused: boolean;
  revision: number;
  completionCursor: number;
  runtimeId: string | null;
  providerId: string | null;
  modelId: string | null;
  reasoning: string | null;
  updatedAt: number;
}

export interface MaintenanceResourceRef {
  kind: MaintenanceResourceKind;
  id: string;
  revision: number;
  /** Pages through which this database was discovered. */
  pageIds: string[];
}

export interface MaintenanceSourcePlan {
  sourceTurnId: string;
  completionSeq: number;
  evidence: BlockSource;
  state: MaintenanceSourceState;
  routingComplete: boolean;
  /** Complete, versioned manifest observed before routing. */
  manifest: MaintenanceResourceRef[];
  messages?: MaintenanceSourceMessageDescriptor[];
  candidates: MaintenanceResourceRef[];
  terminalReason: string | null;
}

export interface MaintenancePlan {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  jobId: string;
  runId: string | null;
  configRevision: number;
  generation: number;
  scopeSpaceId?: string | null;
  reconsiderOfPlanId: string | null;
  after: number;
  through: number;
  state: MaintenancePlanState;
  sources: MaintenanceSourcePlan[];
  createdAt: number;
  updatedAt: number;
}

export interface MaintenanceReceipt {
  operationKey: string;
  planId: string;
  jobId: string;
  sourceTurnId: string;
  resource: MaintenanceResourceRef;
  generation: number;
  payloadHash: string;
  payload: unknown;
  assignedIds: unknown;
  result: unknown;
  outcome: Exclude<MaintenanceTerminalOutcome, 'skipped'>;
  execution: BlockSource & { runId: string };
  evidence: BlockSource;
  committedAt: number;
}

export interface MaintenanceSourcePart {
  partId: string;
  sourceTurnId: string;
  messageId: string;
  role: 'user' | 'assistant';
  partIndex: number;
  partCount: number;
  byteStart: number;
  byteEnd: number;
  content: string;
  partHash: string;
  acknowledged: boolean;
}

export interface MaintenanceSourceMessageDescriptor {
  messageId: string;
  role: 'user' | 'assistant';
  byteLength: number;
  contentHash: string;
  partCount: number;
}

export interface MaintenanceWorkspaceStatus {
  completionCounter: number;
  lastRun: ScheduledJobRunDto | null;
  pendingSources: number;
  attentionSources: number;
}

export interface MaintenanceBacklog {
  plans: MaintenancePlan[];
  pendingSources: number;
  attentionSources: number;
}

export type MaintenanceQueuedRequest =
  | { kind: 'reconsider'; requestId: string; createdAt: number }
  | { kind: 'catchup'; requestId: string; spaceId: string; after: number; through: number; createdAt: number };

export interface MaintenanceWorkspaceResponse {
  config: MaintenanceConfig | null;
  status: MaintenanceWorkspaceStatus | null;
  backlog: MaintenanceBacklog;
  job: ScheduledJobDto | null;
  scheduler: 'available' | 'unavailable' | 'paused';
  excludedSpaceIds: string[];
  catchUpSuggestions?: MaintenanceCatchupSuggestion[];
  /** What runs maintenance on this backend: the Meta agent's resolved runtime (Settings › Meta agent). Absent from older backends. */
  runtime?: MetaAgentResolvedRuntime;
}

export interface MaintenanceCatchupSuggestion {
  periodId: string;
  spaceId: string;
  after: number;
  through: number;
  maxPositions: number;
  availablePositions: number;
  excludedAt: number;
  reenabledAt: number;
  sourceCount: number;
  latestSources: Array<{ turnId: string; completionSeq: number; completedAt: number; preview: string }>;
}
