import { streamMessage } from '../services/api';
import type { StreamHandlers } from '../services/api';
import {
  parseInlineFollowUpSentinel,
  parseInlineFollowUpsSentinel,
} from './assistantParsing';
import type { ChatAction } from './chatTypes';

type Ref<T> = { current: T };

export type TurnEndReason = 'done' | 'cancel' | 'error';

// Sentinel prefixes the inline metadata side-effect dispatcher recognises.
// Used both here (for completed-sentinel detection during streaming) and in
// assistantParsing.ts's stripSentinelsStreamingSafe (visible projection).
const SENTINEL_PREFIXES = ['[TITLE:', '[FOLLOW-UP'];

function couldStillBeSentinel(buf: string): boolean {
  const upper = buf.toUpperCase();
  return SENTINEL_PREFIXES.some(
    (p) => (upper.length <= p.length ? p.startsWith(upper) : upper.startsWith(p)),
  );
}

interface RunChatStreamOptions {
  prompt: string;
  nodeId: string;
  assistantId: string;
  dispatch: (action: ChatAction) => void;
  // Kept in the type for backward-compat with the chatStore caller. The
  // runner no longer owns a side buffer; chunk/thought events go straight to
  // the reducer's assistant blocks.
  assistantTextBufs: Ref<Record<string, string>>;
  cancelFns: Ref<Record<string, () => void>>;
  ownerToken?: string;
  displayText?: string;
  userMetadata?: {
    quotedText?: string;
    attachments?: Array<{ name: string; absPath: string }>;
    comments?: Array<Record<string, unknown>>;
  };
  extraHandlers?: Omit<Partial<StreamHandlers>, 'onTurnStart' | 'onDone' | 'onAborted' | 'onError'>;
  /** Fires after finishAsDone completes — safe place for side-effects like notifications. */
  onStreamComplete?: () => void;
  /**
   * Fires from each terminal path (done / cancel / error) immediately after
   * the corresponding dispatch + cleanup. Used by the chat store to flush a
   * queued message on natural turn end / cancel and to mark the queue errored
   * on stream error.
   */
  onTurnEnd?: (reason: TurnEndReason, nodeId: string) => void;
}

