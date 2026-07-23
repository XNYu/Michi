import React from 'react';
import type { ChatNodeState } from '../../state/chatTypes';
import type { Prefs } from '../../state/prefs';
import { visibleMessageText } from '../../state/assistantBlocks';
import { FollowUpRow } from '../FollowUpRow';
import { DARK_PALETTES } from './tokens';
import { MessageBlock, NodeUserInputContext } from './MessageBlock';
import { DiffReceipt } from './DiffReceipt';
import { StreamActivityIndicator } from './StreamActivityIndicator';
import type { ChildAnchor } from '../../state/branchAnchors';
import { countRender } from '../../services/renderCounters';
import { shouldShowFollowUps } from '../../state/followUpsVisibility';

interface PaneMessageListProps {
  node: ChatNodeState;
  mergeSourceLabels?: readonly string[];
  prefs: Prefs;
  contentStyle: React.CSSProperties;
  streaming: boolean;
  viewportHeight: number;
  onRetryTurn: (userMessageIndex: number) => void;
  onEditUserMessage: (text: string) => void;
  onContinueFollowUp: (question: string) => void;
  onBranchFollowUp: (question: string) => void;
  followUpsDisabled?: boolean;
  editingMessageId?: string | null;
  onEditStart?: (messageId: string) => void;
  onEditSave?: (messageIndex: number, newText: string) => void;
  onEditCancel?: () => void;
  /**
   * Map from assistant message id → child branch anchors forked from that
   * message. Built by buildAnchorMap() in TPane and passed down so this
   * component stays pure/testable.
   *
   * v1: all anchors render as BranchAnchorRow turn markers after the anchored
   * message. Quote-anchored underlines (BranchQuoteUnderline) are deferred to
   * a future iteration because integrating into MarkdownContent's render tree
   * safely requires a dedicated pass.
   */
  anchorsByMessage?: Map<string, ChildAnchor[]>;
  /** Called when the user clicks a child-branch title. */
  onOpenBranch?: (childNodeId: string) => void;
  /** Called when user clicks the per-message branch icon. */
  onBranchFromMessage?: (messageId: string) => void;
  /** Lowercased context names for highlighting @mentions in user messages. */
  contextNames?: ReadonlySet<string>;
  /** Called when user clicks a mention chip. */
  onMentionClick?: (name: string, kind: string, nodeId?: string) => void;
}

