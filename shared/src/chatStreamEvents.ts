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
}

export interface SubagentInfo {
  sessionId: string;
  sessionName: string;
  agentName: string;
  initialQuery: string;
  status: "working" | "terminated";
  statusMessage?: string;
  group: string;
  dependsOn: string[];
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
  contextSaved: "context_saved",
  contextUpdated: "context_updated",
  permissionRequest: "permission_request",
  subagentListUpdate: "subagent_list_update",
  subagentToolActivity: "subagent_tool_activity",
  contextUsage: "context_usage",
  usageSummary: "usage_summary",
  mcpServerError: "mcp_server_error",
  done: "done",
  error: "error",
  turnStart: "turn_start",
  image: "image",
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
  context_saved: { contextId?: string; name: string; filePath: string; size?: number };
  context_updated: { contextId?: string; name: string; filePath: string; size?: number };
  permission_request: {
    requestId: number;
    toolCallId?: string;
    title: string;
    detail?: string;
    options: PermissionOption[];
  };
  subagent_list_update: { subagents: SubagentInfo[] };
  subagent_tool_activity: { subagentSessionId: string; title: string; status: string };
  context_usage: { contextUsagePercentage: number };
  usage_summary: { contextUsagePercentage: number; totalCredits: number; turnDurationMs: number };
  mcp_server_error: { serverName: string; error: string };
  done: { stopReason?: string; persisted?: boolean; completedAt?: number };
  error: { message: string; code?: string; recoverable?: boolean; completedAt?: number };
  turn_start: { turnId: string; assistantId: string; nodeId: string; userText: string; selfInitiated?: boolean; startedAt?: number };
  image: { path: string; caption?: string; mimeType: string; size: number };
}

export interface ChatStreamEnvelope {
  /** Runtime chat identifier; present on every ChatHub-stamped frame. */
  chatId?: string;
  /** Stable Michi node identifier; present on every ChatHub-stamped frame. */
  nodeId?: string;
  turnId?: string;
  seq?: number;
  assistantId?: string;
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
  commands: (data) => ({ commands: parseCommands(data.commands) }),
  context_saved: (data) => ({
    contextId: optionalString(data.contextId),
    name: stringOrEmpty(data.name),
    filePath: stringOrEmpty(data.filePath),
    size: optionalFiniteNumber(data.size),
  }),
  context_updated: (data) => ({
    contextId: optionalString(data.contextId),
    name: stringOrEmpty(data.name),
    filePath: stringOrEmpty(data.filePath),
    size: optionalFiniteNumber(data.size),
  }),
  permission_request: (data) => {
    const options = Array.isArray(data.options)
      ? (data.options as Array<Record<string, unknown>>).map((option) => ({
          optionId: stringOrEmpty(option.optionId),
          name: stringOrEmpty(option.name),
          kind: stringOrEmpty(option.kind),
        }))
      : [];
    return {
      requestId: optionalFiniteNumber(data.requestId) ?? 0,
      toolCallId: optionalString(data.toolCallId),
      title: stringOrEmpty(data.title),
      detail: optionalString(data.detail),
      options,
    };
  },
  subagent_list_update: (data) => {
    const subagents = Array.isArray(data.subagents) ? data.subagents : [];
    return { subagents };
  },
  subagent_tool_activity: (data) => ({
    subagentSessionId: stringOrEmpty(data.subagentSessionId),
    title: stringOrEmpty(data.title),
    status: stringOrEmpty(data.status),
  }),
  context_usage: (data) => ({
    contextUsagePercentage: optionalFiniteNumber(data.contextUsagePercentage) ?? 0,
  }),
  usage_summary: (data) => ({
    contextUsagePercentage: optionalFiniteNumber(data.contextUsagePercentage) ?? 0,
    totalCredits: optionalFiniteNumber(data.totalCredits) ?? 0,
    turnDurationMs: optionalFiniteNumber(data.turnDurationMs) ?? 0,
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
    ...(data.recoverable === true ? { recoverable: true } : {}),
    completedAt: optionalFiniteNumber(data.completedAt),
  }),
  turn_start: (data) => ({
    turnId: stringOrEmpty(data.turnId),
    assistantId: stringOrEmpty(data.assistantId),
    nodeId: stringOrEmpty(data.nodeId),
    userText: stringOrEmpty(data.userText),
    ...(data.selfInitiated ? { selfInitiated: true } : {}),
    startedAt: optionalFiniteNumber(data.startedAt),
  }),
  image: (d) => ({
    path: stringOrEmpty(d.path),
    caption: optionalString(d.caption),
    mimeType: stringOrEmpty(d.mimeType),
    size: optionalFiniteNumber(d.size) ?? 0,
  }),
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
  if (typeof raw.chatId === "string") data.chatId = raw.chatId;
  if (typeof raw.nodeId === "string") data.nodeId = raw.nodeId;
  if (typeof raw.turnId === "string") data.turnId = raw.turnId;
  if (typeof raw.seq === "number" && Number.isFinite(raw.seq)) data.seq = raw.seq;
  if (typeof raw.assistantId === "string") data.assistantId = raw.assistantId;
  return { event, data } as ChatStreamEvent;
}

export function encodeChatStreamEvent(streamEvent: ChatStreamEvent): string {
  return `event: ${streamEvent.event}\ndata: ${JSON.stringify(streamEvent.data)}\n\n`;
}