export function runChatStream({
  prompt,
  nodeId,
  assistantId,
  dispatch,
  cancelFns,
  ownerToken,
  displayText,
  userMetadata,
  extraHandlers,
  onStreamComplete,
  onTurnEnd,
}: RunChatStreamOptions): () => void {
  // ── Sentinel side-effect dispatcher ──
  // The runner is now a thin pipe: every SSE text chunk goes straight to the
  // reducer as an answer block append. Assistant blocks are the source of
  // truth.
  //
  // The PREAMBLE asks the agent to wrap metadata in `[TITLE: ...]` and
  // `[FOLLOW-UP n/3: ...]` sentinels. We still want to react to those
  // mid-stream — set the sidebar title as soon as it's known, populate
  // follow-ups incrementally — so we walk the raw stream char-by-char,
  // accumulate `[...]` segments, and dispatch a side-effect action when a
  // sentinel completes. We do NOT modify or hide the raw text here; visible
  // projection (sentinel stripping) is render-time work.
  let bracketHold = '';
  let titleDispatched = false;
  let visibleResponseCompleteDispatched = false;
  let currentAssistantId = assistantId;
  let currentTurnId = '';
  let lastAcceptedTurnId = '';
  let lastAcceptedSeq = -1;
  let streamCancel: (() => void) | null = null;
  const streamedFollowUps: string[] = [];
  const MAX_BRACKET_HOLD = 4096; // safety cap for malformed / unclosed brackets

  const dispatchFollowUps = () => {
    const followUps = streamedFollowUps
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 3);
    if (followUps.length > 0) {
      dispatch({ type: 'set-follow-ups', nodeId, followUps });
    }
    const completeSet = [0, 1, 2].every(
      (index) => streamedFollowUps[index]?.trim().length > 0,
    );
    if (completeSet && !visibleResponseCompleteDispatched) {
      visibleResponseCompleteDispatched = true;
      dispatch({
        type: 'visible-response-complete',
        nodeId,
        assistantId: currentAssistantId,
      });
    }
  };

  const handleSentinelCompletion = (segment: string): void => {
    const upper = segment.toUpperCase();
    if (upper.startsWith('[TITLE:')) {
      if (!titleDispatched) {
        const title = segment.slice('[TITLE:'.length, -1).trim();
        if (title) {
          dispatch({ type: 'set-title', nodeId, title });
          titleDispatched = true;
        }
      }
      return;
    }
    const single = parseInlineFollowUpSentinel(segment);
    if (single) {
      streamedFollowUps[single.index] = single.followUp;
      dispatchFollowUps();
      return;
    }
    const legacy = parseInlineFollowUpsSentinel(segment);
    if (legacy.length > 0) {
      streamedFollowUps.splice(0, streamedFollowUps.length, ...legacy);
      dispatchFollowUps();
    }
  };

  const cleanup = () => {
    if (streamCancel && cancelFns.current[nodeId] === streamCancel) {
      delete cancelFns.current[nodeId];
    }
  };

  const trackSeq = (seq?: number, turnId?: string): void => {
    if (turnId) currentTurnId = turnId;
  };

  const handlers: StreamHandlers = {
    onEnvelope: (envelope) => {
      if (envelope.turnId) currentTurnId = envelope.turnId;
      if (typeof envelope.seq !== 'number' || !envelope.turnId) return true;
      if (lastAcceptedTurnId === envelope.turnId && envelope.seq <= lastAcceptedSeq) return false;
      lastAcceptedTurnId = envelope.turnId;
      lastAcceptedSeq = envelope.seq;
      dispatch({ type: 'apply-seq', nodeId, turnId: envelope.turnId, seq: envelope.seq });
      return true;
    },
    onTurnStart: (data) => {
      if (data.assistantId && data.assistantId !== currentAssistantId) {
        dispatch({
          type: 'realign-assistant-id',
          nodeId,
          fromId: currentAssistantId,
          toId: data.assistantId,
        });
        currentAssistantId = data.assistantId;
      } else if (data.assistantId) {
        currentAssistantId = data.assistantId;
      }
      // The server has committed the provisional user/assistant rows before
      // this frame. It is now safe to ack a recovered agent-spawn outbox item.
      dispatch({ type: 'spawn-prompt-started', nodeId });
      trackSeq(env.seq, data.turnId);
    },
    onChunk: (text) => {
      // Forward raw chunk to reducer immediately as block-first assistant data.
      dispatch({ type: 'chunk', nodeId, assistantId: currentAssistantId, text });

      // Walk the raw chunk char-by-char for sentinel side effects only. The
      // text itself is already on its way to the reducer; nothing here
      // affects what gets stored or rendered.
      for (const ch of text) {
        if (bracketHold || ch === '[') {
          bracketHold += ch;
          if (ch === ']') {
            const buf = bracketHold;
            bracketHold = '';
            handleSentinelCompletion(buf);
          } else if (!couldStillBeSentinel(bracketHold) || bracketHold.length > MAX_BRACKET_HOLD) {
            // Prefix can't grow into a sentinel, or runaway bracket — abandon
            // the hold. The text is already in reducer state from the dispatch above;
            // we just stop treating it as a sentinel candidate.
            bracketHold = '';
          }
        }
      }
    },
    onThought: (text) => dispatch({ type: 'thought', nodeId, assistantId: currentAssistantId, text }),
    onPlan: (entries) => dispatch({ type: 'plan', nodeId, assistantId: currentAssistantId, entries }),
    onToolCall: (toolCall) => {
      dispatch({
        type: 'tool-call',
        nodeId,
        assistantId: currentAssistantId,
        tool: {
          id: toolCall.toolCallId || `t-${Date.now()}`,
          title: toolCall.title,
          status: toolCall.status,
          kind: toolCall.kind,
          detail: toolCall.detail,
          inputJson: toolCall.inputJson,
        },
      });
    },
    onToolCallUpdate: (toolCall) => {
      dispatch({
        type: 'tool-call-update',
        nodeId,
        assistantId: currentAssistantId,
        tool: {
          id: toolCall.toolCallId,
          title: toolCall.title,
          status: toolCall.status,
          kind: toolCall.kind,
          detail: toolCall.detail,
          output: toolCall.output,
        },
      });
    },
    onImage: (data) => {
      // Must use currentAssistantId (not the outer `assistantId`): onTurnStart
      // can retarget the assistant message id mid-stream, and the image block
      // must land on the live message — same as every other dispatch here.
      // workspaceId is derived reducer-side from the node's projectId.
      dispatch({
        type: 'image-block',
        nodeId,
        assistantId: currentAssistantId,
        path: data.path,
        caption: data.caption,
        mimeType: data.mimeType,
        size: data.size,
      });
    },
    onHeartbeat: (idleMs) => dispatch({ type: 'heartbeat', nodeId, idleMs }),
    onTitle: (title) => dispatch({ type: 'set-title', nodeId, title }),
    onBranchOverview: (overview, seq, _assistantId, turnId) => {
      trackSeq(seq, turnId);
      dispatch({ type: 'set-branch-overview', nodeId, overview, assistantId: currentAssistantId });
    },
    onFollowUps: (followUps) => dispatch({ type: 'set-follow-ups', nodeId, followUps }),
    onFollowUpsStatus: (status) =>
      dispatch({ type: 'follow-ups-status', nodeId, status }),
    onCommands: (commands) => dispatch({ type: 'set-commands', nodeId, commands }),
    onSubagentListUpdate: (data) =>
      dispatch({ type: 'subagent-list-update', nodeId, subagents: data.subagents }),
    onSubagentToolActivity: (data) =>
      dispatch({ type: 'subagent-tool-activity', nodeId, subagentSessionId: data.subagentSessionId, title: data.title, status: data.status }),
    onContextUsage: (data) =>
      dispatch({ type: 'context-usage', nodeId, contextUsagePercentage: data.contextUsagePercentage }),
    onUsageSummary: (data) =>
      dispatch({ type: 'usage-summary', nodeId, contextUsagePercentage: data.contextUsagePercentage, totalCredits: data.totalCredits, turnDurationMs: data.turnDurationMs }),
    onMcpServerError: (data) =>
      dispatch({ type: 'mcp-server-error', nodeId, serverName: data.serverName, error: data.error }),
    onDone: (stopReason, _assistantId, turnId, persisted) => {
      if (turnId) currentTurnId = turnId;
      if (persisted === false) {
        dispatch({
          type: 'error',
          nodeId,
          assistantId: currentAssistantId,
          message: 'The turn finished but the backend did not confirm durable persistence.',
        });
        cleanup();
        onTurnEnd?.('error', nodeId);
        return;
      }
      if (stopReason === 'error') {
        dispatch({
          type: 'error',
          nodeId,
          assistantId: currentAssistantId,
          message: 'Agent process exited before completing the turn.',
        });
        cleanup();
        onTurnEnd?.('error', nodeId);
        return;
      }
      // Reducer extracts metadata from assistant answer blocks.
      dispatch({ type: 'done', nodeId, assistantId: currentAssistantId });
      cleanup();
      onTurnEnd?.('done', nodeId);
      onStreamComplete?.();
    },
    onAborted: () => {
      dispatch({ type: 'done', nodeId, assistantId: currentAssistantId });
      cleanup();
      onTurnEnd?.('cancel', nodeId);
      // Note: intentionally NOT calling onStreamComplete for aborted streams
    },
    onError: (message) => {
      dispatch({ type: 'error', nodeId, assistantId: currentAssistantId, message });
      cleanup();
      onTurnEnd?.('error', nodeId);
    },
    ...extraHandlers,
  };

  streamCancel = streamMessage(nodeId, prompt, handlers, ownerToken, {
    displayText,
    userMetadata,
  });
  return streamCancel;
}
