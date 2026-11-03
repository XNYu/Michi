import React from 'react';
import { ChevronDown, LoaderCircle } from 'lucide-react';
import { animate } from 'motion/react';
import { FLIGHT_MS, claimFlight, launchFlight } from './messageFlight';
import type { ChatNodeState } from '../../state/chatTypes';
import type { Prefs } from '../../state/prefs';
import { visibleMessageText } from '../../state/assistantBlocks';
import { FollowUpRow } from '../FollowUpRow';
import { DARK_PALETTES } from './tokens';
import { MessageBlock, NodeUserInputContext } from './MessageBlock';
import { DiffReceipt } from './DiffReceipt';
import { StreamActivityIndicator, deriveStreamActivity } from './StreamActivityIndicator';
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
import { turnOwnSubagents } from '../../state/turnSubagents';
import { unclaimedSubagents } from './subagents/subagentPresentation';
import { BackgroundWorkNodeContext, openBackgroundWork } from './backgroundWork/backgroundWorkEvents';
import { selectParentRunCards } from './agentRuns/agentRunSelectors';
import { agentResourceKey, type AgentResourceIdentity } from '../../state/agentIdentity';
import { useSourceReference } from '../../state/sourceNav/sourceNav';
import { SourceReferenceMark } from './source/SourceReferenceMark';
import { isFresh } from '../../motion/useFresh';

// The un-dim keeps the transition too, so leaving edit mode fades back in.
const FRAME_STYLE: React.CSSProperties = { transition: 'opacity var(--t-enter)' };
const DIMMED_FRAME_STYLE: React.CSSProperties = { ...FRAME_STYLE, opacity: 0.38, filter: 'saturate(0.5)' };

/**
 * Whether a message plays its entrance: it was created while this list was
 * on screen, moments ago. Hydrated, lazily loaded and older history predate
 * the list, and a remounted list starts with everything settled.
 */
export function isFreshMessage(createdAt: number | undefined, listMountedAt: number, now = Date.now()): boolean {
  return createdAt !== undefined && createdAt >= listMountedAt && isFresh(createdAt, now);
}

function useOptionalAgentRunUi() {
  const domain = useOptionalAgentDomain();
  const actions = useOptionalChatActions();
  // PaneMessageList also supports provider-free render/perf unit tests.
  return domain && actions ? { domain, actions } : null;
}

interface PaneMessageListProps {
  node: ChatNodeState;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
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
   * Every anchor renders as a BranchAnchorRow turn marker after the anchored
   * message. A branch made from a selection (quotedText) also underlines the
   * quoted passage inside the message (BranchQuoteUnderline).
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
  loadingOlder = false,
  onLoadOlder,
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
  // Agents a turn lists inline: its own, not ones that ended in an earlier
  // turn and reappear in this turn's roster.
  const ownSubagents = React.useMemo(
    () => turnOwnSubagents({ messages: node.messages, subagents: node.subagents }, tailAssistantId),
    [node.messages, node.subagents, tailAssistantId],
  );
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
  const [listMountedAt] = React.useState(() => Date.now());
  /** The list's own box: which surface (pane) its bubbles fly within. */
  const listRootRef = React.useRef<HTMLDivElement>(null);
  // Replies this list watched stream: the diff receipt their turn's end
  // brings grows in, once. One that comes with the history (opened, lazily
  // loaded, remounted by a retry or edit) renders settled.
  const streamedHereRef = React.useRef(new Set<string>());
  const tailMessage = node.messages[node.messages.length - 1];
  const tailReplyKey = tailMessage?.role === 'assistant' ? tailMessage.clientKey ?? tailMessage.id : null;
  React.useLayoutEffect(() => {
    if (!tailReplyKey) return;
    if (node.status === 'streaming') streamedHereRef.current.add(tailReplyKey);
    // The turn ended and its receipt, if any, has mounted.
    else streamedHereRef.current.delete(tailReplyKey);
  }, [node.status, tailReplyKey]);
  // Kept across turns: the section unmounts while a turn runs.
  const [followUpsCollapsed, setFollowUpsCollapsed] = React.useState(false);
  const toggleFollowUps = React.useCallback(() => setFollowUpsCollapsed((value) => !value), []);
  // Suppress follow-ups while the turn is still running. node.status is
  // persisted in the DB and survives hydration, unlike message-level
  // m.streaming which mapMessageRow() resets to false on load.
  const turnStillRunning = node.status === 'streaming';

  const showFollowUps = node.messagesLoaded === false && !node.historyBefore
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

