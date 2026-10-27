import React from 'react';
import { ChevronDown, LoaderCircle } from 'lucide-react';
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
import { usageIsUnverifiable } from 'michi-shared';
import { useOptionalAgentDomain } from '../../state/agentDomain';
import { useOptionalChatActions } from '../../state/chatStore';
import { backendConnectionIdForWorkspace } from '../../config/backendConnections';
import { AgentRunCardGroup } from './agentRuns/AgentRunCard';
import { MessageSubagents } from './subagents/SubagentRoster';
import { MessageWorkflowRuns } from './workflows/MessageWorkflowRuns';
import { useWorkflowPlacementsForNode, workflowRunKey, type WorkflowPlacement } from '../../state/workflowDomain';
import { latestAssistantMessageId, messageSubagentRoster, workflowMessageResolver } from '../../state/backgroundWork';
import { unclaimedSubagents } from './subagents/subagentPresentation';
import { BackgroundWorkNodeContext, openBackgroundWork } from './backgroundWork/backgroundWorkEvents';
import { selectParentRunCards } from './agentRuns/agentRunSelectors';
import { agentResourceKey, type AgentResourceIdentity } from '../../state/agentIdentity';
import { useSourceReference } from '../../state/sourceNav/sourceNav';
import { SourceReferenceMark } from './source/SourceReferenceMark';

function useOptionalAgentRunUi() {
  const domain = useOptionalAgentDomain();
  const actions = useOptionalChatActions();
  // PaneMessageList also supports provider-free render/perf unit tests.
  return domain && actions ? { domain, actions } : null;
}

interface PaneMessageListProps {
  node: ChatNodeState;
  mergeSourceLabels?: readonly string[];
  prefs: Prefs;
  contentStyle: React.CSSProperties;
  streaming: boolean;
  viewportHeight: number;
  bottomClearance?: number;
  onRetryTurn: (userMessageIndex: number) => void;
  onRunAgain?: (userMessageIndex: number) => void;
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
  /** Probe backend connectivity for the connection/auth error-tail button. */
  onTestConnection?: () => Promise<{ ok: boolean; detail?: string }>;
}