function PaneMessageListInner({
  node,
  mergeSourceLabels,
  prefs,
  contentStyle,
  streaming,
  viewportHeight,
  onRetryTurn,
  onEditUserMessage,
  onContinueFollowUp,
  onBranchFollowUp,
  followUpsDisabled = false,
  anchorsByMessage,
  onOpenBranch,
  onBranchFromMessage,
  editingMessageId,
  onEditStart,
  onEditSave,
  onEditCancel,
  contextNames,
  onMentionClick,
}: PaneMessageListProps) {
  const tailAssistantId = React.useMemo(() => {
    // Backward scan (no array copy) — this recomputes on every stream chunk
    // since the reducer hands a fresh messages array each chunk, so the old
    // [...messages].reverse().find() copied+reversed the whole conversation
    // many times per second.
    for (let i = node.messages.length - 1; i >= 0; i--) {
      if (node.messages[i].role === 'assistant') return node.messages[i].id;
    }
    return undefined;
  }, [node.messages]);
  const [tailAnswerSmoothing, setTailAnswerSmoothing] = React.useState(false);
  const handleTailSmoothingChange = React.useCallback((isSmoothing: boolean) => {
    setTailAnswerSmoothing(isSmoothing);
  }, []);
  const showFollowUps = node.messagesLoaded === false
    ? false
    : node.visibleResponseComplete
    ? node.followUps.length > 0
    : shouldShowFollowUps(
        node.followUps.length,
        tailAnswerSmoothing,
        !!node.followUpsGenerating,
      );

  countRender('PaneMessageList', node.nodeId, {
    status: node.status,
    messages: node.messages.length,
    followUps: node.followUps.length,
  });
  const isDark = DARK_PALETTES.has(prefs.terminalPalette);

  // Placeholder state: node has messages in the DB but they haven't loaded yet.
  // Show a subtle loading indicator instead of bare follow-ups.
  const isPlaceholder = node.messagesLoaded === false && (node.messageCount ?? 0) > 0;

  const userInputCtx = React.useMemo(
    () => ({ userInput: node.pendingUserInput, nodeId: node.nodeId }),
    [node.pendingUserInput, node.nodeId],
  );

  return (
    <NodeUserInputContext.Provider value={userInputCtx}>
    <div style={contentStyle}>
      <MergeSourcesNotice node={node} sourceLabels={mergeSourceLabels} />

      {isPlaceholder && <MessagesLoadingPlaceholder />}
      {node.messages.map((m, i) => {
        const isUser = m.role === 'user';
        let retryText: string | undefined;
        if (isUser) {
          retryText = m.text;
        } else {
          for (let j = i - 1; j >= 0; j--) {
            if (node.messages[j].role === 'user') {
              retryText = node.messages[j].text;
              break;
            }
          }
        }

        const isErrorTail =
          !isUser &&
          i === node.messages.length - 1 &&
          node.status === 'error';
        const isStreamingTail =
          !isUser &&
          i === node.messages.length - 1 &&
          node.status === 'streaming';

        // Collect turn-marker anchors for this message. They are passed into
        // MessageBlock and rendered between the message body and the
        // MessageActions row, so the marker sits closer to the message
        // content than the action chrome.
        const anchorsForMsg = anchorsByMessage?.get(m.id) ?? [];

        const editingIdx = editingMessageId
          ? node.messages.findIndex((msg) => msg.id === editingMessageId)
          : -1;
        const isDownstream = editingIdx >= 0 && i > editingIdx;

        return (
          <React.Fragment key={m.id}>
            <div
              data-msg-id={m.id}
              data-streaming-tail={isStreamingTail ? 'true' : undefined}
              className="terminal-message-frame"
              style={isDownstream ? { opacity: 0.38, filter: 'saturate(0.5)', transition: 'opacity 0.2s' } : undefined}
            >
              <MessageBlock
                m={m}
                index={i}
                isDark={isDark}
                editing={m.id === editingMessageId}
                onEditSave={m.id === editingMessageId ? (newText) => onEditSave?.(i, newText) : undefined}
                onEditCancel={m.id === editingMessageId ? onEditCancel : undefined}
                onCopy={() => {
                  if (typeof navigator !== 'undefined' && navigator.clipboard) {
                    const copyText = visibleMessageText(m);
                    void navigator.clipboard.writeText(copyText);
                  }
                }}
                onRetry={
                  streaming || !retryText
                    ? undefined
                    : () => {
                        const userIdx = isUser
                          ? i
                          : node.messages.slice(0, i).findLastIndex((msg) => msg.role === 'user');
                        if (userIdx < 0) return;
                        onRetryTurn(userIdx);
                      }
                }
                onEdit={
                  isUser && !streaming && !editingMessageId
                    ? () => onEditStart?.(m.id)
                    : undefined
                }
                onBranch={
                  !streaming && onBranchFromMessage
                    ? () => onBranchFromMessage(m.id)
                    : undefined
                }
                isErrorTail={isErrorTail}
                errorMessage={isErrorTail ? node.error : undefined}
                showThoughts={prefs.showThoughts}
                density={prefs.terminalDensity}
                fontFamily={{
                  sans: 'var(--ui-font)',
                  serif: 'Georgia, "Times New Roman", serif',
                  mono: 'var(--ui-font)',
                }[prefs.fontFamily]}
                usageInfo={
                  !isUser && node.status === 'idle' && node.usageSummary && i === node.messages.length - 1
                    ? {
                        durationMs: node.usageSummary.turnDurationMs,
                        credits: node.usageSummary.totalCredits,
                      }
                    : undefined
                }
                subagents={node.subagents}
                runtimeId={node.runtimeId}
                turnAnchors={anchorsForMsg.length > 0 ? anchorsForMsg : undefined}
                onOpenBranch={onOpenBranch}
                contextNames={contextNames}
                onMentionClick={onMentionClick}
                onVisibleSmoothingChange={
                  !isUser && m.id === tailAssistantId ? handleTailSmoothingChange : undefined
                }
              />
              {!isUser &&
                node.status !== 'streaming' &&
                i === node.messages.length - 1 && (
                  <DiffReceipt message={m} workspaceId={node.projectId} />
                )}
              {/* The subagent roster is node-level transient state cleared at
                  every turn start, so it always belongs to the tail assistant
                  message that spawned the agents. Render it inline within that
                  turn's frame (not detached at the bottom of the conversation). */}
              {!isUser && m.id === tailAssistantId && <SubagentStatus node={node} />}
            </div>
          </React.Fragment>
        );
      })}

      <StreamActivityIndicator node={node} />
      <TailSpacer node={node} viewportHeight={viewportHeight} />
      <McpServerError node={node} />
      <FollowUpsSection
        node={node}
        prefs={prefs}
        onContinueFollowUp={onContinueFollowUp}
        onBranchFollowUp={onBranchFollowUp}
        disabled={followUpsDisabled}
        showFollowUps={showFollowUps}
      />
    </div>
    </NodeUserInputContext.Provider>
  );
}

