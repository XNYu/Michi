import { parseSessionState, type AgentSessionState } from './sessionState';
import { parseSteeringReports, type SteeringReport } from './kiroSteering';
import type { DurableMessageMetadata } from './turnProjection';
import {
  parseSubagentActivityPayload,
  parseSubagentPatches,
  type SubagentActivityPayload,
  type SubagentPatch,
} from './subagents';

export type { SubagentInfo, SubagentPatch, SubagentActivityPayload } from './subagents';

export interface SteerMessageOptions {
  displayText?: string;
  userMetadata?: DurableMessageMetadata;
  queueId?: string;
}

export interface PlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

export interface AgentCommand {
  name: string;
  description?: string;
  input?: { type: string };
}

export interface ToolCallStreamPayload {
  toolCallId: string;
  title: string;
  status: string;
  kind?: string;
  detail?: string;
  /** Input snapshot (possibly payload-capped), never an append-only JSON delta.
   * May arrive on an update after the initial call; omission preserves prior input. */
  inputJson?: string;
  output?: string;
}

export interface SpawnBranchTopic {
  title: string;
  prompt: string;
  chatId: string;
  nodeId?: string;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
  disabled?: boolean;
}

export interface UserInputOption {
  label: string;
  description?: string;
}

export interface UserInputQuestion {
  id?: string;
  question: string;
  header?: string;
  options: UserInputOption[];
  multiSelect: boolean;
}

export interface UserInputRequestPayload {
  requestId: number;
  /** Durable identity scoped to the owning turn; requestId remains the runtime response handle. */
  interactionId?: string;
  questions: UserInputQuestion[];
}

export interface UserInputAnswer {
  id?: string;
  question: string;
  answer: string;
}

export interface UsageCharge {
  amount: number;
  unit: 'USD' | 'credits';
  provenance: 'provider_reported' | 'sdk_estimate' | 'catalog_estimate' | 'native_metering' | 'unknown';
}

export interface RuntimeWarning {
  source: string;
  category: 'provider' | 'runtime' | 'setup' | 'configuration';
  message: string;
  code?: string;
  serverName?: string;
}

export const CHAT_STREAM_EVENTS = {
  chunk: "chunk",
  thought: "thought",
  plan: "plan",
  toolCall: "tool_call",
  toolCallUpdate: "tool_call_update",
  heartbeat: "heartbeat",
  spawnBranches: "spawn_branches",
  title: "title",
  branchOverview: "branch_overview",
  followUps: "follow_ups",
  followUpsStatus: "follow_ups_status",
  commands: "commands",
  sessionState: "session_state",
  artifactSaved: "artifact_saved",
  artifactUpdated: "artifact_updated",
  permissionRequest: "permission_request",
  permissionResolved: "permission_resolved",
  userInputRequest: "user_input_request",
  userInputResolved: "user_input_resolved",
  subagentListUpdate: "subagent_list_update",
  subagentToolActivity: "subagent_tool_activity",
  contextUsage: "context_usage",
  usageSummary: "usage_summary",
  mcpServerError: "mcp_server_error",
  warning: "warning",
  done: "done",
  error: "error",
  turnStart: "turn_start",
  image: "image",
  cancelPhase: "cancel_phase",
  queueUpdate: "queue_update",
  steerAccepted: "steer_accepted",
  steeringReport: "steering_report",
  compactionStart: "compaction_start",
  compactionEnd: "compaction_end",
  retryStart: "retry_start",
  retryEnd: "retry_end",
  harnessLifecycle: "harness_lifecycle",
} as const;

export type ChatStreamEventName =
  typeof CHAT_STREAM_EVENTS[keyof typeof CHAT_STREAM_EVENTS];

