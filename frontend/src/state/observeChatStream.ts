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
  extraHandlers?: Omit<Partial<StreamHandlers>, 'onEnvelope' | 'onTurnStart' | 'onDone' | 'onError'>;
  onTurnEnd?: (reason: 'done' | 'error', nodeId: string) => void;
  onStreamComplete?: () => void;
  cursor?: 'foreground' | 'background';
}

export interface BackgroundTurnBinding {
  nodeId: string;
  chatId: string;
  createHandlers(): StreamHandlers;
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

export function createBackgroundTurnBinding({
  chatId,
  nodeId,
  dispatch,
  lastTurnRef,
  lastSeqRef,
  onTerminal,
  extraHandlers,
  onTurnEnd,
  onStreamComplete,
  cursor = 'background',
}: ObserveOptions): BackgroundTurnBinding {
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
      dispatch({ type: cursor === 'foreground' ? 'apply-seq' : 'apply-background-seq', nodeId, turnId, seq });
      return true;
    };

    const base: StreamHandlers = {
      onEnvelope: (envelope) => {
        rememberEnvelope(envelope.assistantId, envelope.turnId);
        return applySeq(envelope.seq, envelope.turnId);
      },
      onTurnStart: (data) => {
        rememberEnvelope(data.assistantId, data.turnId);
        dispatch({
          type: 'observer-turn-start',
          nodeId,
          turnId: data.turnId,
          assistantId: data.assistantId,
          userText: data.userText,
          ...(data.selfInitiated ? { selfInitiated: true } : {}),
          cursor,
        });
      },
      onChunk: (text, _seq, incomingAssistantId, incomingTurnId) => {
        rememberEnvelope(incomingAssistantId, incomingTurnId);
        if (assistantId) {
          dispatch({ type: 'chunk', nodeId, assistantId, text });
        }
      },
      onThought: (text, _seq, incomingAssistantId, incomingTurnId) => {
        rememberEnvelope(incomingAssistantId, incomingTurnId);
        if (assistantId) {
          dispatch({ type: 'thought', nodeId, assistantId, text });
        }
      },
      onPlan: (entries) => {
        if (assistantId) dispatch({ type: 'plan', nodeId, assistantId, entries });
      },
      onToolCall: (tool) => {
        const env = tool as typeof tool & { assistantId?: string; turnId?: string; seq?: number };
        rememberEnvelope(env.assistantId, env.turnId);
        if (assistantId) {
          dispatch({ type: 'tool-call', nodeId, assistantId, tool: toolState(tool) });
        }
      },
      onToolCallUpdate: (tool) => {
        const env = tool as typeof tool & { assistantId?: string; turnId?: string; seq?: number };
        rememberEnvelope(env.assistantId, env.turnId);
        if (assistantId) {
          dispatch({ type: 'tool-call-update', nodeId, assistantId, tool: toolState(tool) });
        }
      },
      onImage: (data) => {
        if (assistantId) {
          dispatch({
            type: 'image-block', nodeId, assistantId,
            path: data.path, caption: data.caption, mimeType: data.mimeType, size: data.size,
          });
        }
      },
      onHeartbeat: (idleMs) => dispatch({ type: 'heartbeat', nodeId, idleMs }),
      onTitle: (title) => dispatch({ type: 'set-title', nodeId, title }),
      onBranchOverview: (overview, seq, incomingAssistantId, incomingTurnId) => {
        rememberEnvelope(incomingAssistantId, incomingTurnId);
        void seq;
        dispatch({ type: 'set-branch-overview', nodeId, overview, assistantId });
      },
      onFollowUps: (followUps) => dispatch({ type: 'set-follow-ups', nodeId, followUps }),
      onFollowUpsStatus: (status) => dispatch({ type: 'follow-ups-status', nodeId, status }),
      onCommands: (commands) => dispatch({ type: 'set-commands', nodeId, commands }),
      onPermissionRequest: (permission) => dispatch({ type: 'permission-request', nodeId, permission }),
      onUserInputRequest: (data) =>
        dispatch({ type: 'user-input-request', nodeId, userInput: { requestId: data.requestId, questions: data.questions, answers: [] } }),
      onUserInputResolved: () => dispatch({ type: 'user-input-resolved', nodeId }),
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
          source: data.source,
        }),
      onCancelPhase: (data) => dispatch({ type: 'cancel-phase', nodeId, phase: data.phase }),
      onCompactionStart: () => dispatch({ type: 'compaction', nodeId, active: true }),
      onCompactionEnd: () => dispatch({ type: 'compaction', nodeId, active: false }),
      onMcpServerError: (data) =>
        dispatch({ type: 'mcp-server-error', nodeId, serverName: data.serverName, error: data.error }),
      onDone: (stopReason, incomingAssistantId, incomingTurnId, persisted, completedAt) => {
        rememberEnvelope(incomingAssistantId, incomingTurnId);
        if (!assistantId) return;
        if (persisted === false) {
          dispatch({
            type: 'error', nodeId, assistantId,
            message: 'The turn finished but the backend did not confirm durable persistence.',
          });
          onTurnEnd?.('error', nodeId);
          onTerminal?.();
          return;
        }
        if (stopReason === 'error') {
          dispatch({
            type: 'error', nodeId, assistantId,
            message: 'Agent process exited before completing the turn.',
          });
          onTurnEnd?.('error', nodeId);
          onTerminal?.();
          return;
        }
        const aborted = stopReason === 'cancel' || stopReason === 'cancelled' || undefined;
        dispatch({ type: 'done', nodeId, assistantId, completedAt, aborted });
        onTurnEnd?.('done', nodeId);
        onStreamComplete?.();
        onTerminal?.();
      },
      onError: (message, incomingAssistantId, incomingTurnId, code) => {
        rememberEnvelope(incomingAssistantId, incomingTurnId);
        if (assistantId) dispatch({ type: 'error', nodeId, assistantId, message, errorKind: code });
        onTurnEnd?.('error', nodeId);
        onTerminal?.();
      },
    };
    return {
      ...base,
      ...extraHandlers,
      // Delivery identity and terminal orchestration are transport invariants;
      // shared feature handlers may not bypass their exactly-once gate.
      onEnvelope: base.onEnvelope,
      onTurnStart: base.onTurnStart,
      onDone: base.onDone,
      onError: base.onError,
    };
  };

  return {
    nodeId,
    chatId,
    createHandlers: makeHandlers,
  };
}