export const PaneMessageList = React.memo(PaneMessageListInner, (prev, next) =>
  prev.node === next.node &&
  prev.mergeSourceLabels === next.mergeSourceLabels &&
  prev.prefs === next.prefs &&
  prev.contentStyle === next.contentStyle &&
  prev.streaming === next.streaming &&
  prev.viewportHeight === next.viewportHeight &&
  prev.onRetryTurn === next.onRetryTurn &&
  prev.onEditUserMessage === next.onEditUserMessage &&
  prev.onContinueFollowUp === next.onContinueFollowUp &&
  prev.onBranchFollowUp === next.onBranchFollowUp &&
  (prev.followUpsDisabled ?? false) === (next.followUpsDisabled ?? false) &&
  prev.anchorsByMessage === next.anchorsByMessage &&
  prev.onOpenBranch === next.onOpenBranch &&
  prev.onBranchFromMessage === next.onBranchFromMessage &&
  prev.contextNames === next.contextNames &&
  prev.onMentionClick === next.onMentionClick &&
  prev.editingMessageId === next.editingMessageId &&
  prev.onEditStart === next.onEditStart &&
  prev.onEditSave === next.onEditSave &&
  prev.onEditCancel === next.onEditCancel,
);

PaneMessageList.displayName = 'PaneMessageList';