export interface ChatStreamPayloads {
  chunk: { text: string };
  thought: { text: string };
  plan: { entries: PlanEntry[] };
  tool_call: ToolCallStreamPayload;
  tool_call_update: ToolCallStreamPayload;
  heartbeat: { idleMs: number };
  spawn_branches: { topics: SpawnBranchTopic[] };
  title: { title: string };
  branch_overview: { overview: string };
  follow_ups: { followUps: string[] };
  follow_ups_status: { status: "in_progress" | "completed" | "failed" };
  commands: { commands: AgentCommand[] };
  session_state: AgentSessionState;
  artifact_saved: { contextId?: string; name: string; filePath: string; size?: number };
  artifact_updated: { contextId?: string; name: string; filePath: string; size?: number };
  permission_resolved: { requestId: number };
  permission_request: {
    requestId: number;
    toolCallId?: string;
    title: string;
    detail?: string;
    options: PermissionOption[];
    source?: string;
  };
  user_input_request: UserInputRequestPayload;
  user_input_resolved: { requestId: number; interactionId?: string; answers: UserInputAnswer[]; outcome?: 'answered' | 'skipped' };
  /** A patch: entries merge onto the roster by sessionId (see subagents.ts). */
  subagent_list_update: { subagents: SubagentPatch[] };
  subagent_tool_activity: SubagentActivityPayload;
  context_usage: { contextUsagePercentage: number };
  usage_summary: {
    contextUsagePercentage?: number;
    /** Legacy native credit amount; currency charges use charge. */
    totalCredits?: number;
    charge?: UsageCharge;
    turnDurationMs?: number;
    source?: string;
    totalTokens?: number;
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
  };
  cancel_phase: { phase: "requested" | "acknowledged" | "settled" };
  queue_update: { steering: string[]; followUp: string[] };
  steer_accepted: {
    text: string;
    pending?: boolean;
    messageId?: string;
    createdAt?: number;
    userMetadata?: DurableMessageMetadata;
    queueId?: string;
  };
  steering_report: { reports: SteeringReport[] };
  compaction_start: { detail?: string };
  compaction_end: { detail?: string };
  retry_start: { detail?: string };
  retry_end: { detail?: string };
  harness_lifecycle: {
    level: "run" | "turn" | "item";
    phase: "start" | "delta" | "completed" | "failed" | "cancelled";
    nativeType?: string;
  };
  mcp_server_error: { serverName: string; error: string };
  warning: RuntimeWarning;
  done: { stopReason?: string; persisted?: boolean; completedAt?: number };
  /** `code` is machine-readable when present, e.g. META_AGENT_GUARD_ERROR_CODE (metaAgent.ts). */
  error: { message: string; code?: string; recoverable?: boolean; completedAt?: number };
  turn_start: {
    turnId: string;
    assistantId: string;
    nodeId: string;
    userText: string;
    selfInitiated?: boolean;
    startedAt?: number;
    /** Present when the turn carries a visible user message with metadata (e.g. a cross-thread message). */
    userMetadata?: DurableMessageMetadata;
  };
  image: { path: string; caption?: string; mimeType: string; size: number };
}

export interface ChatStreamEnvelope {
  /** Backend observation time, preserved verbatim across journal/replay. */
  observedAt?: number;
  /** Runtime chat identifier; present on every ChatHub-stamped frame. */
  chatId?: string;
  /** Stable Michi node identifier; present on every ChatHub-stamped frame. */
  nodeId?: string;
  turnId?: string;
  seq?: number;
  assistantId?: string;
  source?: string;
  confidence?: string;
  nativeMethod?: string;
}

export type ChatStreamEvent = {
  [K in ChatStreamEventName]: { event: K; data: ChatStreamPayloads[K] & ChatStreamEnvelope };
}[ChatStreamEventName];

type ParserMap = {
  [K in ChatStreamEventName]: (data: Record<string, unknown>) => ChatStreamPayloads[K];
};

const CHAT_STREAM_EVENT_NAMES = new Set<string>(Object.values(CHAT_STREAM_EVENTS));

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseUsageCharge(value: unknown): UsageCharge | undefined {
  const raw = objectOrEmpty(value);
  const amount = optionalFiniteNumber(raw.amount);
  if (amount === undefined || amount < 0 || (raw.unit !== 'USD' && raw.unit !== 'credits')) return undefined;
  const provenance = raw.provenance === 'provider_reported' || raw.provenance === 'sdk_estimate'
    || raw.provenance === 'catalog_estimate' || raw.provenance === 'native_metering' ? raw.provenance : 'unknown';
  return { amount, unit: raw.unit, provenance };
}