  // A send clears the follow-ups: the section stays, as it last was, while
  // it fades out (120ms) and the picked one, if any, flies on as the new
  // bubble. Any other removal (a loading state replaced, the answer still
  // typing) is immediate, as it always was.
  const showSection = prefs.enableFollowUps && (followUpsLoading(node) || showFollowUps);
  const lastShownRef = React.useRef<ChatNodeState | null>(null);
  React.useLayoutEffect(() => {
    if (showSection) lastShownRef.current = node;
  });
  const [wasShown, setWasShown] = React.useState(showSection);
  const [leavingNode, setLeavingNode] = React.useState<ChatNodeState | null>(null);
  if (wasShown !== showSection) {
    setWasShown(showSection);
    setLeavingNode(!showSection && sentFromHere(lastShownRef.current, node) ? lastShownRef.current : null);
  }
  const followUpsLeft = React.useCallback(() => setLeavingNode(null), []);
  const followUpsNode = showSection ? node : leavingNode;

  countRender('PaneMessageList', node.nodeId, {
    status: node.status,
    messages: node.messages.length,
    followUps: node.followUps.length,
  });
  const isDark = DARK_PALETTES.has(prefs.terminalPalette);

  // Placeholder state: node has messages in the DB but they haven't loaded yet.
  // Show a subtle loading indicator instead of bare follow-ups.
  const isPlaceholder = node.messagesLoaded === false && node.messages.length === 0 && (node.messageCount ?? 0) > 0;
  // Messages before this cut were copied from the parent chain by extraction.
  const historyOffset = node.historyBefore ? Math.max(0, (node.messageCount ?? 0) - node.messages.length) : 0;
  const inheritedCount = Math.max(0, Math.min((node.inheritedMessageCount ?? 0) - historyOffset, node.messages.length));

  const userInputCtx = React.useMemo(
    () => ({ userInput: node.pendingUserInput, nodeId: node.nodeId }),
    [node.pendingUserInput, node.nodeId],
  );