function MessagesLoadingPlaceholder() {
  return (
    <div
      style={{
        padding: '16px 0',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      {[0, 1].map((i) => (
        <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div
            className="t-skeleton-pulse"
            style={{
              height: 12,
              width: i === 0 ? '60%' : '80%',
              borderRadius: 3,
              background: 'var(--term-line)',
              opacity: 0.5,
            }}
          />
          <div
            className="t-skeleton-pulse"
            style={{
              height: 12,
              width: i === 0 ? '90%' : '45%',
              borderRadius: 3,
              background: 'var(--term-line)',
              opacity: 0.4,
            }}
          />
        </div>
      ))}
    </div>
  );
}

function MergeSourcesNotice({
  node,
  sourceLabels,
}: {
  node: ChatNodeState;
  sourceLabels?: readonly string[];
}) {
  if ((node.mergeSources?.length ?? 0) === 0) return null;
  const sourceIds = [
    ...(node.parentNodeId ? [node.parentNodeId] : []),
    ...(node.mergeSources ?? []),
  ];
  const allSources = sourceLabels ?? sourceIds;

  return (
    <div className="t-pre-block tone-mauve" style={{ margin: '0 0 12px 0' }}>
      <div className="t-pre-block-col">
        <div className="t-pre-block-cap">
          synthesizing <b>{allSources.length}</b> threads
        </div>
        {allSources.map((label, i) => {
          return (
            <div key={`${label}-${i}`} className="t-pre-block-quoted" title={label}>
              ⧉ {label}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SubagentStatus({ node }: { node: ChatNodeState }) {
  if (!node.subagents || node.subagents.length === 0) return null;
  const workingCount = node.subagents.filter((s) => s.status === 'working').length;

  return (
    <div
      style={{
        margin: '8px 0',
        padding: '8px 10px',
        fontSize: 11,
        border: '1px solid var(--term-line)',
        borderRadius: 4,
        fontFamily: 'var(--ui-font)',
      }}
    >
      <div style={{ color: 'var(--term-mid)', marginBottom: 4 }}>
        {workingCount > 0
          ? `⚡ Orchestrating ${workingCount} agent${workingCount > 1 ? 's' : ''}`
          : '✓ Agents completed'}
      </div>
      {node.subagents.map((s) => (
        <div
          key={s.sessionId}
          style={{
            display: 'flex',
            gap: 6,
            alignItems: 'center',
            color: s.status === 'working' ? 'var(--term-fg)' : 'var(--term-muted)',
          }}
        >
          <span>{s.status === 'working' ? '●' : '✓'}</span>
          <span>{s.agentName}</span>
          <span style={{ color: 'var(--term-faint)' }}>{s.sessionName}</span>
          <span style={{ marginLeft: 'auto', color: 'var(--term-faint)' }}>
            {s.status === 'working' ? (s.currentTool || s.statusMessage || 'Running') : 'Done'}
          </span>
        </div>
      ))}
    </div>
  );
}

function TailSpacer({ node, viewportHeight }: { node: ChatNodeState; viewportHeight: number }) {
  if (node.status !== 'streaming') return null;
  const last = node.messages[node.messages.length - 1];
  if (!last || last.role !== 'assistant') return null;
  if (node.followUpsGenerating || node.followUps.length > 0) return null;
  const replyChars = (last.blocks ?? []).reduce(
    (n, b) => n + (b.kind === 'answer' ? (b.rawText?.length ?? 0) : 0),
    0,
  );
  if (replyChars > 1500) return null;
  return <div aria-hidden style={{ height: viewportHeight * 0.7, flexShrink: 0 }} />;
}

function McpServerError({ node }: { node: ChatNodeState }) {
  if (!node.mcpServerError) return null;

  return (
    <div
      style={{
        margin: '8px 0',
        padding: '6px 10px',
        fontSize: 11,
        color: 'var(--term-danger)',
        border: '1px solid var(--term-danger)',
        borderRadius: 4,
        opacity: 0.8,
      }}
    >
      ⚠ MCP server &quot;{node.mcpServerError.serverName}&quot; failed: {node.mcpServerError.error}
    </div>
  );
}

function FollowUpsSection({
  node,
  prefs,
  onContinueFollowUp,
  onBranchFollowUp,
  disabled,
  showFollowUps,
}: {
  node: ChatNodeState;
  prefs: Prefs;
  onContinueFollowUp: (question: string) => void;
  onBranchFollowUp: (question: string) => void;
  disabled: boolean;
  showFollowUps: boolean;
}) {
  if (!prefs.enableFollowUps) return null;

  if (node.status === 'streaming' && node.followUpsGenerating && node.followUps.length === 0) {
    return (
      <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px dashed var(--term-line)' }}>
        <div
          style={{
            fontSize: 10,
            color: 'var(--term-muted)',
            letterSpacing: '.14em',
            marginBottom: 8,
            fontFamily: 'var(--ui-font)',
          }}
        >
          ▸ FOLLOW-UPS
        </div>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="t-followup-skeleton"
            style={{
              display: 'flex',
              gap: 10,
              padding: '8px 10px',
              marginBottom: 4,
              fontFamily: 'var(--ui-font)',
              fontSize: 12.5,
              color: 'var(--term-faint)',
              border: '1px dashed var(--term-line)',
              alignItems: 'center',
            }}
          >
            <span style={{ color: 'var(--term-accent)', opacity: 0.5, fontFamily: 'var(--ui-font)' }}>
              {i + 1}.
            </span>
            <span style={{ flex: 1, opacity: 0.6 }}>
              {i === 0 ? 'generating follow-ups' : ''}
              {i === 0 && (
                <span className="t-followup-dots" aria-hidden>…</span>
              )}
            </span>
          </div>
        ))}
      </div>
    );
  }

  if (!showFollowUps) return null;

  return (
    <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px dashed var(--term-line)' }}>
      <div
        style={{
          fontSize: 10,
          color: 'var(--term-muted)',
          letterSpacing: '.14em',
          marginBottom: 8,
          fontFamily: 'var(--ui-font)',
        }}
      >
        ▸ FOLLOW-UPS
      </div>
      {node.followUps.slice(0, 3).map((q, i) => (
        <FollowUpRow
          key={i}
          index={i}
          question={q}
          disabled={disabled || (node.status === 'streaming' && !node.visibleResponseComplete)}
          onContinue={onContinueFollowUp}
          onBranch={onBranchFollowUp}
        />
      ))}
    </div>
  );
}