function parsePlanEntries(value: unknown): PlanEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const raw = objectOrEmpty(entry);
    const priority = raw.priority === "high" || raw.priority === "low"
      ? raw.priority
      : "medium";
    const status = raw.status === "in_progress" || raw.status === "completed"
      ? raw.status
      : "pending";
    return {
      content: String(raw.content ?? ""),
      priority,
      status,
    };
  });
}

function parseToolCall(value: Record<string, unknown>): ToolCallStreamPayload {
  const kind = optionalString(value.kind);
  const detail = optionalString(value.detail);
  const inputJson = optionalString(value.inputJson);
  const output = optionalString(value.output);
  return {
    toolCallId: stringOrEmpty(value.toolCallId),
    title: stringOrEmpty(value.title),
    status: stringOrEmpty(value.status),
    ...(kind ? { kind } : {}),
    ...(detail ? { detail } : {}),
    ...(inputJson ? { inputJson } : {}),
    ...(output ? { output } : {}),
  };
}

function parseSpawnTopics(value: unknown): SpawnBranchTopic[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((topic) => {
      const raw = objectOrEmpty(topic);
      return {
        title: stringOrEmpty(raw.title),
        prompt: stringOrEmpty(raw.prompt),
        chatId: stringOrEmpty(raw.chatId),
        nodeId: optionalString(raw.nodeId),
      };
    })
    .filter((topic) => topic.title || topic.prompt || topic.chatId);
}

function parseStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function parseCommands(value: unknown): AgentCommand[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((command) => {
      const raw = objectOrEmpty(command);
      const input = objectOrEmpty(raw.input);
      return {
        name: stringOrEmpty(raw.name),
        description: optionalString(raw.description),
        input: raw.input && typeof raw.input === "object"
          ? { type: String(input.type ?? "unstructured") }
          : undefined,
      };
    })
    .filter((command) => command.name.length > 0);
}

