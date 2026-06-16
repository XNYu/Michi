import { subscribeChat } from '../services/api';
import type { StreamHandlers } from '../services/chatStreamEvents';
import type { ChatAction } from './chatTypes';

type Ref<T> = { current: T };

interface ObserveOptions {
  chatId: string;
  nodeId: string;
  dispatch: (action: ChatAction) => void;
  lastTurnRef: Ref<string>;
  lastSeqRef: Ref<number>;
  onTerminal?: () => void;
}

function toolState(tool: Parameters<NonNullable<StreamHandlers['onToolCall']>>[0]) {
  return {
    id: tool.toolCallId || `t-${Date.now()}`,
    title: tool.title,
    status: tool.status,
    kind: tool.kind,
    detail: tool.detail,
    inputJson: tool.inputJson,
    output: tool.output,
  };
}

export function observeChatStream({
  chatId,
  nodeId,
  dispatch,
  lastTurnRef,
  lastSeqRef,
  onTerminal,
}: ObserveOptions): () => void {
  let stopped = false;
  let detach: (() => void) | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const makeHandlers = (): StreamHandlers => {
    let assistantId = '';
    let turnId = '';

    const rememberEnvelope = (incomingAssistantId?: string, incomingTurnId?: string) => {
      if (incomingAssistantId) assistantId = incomingAssistantId;
      if (incomingTurnId) turnId = incomingTurnId;
    };

    const applySeq = (seq?: number, incomingTurnId?: string): boolean => {
      if (incomingTurnId) turnId = incomingTurnId;
      if (typeof seq !== 'number' || !turnId) return true;
      if (lastTurnRef.current === turnId && seq <= lastSeqRef.current) return false;
      lastTurnRef.current = turnId;
      lastSeqRef.current = seq;
      dispatch({ type: 'apply-seq', nodeId, turnId, seq });
      return true;
    };

    return {
      onTurnStart: (data) => {
        rememberEnvelope(data.assistantId, data.turnId);
        const envelope = data as typeof data & { seq?: number };
        const seq = typeof envelope.seq === 'number' ? envelope.seq : 0;
        if (!applySeq(seq, data.turnId)) return;
        dispatch({
          type: 'observer-turn-start',
          nodeId,
          turnId: data.turnId,
          assistantId: data.assistantId,
          userText: data.userText,
        });
      },
      onChunk: (text, seq, incomingAssistantId, incomingTurnId) => {
        rememberEnvelope(incomingAssistantId, incomingTurnId);
        if (applySeq(seq, incomingTurnId) && assistantId) {
          dispatch({ type: 'chunk', nodeId, assistantId, text });
        }
      },
      onThought: (text, seq, incomingAssistantId, incomingTurnId) => {
        rememberEnvelope(incomingAssistantId, incomingTurnId);
        if (applySeq(seq, incomingTurnId) && assistantId) {
          dispatch({ type: 'thought', nodeId, assistantId, text });
        }
      },
      onPlan: (entries) => {
        if (assistantId) dispatch({ type: 'plan', nodeId, assistantId, entries });
      },
      onToolCall: (tool) => {
        const env = tool as typeof tool & { assistantId?: string; turnId?: string; seq?: number };
        rememberEnvelope(env.assistantId, env.turnId);
        if (applySeq(env.seq, env.turnId) && assistantId) {
          dispatch({ type: 'tool-call', nodeId, assistantId, tool: toolState(tool) });
        }
      },
      onToolCallUpdate: (tool) => {
        const env = tool as typeof tool & { assistantId?: string; turnId?: string; seq?: number };
        rememberEnvelope(env.assistantId, env.turnId);
        if (applySeq(env.seq, env.turnId) && assistantId) {
          dispatch({ type: 'tool-call-update', nodeId, assistantId, tool: toolState(tool) });
        }
      },
      onHeartbeat: (idleMs) => dispatch({ type: 'heartbeat', nodeId, idleMs }),
      onTitle: (title) => dispatch({ type: 'set-title', nodeId, title }),
      onFollowUps: (followUps) => dispatch({ type: 'set-follow-ups', nodeId, followUps }),
      onFollowUpsStatus: (status) => dispatch({ type: 'follow-ups-status', nodeId, status }),
      onCommands: (commands) => dispatch({ type: 'set-commands', nodeId, commands }),
      onPermissionRequest: (permission) => dispatch({ type: 'permission-request', nodeId, permission }),
      onSubagentListUpdate: (data) =>
        dispatch({ type: 'subagent-list-update', nodeId, subagents: data.subagents }),
      onSubagentToolActivity: (data) =>
        dispatch({
          type: 'subagent-tool-activity',
          nodeId,
          subagentSessionId: data.subagentSessionId,
          title: data.title,
          status: data.status,
        }),
      onContextUsage: (data) =>
        dispatch({ type: 'context-usage', nodeId, contextUsagePercentage: data.contextUsagePercentage }),
      onUsageSummary: (data) =>
        dispatch({
          type: 'usage-summary',
          nodeId,
          contextUsagePercentage: data.contextUsagePercentage,
          totalCredits: data.totalCredits,
          turnDurationMs: data.turnDurationMs,
        }),
      onMcpServerError: (data) =>
        dispatch({ type: 'mcp-server-error', nodeId, serverName: data.serverName, error: data.error }),
      onDone: (_stopReason, incomingAssistantId, incomingTurnId) => {
        rememberEnvelope(incomingAssistantId, incomingTurnId);
        if (assistantId) dispatch({ type: 'done', nodeId, assistantId });
        onTerminal?.();
      },
      onError: (message, incomingAssistantId, incomingTurnId) => {
        rememberEnvelope(incomingAssistantId, incomingTurnId);
        if (assistantId) dispatch({ type: 'error', nodeId, assistantId, message });
        onTerminal?.();
      },
    };
  };

  const connect = () => {
    if (stopped) return;
    const fromSeq = lastSeqRef.current >= 0 ? lastSeqRef.current + 1 : 0;
    detach = subscribeChat(
      chatId,
      makeHandlers(),
      { turnId: lastTurnRef.current || undefined, seq: fromSeq },
      {
        onDisconnect: () => {
          if (stopped) return;
          reconnectTimer = setTimeout(connect, 500);
        },
      },
    );
  };

  connect();

  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    detach?.();
  };
}