function PaneMessageListInner({
  node,
  mergeSourceLabels,
  prefs,
  contentStyle,
  streaming,
  viewportHeight,
  bottomClearance = 0,
  onRetryTurn,
  onRunAgain,
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
  onTestConnection,
}: PaneMessageListProps) {
  const agentRunUi = useOptionalAgentRunUi();
  const sourceReference = useSourceReference(node.nodeId);
  const referenceLabel = sourceReference?.label ?? null;
  const referenceMark = React.useMemo(() => <SourceReferenceMark label={referenceLabel} />, [referenceLabel]);
  const nodeWorkflowRuns = useWorkflowPlacementsForNode(node.nodeId);
  const nodeId = node.nodeId;
  // "Open →" shows the run in the Background work drawer. Stable across
  // stream chunks, so memoized workflow cards skip them.
  const openWorkflowRun = React.useCallback((identity: AgentResourceIdentity) => {
    openBackgroundWork({ nodeId, focus: { kind: 'workflow', runKey: workflowRunKey(identity) } });
  }, [nodeId]);
  const backendConnectionId = backendConnectionIdForWorkspace(node.projectId);
  // Recomputes on every stream chunk (the reducer hands a fresh messages
  // array each chunk); the helper scans backward without copying.
  const tailAssistantId = React.useMemo(() => latestAssistantMessageId(node.messages), [node.messages]);
  // Workflow runs this chat launched, attached to the message whose tool
  // call launched them. A run without a known launcher goes to the last
  // assistant message that existed when it started, so it stays in place
  // as the conversation grows.
  // The Background work drawer applies the same placement (history rule).
  const workflowsByMessage = React.useMemo(() => {
    const byMessage = new Map<string, WorkflowPlacement[]>();
    if (nodeWorkflowRuns.length === 0) return byMessage;
    const messageFor = workflowMessageResolver(node.messages);
    for (const placement of nodeWorkflowRuns) {
      const messageId = messageFor(placement);
      if (!messageId) continue;
      const list = byMessage.get(messageId) ?? [];
      list.push(placement);
      byMessage.set(messageId, list);
    }
    return byMessage;
  }, [nodeWorkflowRuns, node.messages]);
  const [tailAnswerSmoothing, setTailAnswerSmoothing] = React.useState(false);
  const handleTailSmoothingChange = React.useCallback((isSmoothing: boolean) => {
    setTailAnswerSmoothing(isSmoothing);
  }, []);
  // Suppress follow-ups while the turn is still running. node.status is
  // persisted in the DB and survives hydration, unlike message-level
  // m.streaming which mapMessageRow() resets to false on load.
  const turnStillRunning = node.status === 'streaming';

  const showFollowUps = node.messagesLoaded === false
    ? false
    : turnStillRunning
    ? false
    : shouldShowFollowUps(
        node.followUps.length,
        tailAnswerSmoothing,
        // The runtime boundary only marks received text as complete. Its
        // typewriter backlog must finish before follow-ups appear, including
        // while a hidden metadata tail drains and after the final done event.
        !!node.followUpsGenerating && !node.visibleResponseComplete,
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
  // Messages before this cut were copied from the parent chain by extraction.
  const inheritedCount = Math.min(node.inheritedMessageCount ?? 0, node.messages.length);

  const userInputCtx = React.useMemo(
    () => ({ userInput: node.pendingUserInput, nodeId: node.nodeId }),
    [node.pendingUserInput, node.nodeId],
  );

  return (
    <NodeUserInputContext.Provider value={userInputCtx}>
    <BackgroundWorkNodeContext.Provider value={nodeId}>
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

        const usage = m.usageSummary ?? (i === node.messages.length - 1 ? node.usageSummary : undefined);
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
        const parentRuns = agentRunUi && !isUser
          ? selectParentRunCards(Object.values(agentRunUi.domain.state.runs), backendConnectionId, m.id)
          : [];
        // The durable roster lives on the message that spawned the agents.
        // Messages saved before rosters were persisted fall back to the live
        // node roster, which only ever belongs to the tail turn.
        const roster = messageSubagentRoster(node, m, tailAssistantId);

        return (
          <React.Fragment key={m.id}>
            {i === inheritedCount && inheritedCount > 0 && (
              <div
                className="t-inherited-divider"
                role="separator"
                aria-label={`Inherited history: ${inheritedCount} messages`}
                data-inherited-count={inheritedCount}
                title={node.forkedFromNodeId
                  ? `Copied from ${node.forkedFromNodeId} when this thread was extracted.`
                  : 'Copied from the parent conversation when this thread was extracted.'}
              >
                <span>Inherited history · {inheritedCount} messages</span>
              </div>
            )}
            <div
              data-msg-id={m.id}
              data-streaming-tail={isStreamingTail ? 'true' : undefined}
              data-source-referenced={sourceReference?.messageId === m.id ? 'true' : undefined}
              className="terminal-message-frame"
              style={isDownstream ? { opacity: 0.38, filter: 'saturate(0.5)', transition: 'opacity var(--t-enter)' } : undefined}
            >
              <MessageBlock
                m={m}
                highlight={sourceReference?.messageId === m.id ? referenceMark : undefined}
                workspaceId={node.projectId}
                backendConnectionId={backendConnectionId}
                index={i}
                isDark={isDark}
                editing={m.id === editingMessageId}
                hideActions={isStreamingTail}
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
                errorKind={isErrorTail ? node.errorKind : undefined}
                errorRecovery={isErrorTail ? node.errorRecovery : undefined}
                onRunAgain={isErrorTail && onRunAgain && !streaming ? () => {
                  const userIdx = node.messages.slice(0, i).findLastIndex((msg) => msg.role === 'user');
                  if (userIdx >= 0) onRunAgain(userIdx);
                } : undefined}
                onTestConnection={isErrorTail ? onTestConnection : undefined}
                showThoughts={prefs.showThoughts}
                density={prefs.terminalDensity}
                fontFamily={{
                  sans: 'var(--ui-font)',
                  serif: 'Georgia, "Times New Roman", serif',
                  mono: 'var(--ui-font)',
                }[prefs.fontFamily]}
                usageInfo={
                  !isUser && !m.streaming && usage
                    ? (usage.source === 'unverifiable' || (!usage.charge && usageIsUnverifiable(usage.source, usage.totalCredits)))
                      ? { durationMs: usage.turnDurationMs, unverifiable: true }
                      : {
                          durationMs: usage.turnDurationMs,
                          credits: usage.charge ? undefined : usage.totalCredits,
                          charge: usage.charge,
                          totalTokens: usage.totalTokens,
                          inputTokens: usage.inputTokens,
                          cachedInputTokens: usage.cachedInputTokens,
                          outputTokens: usage.outputTokens,
                          reasoningOutputTokens: usage.reasoningOutputTokens,
                          contextUsagePercentage: node.contextUsagePercentage,
                        }
                    : undefined
                }
                subagents={roster}
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
              {/* Agents no delegation chip claims (Crew runs, legacy rosters)
                  render inline within the turn that spawned them. */}
              {roster && <MessageSubagents subagents={unclaimedSubagents(roster, m.toolCalls)} />}
              {!isUser && workflowsByMessage.get(m.id)?.length ? (
                <MessageWorkflowRuns runs={workflowsByMessage.get(m.id)!} onOpen={openWorkflowRun} />
              ) : null}
              {parentRuns.length > 0 && (
                <div style={{ margin: '8px 0 2px' }}>
                  <AgentRunCardGroup
                    runs={parentRuns}
                    onOpen={(identity) => {
                      const resource = agentRunUi?.domain.state.runs[agentResourceKey(identity)];
                      agentRunUi?.actions.openAgentRunPane(
                        identity,
                        node.projectId,
                        resource?.value.effectiveDefinition.name,
                      );
                    }}
                    onOpenAll={(identities) => {
                      for (const identity of identities) {
                        const resource = agentRunUi?.domain.state.runs[agentResourceKey(identity)];
                        agentRunUi?.actions.openAgentRunPane(
                          identity,
                          node.projectId,
                          resource?.value.effectiveDefinition.name,
                        );
                      }
                    }}
                  />
                </div>
              )}
            </div>
          </React.Fragment>
        );
      })}

      {inheritedCount > 0 && inheritedCount === node.messages.length && (
        <div
          className="t-inherited-divider"
          role="separator"
          aria-label={`Inherited history: ${inheritedCount} messages`}
          data-inherited-count={inheritedCount}
          title={node.forkedFromNodeId
            ? `Copied from ${node.forkedFromNodeId} when this thread was extracted.`
            : 'Copied from the parent conversation when this thread was extracted.'}
        >
          <span>Inherited history · {inheritedCount} messages</span>
        </div>
      )}

      <StreamActivityIndicator node={node} showThoughts={prefs.showThoughts} />
      <McpServerError node={node} />
      <RuntimeWarningBanner node={node} />
      <FollowUpsSection
        node={node}
        prefs={prefs}
        onContinueFollowUp={onContinueFollowUp}
        onBranchFollowUp={onBranchFollowUp}
        disabled={followUpsDisabled}
        showFollowUps={showFollowUps}
      />
      {/* Keep real content before the spacer so tail-follow never counts the
          reserved reply space as part of an error or status banner's offset. */}
      <TailSpacer node={node} viewportHeight={viewportHeight} bottomClearance={bottomClearance} />
    </div>
    </BackgroundWorkNodeContext.Provider>
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
  prev.bottomClearance === next.bottomClearance &&
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
  prev.onEditCancel === next.onEditCancel &&
  prev.onTestConnection === next.onTestConnection,
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
              borderRadius: 'var(--ui-radius-sm)',
              background: 'var(--term-line)',
              opacity: 0.5,
            }}
          />
          <div
            className="t-skeleton-pulse"
            style={{
              height: 12,
              width: i === 0 ? '90%' : '45%',
              borderRadius: 'var(--ui-radius-sm)',
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

function TailSpacer({ node, viewportHeight, bottomClearance }: {
  node: ChatNodeState;
  viewportHeight: number;
  bottomClearance: number;
}) {
  const spacerRef = React.useRef<HTMLDivElement>(null);
  const [height, setHeight] = React.useState(0);
  const last = node.messages[node.messages.length - 1];
  const enabled = node.status === 'streaming' && last?.role === 'assistant'
    && !node.followUpsGenerating && node.followUps.length === 0;
  let userMessageId: string | undefined;
  for (let i = node.messages.length - 1; i >= 0; i--) {
    if (node.messages[i].role === 'user') {
      userMessageId = node.messages[i].id;
      break;
    }
  }

  React.useLayoutEffect(() => {
    const spacer = spacerRef.current;
    const content = spacer?.parentElement;
    if (!enabled || !spacer || !content || !userMessageId) return;
    const user = Array.from(content.querySelectorAll<HTMLElement>('[data-msg-id]'))
      .find(el => el.dataset.msgId === userMessageId);
    if (!user) return;
    const measure = () => {
      // Reserve only the space needed to put the latest user message at 30%.
      // Everything before this spacer counts, including tools and status rows.
      // Composer clearance is already supplied by the scroller's bottom padding.
      const turnHeight = spacer.getBoundingClientRect().top - user.getBoundingClientRect().top;
      setHeight(Math.max(0, Math.ceil(viewportHeight * 0.7 - turnHeight - bottomClearance)));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    observer.observe(user);
    return () => observer.disconnect();
  }, [enabled, userMessageId, viewportHeight, bottomClearance]);

  if (!enabled || !userMessageId) return null;
  return <div ref={spacerRef} aria-hidden data-tail-spacer style={{ height, flexShrink: 0 }} />;
}

function RuntimeWarningBanner({ node }: { node: ChatNodeState }) {
  const owner = node.messages.findLast(message => message.warnings?.length);
  const warning = owner?.warnings?.at(-1) ?? node.warning;
  const [dismissedKey, setDismissedKey] = React.useState<string>();
  const key = warning ? `${owner?.id ?? node.activeTurnId ?? ''}:${warning.source}:${warning.category}:${warning.message}` : undefined;
  if (!warning || key === dismissedKey) return null;
  const label = warning.source === 'mcp' ? `MCP server "${warning.serverName ?? 'unknown'}"` : warning.source;
  return <div role="status" className="t-pre-block" style={{ margin: '8px 0', display: 'flex', gap: 8 }}>
    <span style={{ flex: 1, overflowWrap: 'anywhere' }}>{label}: {warning.message}</span>
    <button type="button" aria-label="Dismiss warning" onClick={() => setDismissedKey(key)}>×</button>
  </div>;
}

function McpServerError({ node }: { node: ChatNodeState }) {
  const [dismissed, setDismissed] = React.useState(false);

  // Reset local dismiss when the error identity changes (new failure on same node).
  const errorKey = node.mcpServerError
    ? `${node.mcpServerError.serverName}::${node.mcpServerError.error}`
    : null;
  React.useEffect(() => { setDismissed(false); }, [errorKey]);

  if (!node.mcpServerError || dismissed) return null;

  return (
    <div
      role="alert"
      style={{
        margin: '8px 0',
        padding: '6px 10px',
        fontSize: 'var(--fs-sm)',
        color: 'var(--term-danger)',
        border: '1px solid var(--term-danger)',
        borderRadius: 'var(--ui-radius)',
        opacity: 0.8,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
        ⚠ MCP server &quot;{node.mcpServerError.serverName}&quot; failed: {node.mcpServerError.error}
      </span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
        style={{
          cursor: 'pointer',
          color: 'var(--term-danger)',
          background: 'none',
          border: 'none',
          padding: '0 4px',
          font: 'inherit',
          fontSize: 'var(--fs-lg)',
          lineHeight: 1,
          opacity: 0.7,
          flexShrink: 0,
        }}
      >
        ×
      </button>
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
  const [collapsed, setCollapsed] = React.useState(false);
  const contentId = React.useId();
  if (!prefs.enableFollowUps) return null;

  const loading = node.status === 'streaming' && !!node.followUpsGenerating && node.followUps.length === 0;
  if (!loading && !showFollowUps) return null;

  return (
    <section className="t-followups" aria-label="Suggested follow-ups" aria-busy={loading}>
      <header className="t-followups-heading">
        <h3>Explore further</h3>
        <button
          type="button"
          className="t-followups-toggle"
          aria-label={collapsed ? 'Expand follow-ups' : 'Collapse follow-ups'}
          title={collapsed ? 'Expand follow-ups' : 'Collapse follow-ups'}
          aria-expanded={!collapsed}
          aria-controls={contentId}
          onClick={() => setCollapsed(value => !value)}
        >
          <ChevronDown size={15} aria-hidden />
        </button>
      </header>
      <div id={contentId} hidden={collapsed}>
        {loading ? (
          <>
            <div className="t-followups-loading" role="status"><LoaderCircle size={14} aria-hidden />Preparing next steps...</div>
            <div aria-hidden>{[0, 1, 2].map(i => <div key={i} className="t-followup-skeleton" />)}</div>
          </>
        ) : node.followUps.slice(0, 3).map((q, i) => (
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
    </section>
  );
}