const parsers = {
  chunk: (data) => ({ text: stringOrEmpty(data.text) }),
  thought: (data) => ({ text: stringOrEmpty(data.text) }),
  plan: (data) => ({ entries: parsePlanEntries(data.entries) }),
  tool_call: (data) => parseToolCall(data),
  tool_call_update: (data) => parseToolCall(data),
  heartbeat: (data) => ({ idleMs: optionalFiniteNumber(data.idleMs) ?? 0 }),
  spawn_branches: (data) => ({ topics: parseSpawnTopics(data.topics) }),
  title: (data) => ({ title: stringOrEmpty(data.title) }),
  branch_overview: (data) => ({ overview: stringOrEmpty(data.overview) }),
  follow_ups: (data) => ({ followUps: parseStringList(data.followUps) }),
  follow_ups_status: (data) => {
    const raw = typeof data.status === "string" ? data.status : "";
    const status: "in_progress" | "completed" | "failed" =
      raw === "completed" || raw === "failed" ? raw : "in_progress";
    return { status };
  },
  session_state: parseSessionState,
  commands: (data) => ({ commands: parseCommands(data.commands) }),
  artifact_saved: (data) => ({
    contextId: optionalString(data.contextId),
    name: stringOrEmpty(data.name),
    filePath: stringOrEmpty(data.filePath),
    size: optionalFiniteNumber(data.size),
  }),
  artifact_updated: (data) => ({
    contextId: optionalString(data.contextId),
    name: stringOrEmpty(data.name),
    filePath: stringOrEmpty(data.filePath),
    size: optionalFiniteNumber(data.size),
  }),
  permission_resolved: (data) => ({ requestId: optionalFiniteNumber(data.requestId) ?? 0 }),
  permission_request: (data) => {
    const options = Array.isArray(data.options)
      ? (data.options as Array<Record<string, unknown>>).map((option) => ({
          optionId: stringOrEmpty(option.optionId),
          name: stringOrEmpty(option.name),
          kind: stringOrEmpty(option.kind),
          ...(option.disabled === true ? { disabled: true } : {}),
        }))
      : [];
    return {
      requestId: optionalFiniteNumber(data.requestId) ?? 0,
      toolCallId: optionalString(data.toolCallId),
      title: stringOrEmpty(data.title),
      detail: optionalString(data.detail),
      options,
      source: optionalString(data.source),
    };
  },
  user_input_request: (data) => {
    const questions = Array.isArray(data.questions)
      ? (data.questions as Array<Record<string, unknown>>).map((q) => {
          const options = Array.isArray(q.options)
            ? (q.options as Array<Record<string, unknown>>).map((o) => ({
                label: stringOrEmpty(o.label),
                description: optionalString(o.description),
              }))
            : [];
          return {
            ...(typeof q.id === 'string' ? { id: q.id } : {}),
            question: stringOrEmpty(q.question),
            header: optionalString(q.header),
            options,
            multiSelect: q.multiSelect === true,
          };
        })
      : [];
    return {
      requestId: optionalFiniteNumber(data.requestId) ?? 0,
      interactionId: optionalString(data.interactionId),
      questions,
    };
  },
  user_input_resolved: (data) => {
    const answers = Array.isArray(data.answers)
      ? (data.answers as Array<Record<string, unknown>>).map((a) => ({
          ...(typeof a.id === 'string' ? { id: a.id } : {}),
          question: stringOrEmpty(a.question),
          answer: stringOrEmpty(a.answer),
        }))
      : [];
    return {
      requestId: optionalFiniteNumber(data.requestId) ?? 0,
      interactionId: optionalString(data.interactionId),
      ...(data.outcome === 'answered' || data.outcome === 'skipped' ? { outcome: data.outcome } : {}),
      answers,
    };
  },
  subagent_list_update: (data) => ({ subagents: parseSubagentPatches(data.subagents) }),
  subagent_tool_activity: (data) => parseSubagentActivityPayload(data),
  context_usage: (data) => ({
    contextUsagePercentage: optionalFiniteNumber(data.contextUsagePercentage) ?? 0,
  }),
  usage_summary: (data) => ({
    contextUsagePercentage: optionalFiniteNumber(data.contextUsagePercentage),
    totalCredits: optionalFiniteNumber(data.totalCredits),
    charge: parseUsageCharge(data.charge),
    turnDurationMs: optionalFiniteNumber(data.turnDurationMs),
    source: optionalString(data.source),
    totalTokens: optionalFiniteNumber(data.totalTokens),
    inputTokens: optionalFiniteNumber(data.inputTokens),
    cachedInputTokens: optionalFiniteNumber(data.cachedInputTokens),
    outputTokens: optionalFiniteNumber(data.outputTokens),
    reasoningOutputTokens: optionalFiniteNumber(data.reasoningOutputTokens),
  }),
  warning: (data) => ({
    source: stringOrEmpty(data.source),
    category: data.category === 'provider' || data.category === 'setup' || data.category === 'configuration' ? data.category : 'runtime',
    message: stringOrEmpty(data.message),
    code: optionalString(data.code),
    serverName: optionalString(data.serverName),
  }),
  mcp_server_error: (data) => ({
    serverName: stringOrEmpty(data.serverName),
    error: stringOrEmpty(data.error),
  }),
  done: (data) => ({
    stopReason: optionalString(data.stopReason),
    ...(typeof data.persisted === 'boolean' ? { persisted: data.persisted } : {}),
    completedAt: optionalFiniteNumber(data.completedAt),
  }),
  error: (data) => ({
    message: stringOrEmpty(data.message),
    code: optionalString(data.code),
    ...(typeof data.recoverable === 'boolean' ? { recoverable: data.recoverable } : {}),
    completedAt: optionalFiniteNumber(data.completedAt),
  }),
  turn_start: (data) => ({
    turnId: stringOrEmpty(data.turnId),
    assistantId: stringOrEmpty(data.assistantId),
    nodeId: stringOrEmpty(data.nodeId),
    userText: stringOrEmpty(data.userText),
    ...(data.selfInitiated ? { selfInitiated: true } : {}),
    startedAt: optionalFiniteNumber(data.startedAt),
    ...(data.userMetadata && typeof data.userMetadata === 'object' && !Array.isArray(data.userMetadata)
      ? { userMetadata: data.userMetadata as DurableMessageMetadata } : {}),
  }),
  image: (d) => ({
    path: stringOrEmpty(d.path),
    caption: optionalString(d.caption),
    mimeType: stringOrEmpty(d.mimeType),
    size: optionalFiniteNumber(d.size) ?? 0,
  }),
  cancel_phase: (data) => {
    const raw = typeof data.phase === "string" ? data.phase : "";
    const phase: "requested" | "acknowledged" | "settled" =
      raw === "acknowledged" || raw === "settled" ? raw : "requested";
    return { phase };
  },
  queue_update: (data) => ({
    steering: parseStringList(data.steering),
    followUp: parseStringList(data.followUp),
  }),
  steer_accepted: (data) => ({
    text: stringOrEmpty(data.text),
    ...(data.pending === true ? { pending: true } : {}),
    messageId: optionalString(data.messageId),
    createdAt: optionalFiniteNumber(data.createdAt),
    queueId: optionalString(data.queueId),
    userMetadata: data.userMetadata && typeof data.userMetadata === 'object' && !Array.isArray(data.userMetadata)
      ? data.userMetadata as DurableMessageMetadata : undefined,
  }),
  steering_report: (data) => ({ reports: parseSteeringReports(data.reports) }),
  compaction_start: (data) => ({ detail: optionalString(data.detail) }),
  compaction_end: (data) => ({ detail: optionalString(data.detail) }),
  retry_start: (data) => ({ detail: optionalString(data.detail) }),
  retry_end: (data) => ({ detail: optionalString(data.detail) }),
  harness_lifecycle: (data) => {
    const level = data.level === "run" || data.level === "item" ? data.level : "turn";
    const phase =
      data.phase === "delta" || data.phase === "completed" || data.phase === "failed" || data.phase === "cancelled"
        ? data.phase
        : "start";
    return { level, phase, nativeType: optionalString(data.nativeType) };
  },
} satisfies ParserMap;

