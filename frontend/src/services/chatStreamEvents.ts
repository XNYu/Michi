import {
  CHAT_STREAM_EVENTS,
  parseChatStreamEvent,
  type AgentCommand,
  type ChatStreamEnvelope,
  type ChatStreamEvent,
  type ChatStreamPayloads,
  type PlanEntry,
  type SpawnBranchTopic,
  type ToolCallStreamPayload,
} from 'michi-shared';

export { CHAT_STREAM_EVENTS, parseChatStreamEvent };
export type {
  AgentCommand,
  ChatStreamEnvelope,
  ChatStreamEvent,
  ChatStreamPayloads,
  PlanEntry,
  SpawnBranchTopic,
  ToolCallStreamPayload,
};

export interface StreamHandlers {
  /** Runs before the event-specific callback. Returning false drops a replay. */
  onEnvelope?: (envelope: ChatStreamEnvelope) => boolean | void;
  onTurnStart?: (data: ChatStreamPayloads['turn_start']) => void;
  onChunk?: (text: string, seq?: number, assistantId?: string, turnId?: string) => void;
  onThought?: (text: string, seq?: number, assistantId?: string, turnId?: string) => void;
  onPlan?: (entries: PlanEntry[]) => void;
  onToolCall?: (t: ToolCallStreamPayload) => void;
  onToolCallUpdate?: (t: ToolCallStreamPayload) => void;
  onHeartbeat?: (idleMs: number) => void;
  onSpawnBranches?: (topics: SpawnBranchTopic[]) => void;
  onTitle?: (title: string) => void;
  onBranchOverview?: (overview: string, seq?: number, assistantId?: string, turnId?: string) => void;
  onFollowUps?: (followUps: string[]) => void;
  onFollowUpsStatus?: (status: 'in_progress' | 'completed' | 'failed') => void;
  onCommands?: (commands: AgentCommand[]) => void;
  onContextSaved?: (name: string, filePath: string, size?: number, contextId?: string) => void;
  onContextUpdated?: (name: string, filePath: string, size?: number, contextId?: string) => void;
  onImage?: (data: ChatStreamPayloads['image']) => void;
  onPermissionRequest?: (data: ChatStreamPayloads['permission_request']) => void;
  onSubagentListUpdate?: (data: ChatStreamPayloads['subagent_list_update']) => void;
  onSubagentToolActivity?: (data: ChatStreamPayloads['subagent_tool_activity']) => void;
  onContextUsage?: (data: ChatStreamPayloads['context_usage']) => void;
  onUsageSummary?: (data: ChatStreamPayloads['usage_summary']) => void;
  onMcpServerError?: (data: ChatStreamPayloads['mcp_server_error']) => void;
  onDone?: (stopReason?: string, assistantId?: string, turnId?: string, persisted?: boolean) => void;
  onAborted?: () => void;
  onError?: (msg: string, assistantId?: string, turnId?: string) => void;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled chat stream event: ${JSON.stringify(value)}`);
}

export function dispatchChatStreamEvent(
  streamEvent: ChatStreamEvent,
  handlers: StreamHandlers,
): void {
  if (handlers.onEnvelope?.(streamEvent.data) === false) return;
  switch (streamEvent.event) {
    case CHAT_STREAM_EVENTS.turnStart:
      handlers.onTurnStart?.(streamEvent.data);
      return;
    case CHAT_STREAM_EVENTS.chunk:
      handlers.onChunk?.(streamEvent.data.text, streamEvent.data.seq, streamEvent.data.assistantId, streamEvent.data.turnId);
      return;
    case CHAT_STREAM_EVENTS.thought:
      handlers.onThought?.(streamEvent.data.text, streamEvent.data.seq, streamEvent.data.assistantId, streamEvent.data.turnId);
      return;
    case CHAT_STREAM_EVENTS.plan:
      handlers.onPlan?.(streamEvent.data.entries);
      return;
    case CHAT_STREAM_EVENTS.toolCall:
      handlers.onToolCall?.(streamEvent.data);
      return;
    case CHAT_STREAM_EVENTS.toolCallUpdate:
      handlers.onToolCallUpdate?.(streamEvent.data);
      return;
    case CHAT_STREAM_EVENTS.heartbeat:
      handlers.onHeartbeat?.(streamEvent.data.idleMs);
      return;
    case CHAT_STREAM_EVENTS.spawnBranches:
      handlers.onSpawnBranches?.(streamEvent.data.topics);
      return;
    case CHAT_STREAM_EVENTS.title:
      handlers.onTitle?.(streamEvent.data.title);
      return;
    case CHAT_STREAM_EVENTS.branchOverview:
      handlers.onBranchOverview?.(
        streamEvent.data.overview,
        streamEvent.data.seq,
        streamEvent.data.assistantId,
        streamEvent.data.turnId,
      );
      return;
    case CHAT_STREAM_EVENTS.followUps:
      handlers.onFollowUps?.(streamEvent.data.followUps);
      return;
    case CHAT_STREAM_EVENTS.followUpsStatus:
      handlers.onFollowUpsStatus?.(streamEvent.data.status);
      return;
    case CHAT_STREAM_EVENTS.commands:
      handlers.onCommands?.(streamEvent.data.commands);
      return;
    case CHAT_STREAM_EVENTS.contextSaved:
      handlers.onContextSaved?.(
        streamEvent.data.name,
        streamEvent.data.filePath,
        streamEvent.data.size,
        streamEvent.data.contextId,
      );
      return;
    case CHAT_STREAM_EVENTS.contextUpdated:
      handlers.onContextUpdated?.(
        streamEvent.data.name,
        streamEvent.data.filePath,
        streamEvent.data.size,
        streamEvent.data.contextId,
      );
      return;
    case CHAT_STREAM_EVENTS.image:
      handlers.onImage?.(streamEvent.data);
      return;
    case CHAT_STREAM_EVENTS.permissionRequest:
      handlers.onPermissionRequest?.(streamEvent.data);
      return;
    case CHAT_STREAM_EVENTS.subagentListUpdate:
      handlers.onSubagentListUpdate?.(streamEvent.data);
      return;
    case CHAT_STREAM_EVENTS.subagentToolActivity:
      handlers.onSubagentToolActivity?.(streamEvent.data);
      return;
    case CHAT_STREAM_EVENTS.contextUsage:
      handlers.onContextUsage?.(streamEvent.data);
      return;
    case CHAT_STREAM_EVENTS.usageSummary:
      handlers.onUsageSummary?.(streamEvent.data);
      return;
    case CHAT_STREAM_EVENTS.mcpServerError:
      handlers.onMcpServerError?.(streamEvent.data);
      return;
    case CHAT_STREAM_EVENTS.done:
      if (typeof streamEvent.data.persisted === 'boolean') {
        handlers.onDone?.(
          streamEvent.data.stopReason,
          streamEvent.data.assistantId,
          streamEvent.data.turnId,
          streamEvent.data.persisted,
        );
      } else {
        handlers.onDone?.(
          streamEvent.data.stopReason,
          streamEvent.data.assistantId,
          streamEvent.data.turnId,
        );
      }
      return;
    case CHAT_STREAM_EVENTS.error:
      handlers.onError?.(streamEvent.data.message, streamEvent.data.assistantId, streamEvent.data.turnId);
      return;
    default:
      assertNever(streamEvent);
  }
}