  return (
    <NodeUserInputContext.Provider value={userInputCtx}>
    <BackgroundWorkNodeContext.Provider value={nodeId}>
    <div ref={listRootRef} style={contentStyle}>
      {node.historyBefore && onLoadOlder && (
        <button type="button" disabled={loadingOlder} onClick={onLoadOlder}
          className="mb-4 w-full rounded border border-line px-3 py-2 text-sm text-muted hover:bg-surface disabled:opacity-50">
          {loadingOlder ? 'Loading older messages…' : 'Load older messages'}
        </button>
      )}
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

        // Collect branch anchors for this message. They are passed into
        // MessageBlock and rendered between the message body and the
        // MessageActions row, so the marker sits closer to the message
        // content than the action chrome; quoted passages are underlined in
        // the body. The array comes from the anchor map, stable across chunks.
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
        const rowKey = m.clientKey ?? m.id;
        const fresh = isFreshMessage(m.createdAt, listMountedAt);
        // A new user bubble that came from a queued block or a picked
        // follow-up in this pane flies in from it (messageFlight). A claim
        // holds for FLIGHT_MS: a later mount of the same message settles.
        const flightFrom = isUser && (fresh || m.queueId)
          ? claimFlight(listRootRef.current, node.nodeId, rowKey, m.queueId)
          : undefined;

        return (
          // clientKey survives realign-assistant-id, so the rename does not
          // remount the row (and replay its entrance or drop its state).
          <React.Fragment key={rowKey}>
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
              style={isDownstream ? DIMMED_FRAME_STYLE : FRAME_STYLE}
            >
              <MessageBlock
                m={m}
                fresh={fresh}
                flightFrom={flightFrom}
                highlight={sourceReference?.messageId === m.id ? referenceMark : undefined}
                workspaceId={node.projectId}
                backendConnectionId={backendConnectionId}
                index={i}
                isDark={isDark}
                editing={m.id === editingMessageId}
                hideActions={isStreamingTail}
                hidePendingIndicator={isStreamingTail && deriveStreamActivity(node) !== null}
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
                quoteAnchors={anchorsForMsg.some((a) => a.quotedText) ? anchorsForMsg : undefined}
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
                  <DiffReceipt message={m} workspaceId={node.projectId} enter={streamedHereRef.current.has(rowKey)} />
                )}
              {/* Agents no delegation chip claims (Crew runs, legacy rosters)
                  render inline within the turn that spawned them. */}
              {roster && <MessageSubagents subagents={unclaimedSubagents(ownSubagents.get(m.id) ?? roster, m.toolCalls)} />}
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
      {followUpsNode && (
        <FollowUpsSection
          node={followUpsNode}
          leaving={!showSection}
          onLeft={followUpsLeft}
          collapsed={followUpsCollapsed}
          onToggleCollapsed={toggleFollowUps}
          onContinueFollowUp={onContinueFollowUp}
          onBranchFollowUp={onBranchFollowUp}
          disabled={followUpsDisabled}
        />
      )}
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

function followUpsLoading(node: ChatNodeState): boolean {
  return node.status === 'streaming' && !!node.followUpsGenerating && node.followUps.length === 0;
}

function lastUserKey(node: ChatNodeState): string | undefined {
  const message = node.messages.findLast((m) => m.role === 'user');
  return message ? message.clientKey ?? message.id : undefined;
}

/**
 * The follow-ups the section last showed went because a message was just
 * sent (user-send clears them and starts the turn under a new user
 * message). A loading state, a turn without a new message, or follow-ups
 * that ran out are not sends.
 */
function sentFromHere(shown: ChatNodeState | null, node: ChatNodeState): boolean {
  if (!shown || shown.followUps.length === 0) return false;
  if (node.status !== 'streaming' || node.followUps.length > 0 || node.followUpsGenerating) return false;
  const sent = node.messages.findLast((m) => m.role === 'user');
  return !!sent && isFresh(sent.createdAt) && lastUserKey(node) !== lastUserKey(shown);
}

function FollowUpsSection({
  node,
  leaving,
  onLeft,
  collapsed,
  onToggleCollapsed,
  onContinueFollowUp,
  onBranchFollowUp,
  disabled,
}: {
  node: ChatNodeState;
  /** A send cleared it: fade out (120ms), then onLeft. */
  leaving: boolean;
  onLeft: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onContinueFollowUp: (question: string) => void;
  onBranchFollowUp: (question: string) => void;
  disabled: boolean;
}) {
  const contentId = React.useId();
  const present = !leaving;
  const sectionRef = React.useRef<HTMLElement>(null);
  React.useLayoutEffect(() => {
    const el = sectionRef.current;
    if (!leaving || !el) return;
    const controls = animate(el, { opacity: 0 }, { duration: 0.12, ease: 'linear', onComplete: onLeft });
    return () => {
      controls.stop();
      // Shown again (the send was refused and its follow-ups came back).
      el.style.opacity = '';
    };
  }, [leaving, onLeft]);
  const nodeId = node.nodeId;
  const rowsRef = React.useRef<Array<HTMLDivElement | null>>([]);
  // The follow-up the user just sent. Its row hides once the section leaves
  // (its text flies on as the bubble); a send that never left keeps it.
  const [picked, setPicked] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (picked === null) return;
    const timer = setTimeout(() => setPicked(null), FLIGHT_MS);
    return () => clearTimeout(timer);
  }, [picked]);
  const loading = followUpsLoading(node);

  return (
    <section
      ref={sectionRef}
      className="t-followups"
      aria-label="Suggested follow-ups"
      aria-busy={loading}
      // A leaving section is no longer part of the page.
      aria-hidden={present ? undefined : true}
      inert={!present}
    >
      <header className="t-followups-heading">
        <h3>Explore further</h3>
        <button
          type="button"
          className="t-followups-toggle"
          aria-label={collapsed ? 'Expand follow-ups' : 'Collapse follow-ups'}
          title={collapsed ? 'Expand follow-ups' : 'Collapse follow-ups'}
          aria-expanded={!collapsed}
          aria-controls={contentId}
          onClick={onToggleCollapsed}
        >
          <ChevronDown size={15} aria-hidden />
        </button>
      </header>
      <div id={contentId} hidden={collapsed}>
        {loading ? (
          <>
            <div className="t-followups-loading" role="status"><LoaderCircle size={14} aria-hidden className="motion-safe:animate-spin" />Preparing next steps...</div>
            <div aria-hidden>{[0, 1, 2].map(i => <div key={i} className="t-followup-skeleton" />)}</div>
          </>
        ) : node.followUps.slice(0, 3).map((q, i) => (
          <FollowUpRow
            key={i}
            index={i}
            question={q}
            disabled={disabled || (node.status === 'streaming' && !node.visibleResponseComplete)}
            onContinue={(question) => {
              // Record the box the user clicked before the send moves it.
              launchFlight(nodeId, rowsRef.current[i]);
              setPicked(i);
              onContinueFollowUp(question);
            }}
            onBranch={onBranchFollowUp}
            rowRef={(el) => { rowsRef.current[i] = el; }}
            picked={!present && picked === i}
          />
        ))}
      </div>
    </section>
  );
}