function isChatStreamEventName(event: string): event is ChatStreamEventName {
  return CHAT_STREAM_EVENT_NAMES.has(event);
}

export function parseChatStreamEvent(event: string, rawData: string): ChatStreamEvent | null {
  if (!isChatStreamEventName(event)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    return null;
  }

  const raw = objectOrEmpty(parsed);
  const data = parsers[event](raw) as ChatStreamPayloads[typeof event] & ChatStreamEnvelope;
  if (typeof raw.observedAt === "number" && Number.isFinite(raw.observedAt)) data.observedAt = raw.observedAt;
  if (typeof raw.chatId === "string") data.chatId = raw.chatId;
  if (typeof raw.nodeId === "string") data.nodeId = raw.nodeId;
  if (typeof raw.turnId === "string") data.turnId = raw.turnId;
  if (typeof raw.seq === "number" && Number.isFinite(raw.seq)) data.seq = raw.seq;
  if (typeof raw.assistantId === "string") data.assistantId = raw.assistantId;
  if (typeof raw.source === "string") data.source = raw.source;
  if (typeof raw.confidence === "string") data.confidence = raw.confidence;
  if (typeof raw.nativeMethod === "string") data.nativeMethod = raw.nativeMethod;
  return { event, data } as ChatStreamEvent;
}

export function encodeChatStreamEvent(streamEvent: ChatStreamEvent): string {
  return `event: ${streamEvent.event}\ndata: ${JSON.stringify(streamEvent.data)}\n\n`;
}
