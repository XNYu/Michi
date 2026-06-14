import React from 'react';
import { toast } from 'sonner';
import { useChatStore, useChatNodesSnapshot } from '../../../state/chatStore';
import { usePrefs } from '../../../state/prefs';
import {
  parseFanoutCommand,
  shouldBranchOnSubmit,
  stripBranchPrefix,
} from '../../nodes/chatNodeUtils';
import { findTreeIdForNode } from '../../../state/tree';
import ChatHeader from '../components/ChatHeader';
import MobileMessage from '../components/MobileMessage';
import MobileComposer from '../components/MobileComposer';
import BranchDropdown from '../components/BranchDropdown';
import StructureDrawer from '../components/StructureDrawer';
import ActionSheet, { type ActionSheetItem } from '../components/ActionSheet';
import PermissionCard from '../components/PermissionCard';
import SpawnCard from '../components/SpawnCard';
import { FollowUpRow } from '../../FollowUpRow';
import { useNodeNavigation } from '../hooks/useNodeNavigation';
import type { ChatMessage } from '../../../state/chatTypes';

interface Props {
  nodeId: string;
  onNavigateNode: (nodeId: string) => void;
  onExit: () => void;
}

/**
 * Mobile chat surface. Header + scrollable message stream + composer.
 *
 * Routing on send:
 *   /fanout a; b; c   → fanoutBranches(currentNodeId, [a, b, c])
 *   /branch xxx       → createChildChat(currentNodeId, xxx)
 *   /btw    xxx       → createChildChat(currentNodeId, xxx)   (same code path; semantics handled upstream)
 *   plain text        → sendMessage(currentNodeId, text); auto-branch when streaming
 *
 * Streaming UX:
 *   - composer disabled, send button becomes ■ stop (calls cancelStream)
 *   - last assistant message renders the typing animation while .streaming === true
 *
 * Scroll memory: every node's last scrollTop is remembered in a Map keyed by
 * nodeId; on entry we restore (or fall back to bottom for streaming nodes).
 */
export default function ChatScreen({ nodeId, onNavigateNode, onExit }: Props) {
  const {
    activeProject,
    sendMessage,
    createChildChat,
    cancelStream,
    fanoutBranches,
    setComposerDraft,
    addPendingComment,
    clearPendingComments,
    resolvePermission,
    denyPermission,
    isObserver,
  } = useChatStore();
  const { prefs } = usePrefs();
  const nodes = useChatNodesSnapshot();
  const node = nodes[nodeId];

  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [branchesOpen, setBranchesOpen] = React.useState(false);
  const [actionMsg, setActionMsg] = React.useState<ChatMessage | null>(null);
  const [draft, setDraftLocal] = React.useState<string>(
    () => node?.composerDraft?.value ?? '',
  );

  const streamRef = React.useRef<HTMLDivElement>(null);
  const { rememberScroll, getScroll } = useNodeNavigation();

  // Sync local draft with persisted draft when switching nodes.
  React.useEffect(() => {
    setDraftLocal(node?.composerDraft?.value ?? '');
  }, [nodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist draft (debounced via the store's own write logic).
  React.useEffect(() => {
    if (!node) return;
    if (draft === (node.composerDraft?.value ?? '')) return;
    const handle = setTimeout(() => {
      setComposerDraft(nodeId, draft ? { value: draft, mentions: [] } : null);
    }, 250);
    return () => clearTimeout(handle);
  }, [draft, nodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Restore scroll on node entry; remember scroll on every change.
  React.useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    const saved = getScroll(nodeId);
    if (saved != null) el.scrollTop = saved;
    else el.scrollTop = el.scrollHeight; // first visit → bottom
  }, [nodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-stick to bottom while the assistant streams, but only if the user
  // hasn't scrolled away. We deliberately only depend on length + last message
  // text length + status — depending on the array reference would re-fire on
  // every reducer dispatch (e.g. composer-draft writes), making the stream
  // jump while the user is editing.
  const lastMsgTextLen = node?.messages[node.messages.length - 1]?.text.length ?? 0;
  React.useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom < 80) {
      el.scrollTop = el.scrollHeight;
    }
  }, [node?.messages.length, lastMsgTextLen, node?.status]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    rememberScroll(nodeId, (e.target as HTMLDivElement).scrollTop);
  };

  // Find spawned children of the current node so we can render a SpawnCard
  // at the bottom of the stream when the agent kicked off branches.
  const spawnedChildren = React.useMemo(() => {
    if (!activeProject) return [];
    const childIds = activeProject.edges
      .filter((e) => (!e.kind || e.kind === 'branch') && e.source === nodeId)
      .map((e) => e.target);
    return childIds
      .map((id) => nodes[id])
      .filter((n) => n && !n.deletedAt && n.spawnedByAgent);
  }, [activeProject, nodes, nodeId]);

  // Followups & live children for branch button.
  const childIds = React.useMemo(() => {
    if (!activeProject) return [];
    return activeProject.edges
      .filter(
        (e) =>
          (!e.kind || e.kind === 'branch')
          && e.source === nodeId
          && !nodes[e.target]?.deletedAt,
      )
      .map((e) => e.target);
  }, [activeProject, nodeId, nodes]);

  if (!node || !activeProject) {
    return (
      <div className="m-screen">
        <div className="m-chat-header">
          <button onClick={onExit} aria-label="Back">‹</button>
        </div>
        <div className="m-empty">
          <div className="m-empty-headline">Node not found</div>
          <div className="m-empty-sub">It may have been deleted.</div>
        </div>
      </div>
    );
  }

  const streaming = node.status === 'streaming';
  const observing = isObserver(nodeId);

  const handleSend = async () => {
    if (observing) {
      toast('This pane is being edited in another window');
      return;
    }
    // Hard-block sending while a stream is in flight. The spec disables the
    // composer (3.2.6); the textarea's disabled flag covers touch input but a
    // hardware keyboard could still fire ⌘+Enter, and `sendMessage` in the
    // store silently drops on streaming nodes. Bail explicitly so users get
    // visible feedback.
    if (streaming) {
      toast('Wait for the current reply to finish, or stop it first');
      return;
    }
    const raw = draft.trim();
    if (!raw) return;

    // Fanout has its own pipeline.
    const fanout = parseFanoutCommand(raw);
    if (fanout) {
      setDraftLocal('');
      try {
        const lastAssistantId = [...node.messages].reverse().find((m) => m.role === 'assistant')?.id;
        await fanoutBranches(nodeId, fanout.topics, { anchorMessageId: lastAssistantId });
        toast.success(`Fanned out ${fanout.topics.length} branches`);
      } catch (e) {
        toast.error(`Fanout failed: ${(e as Error).message}`);
      }
      return;
    }

    const { branched: slashBranched, text } = stripBranchPrefix(raw);
    if (!text) return;

    setDraftLocal('');
    setComposerDraft(nodeId, null);

    const shouldBranch = shouldBranchOnSubmit({
      forceBranch: false,
      slashBranched,
      streaming,
    });
    try {
      if (shouldBranch) {
        const lastAssistantId = [...node.messages].reverse().find((m) => m.role === 'assistant')?.id;
        const newId = await createChildChat(nodeId, text, undefined, {
          anchorMessageId: lastAssistantId,
        });
        onNavigateNode(newId);
        toast.success('Branch created');
      } else {
        sendMessage(nodeId, text);
      }
    } catch (e) {
      toast.error(`Send failed: ${(e as Error).message}`);
    }
  };

  const handleCancel = () => {
    if (observing) return;
    cancelStream(nodeId);
    toast('Stopped');
  };

  // ------- Action sheet items -------
  const actionItems: ActionSheetItem[] = actionMsg
    ? [
        {
          id: 'branch',
          glyph: '⑂',
          label: 'Branch from here',
          onSelect: async () => {
            try {
              const newId = await createChildChat(
                nodeId,
                `> ${truncate(actionMsg.text, 240)}\n\n`,
                undefined,
                { anchorMessageId: actionMsg.id },
              );
              onNavigateNode(newId);
              toast.success('Branch created');
            } catch (e) {
              toast.error(`Branch failed: ${(e as Error).message}`);
            }
          },
        },
        {
          id: 'quote',
          glyph: '"',
          label: 'Quote reply',
          onSelect: () => {
            const q = `> ${truncate(actionMsg.text, 240)}\n\n`;
            setDraftLocal((prev) => (prev ? `${q}${prev}` : q));
            toast('Quoted to composer');
          },
        },
        {
          id: 'comment',
          glyph: '✎',
          label: 'Add comment',
          onSelect: () => {
            const body = window.prompt('Comment on this passage:');
            if (body && body.trim()) {
              addPendingComment(nodeId, truncate(actionMsg.text, 600), body.trim());
              toast.success('Comment queued');
            }
          },
        },
        {
          id: 'copy',
          glyph: '⧉',
          label: 'Copy text',
          onSelect: async () => {
            try {
              await navigator.clipboard.writeText(actionMsg.text);
              toast('Copied');
            } catch {
              toast.error('Copy failed');
            }
          },
        },
        {
          id: 'cancel',
          label: 'Cancel',
          cancel: true,
          onSelect: () => {},
        },
      ]
    : [];

  return (
    <div className="m-screen" style={{ position: 'relative' }}>
      <ChatHeader
        node={node}
        project={activeProject}
        nodes={nodes}
        onMenuClick={() => setDrawerOpen(true)}
        onBack={onExit}
        onNavigateNode={onNavigateNode}
        onBranchesClick={() => setBranchesOpen(true)}
      />

      {branchesOpen && (
        <BranchDropdown
          childIds={childIds}
          nodes={nodes}
          edges={activeProject.edges}
          onPick={(id) => onNavigateNode(id)}
          onClose={() => setBranchesOpen(false)}
        />
      )}

      <div
        ref={streamRef}
        className="m-msg-stream"
        onScroll={onScroll}
      >
        {node.messages.length === 0 && !streaming && (
          <div className="m-empty">
            <div className="m-empty-headline">Start the conversation</div>
            <div className="m-empty-sub">Type below to begin.</div>
          </div>
        )}
        {node.messages.map((m) => (
          <MobileMessage
            key={m.id}
            message={m}
            runtimeId={node.runtimeId}
            onLongPress={(msg) => setActionMsg(msg)}
          />
        ))}

        {/* Tail decorations (permission, spawn, follow-ups, errors) */}
        {node.error && (
          <div
            className="m-msg"
            data-role="system"
            style={{ borderColor: '#dc2626' }}
          >
            <div className="m-msg-body" style={{ color: '#dc2626', borderColor: '#dc2626' }}>
              {node.error}
            </div>
          </div>
        )}
        {node.pendingPermission && (
          <PermissionCard
            permission={node.pendingPermission}
            onAllow={(id) => resolvePermission(nodeId, id)}
            onDeny={() => denyPermission(nodeId)}
            readOnly={observing}
          />
        )}
        <SpawnCard spawnedChildren={spawnedChildren} onPick={onNavigateNode} />
        {prefs.enableFollowUps && node.followUps.length > 0 && (
          <div className="m-followups">
            <div className="m-followups-label">Follow ups</div>
            {node.followUps.map((q, i) => (
              <FollowUpRow
                key={i}
                index={i}
                question={q}
                disabled={streaming || observing}
                onContinue={(question) => void sendMessage(nodeId, question)}
                onBranch={async (question) => {
                  try {
                    const newId = await createChildChat(nodeId, question, undefined, {
                      anchorMessageId: node.followUpsSourceMessageId,
                    });
                    onNavigateNode(newId);
                  } catch (e) {
                    toast.error(`Follow-up failed: ${(e as Error).message}`);
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>

      <MobileComposer
        value={draft}
        onChange={setDraftLocal}
        onSend={handleSend}
        onCancel={handleCancel}
        streaming={streaming}
        readOnly={observing}
        budgetChars={draft.length}
      />

      {/* Pending comments badge — sits above composer */}
      {(node.pendingComments?.length ?? 0) > 0 && (
        <div
          style={{
            position: 'absolute',
            bottom: 110,
            left: 8,
            right: 8,
            background: 'var(--term-alt)',
            border: '1px solid var(--term-line)',
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 11.5,
            color: 'var(--term-muted)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span style={{ flex: 1 }}>
            {node.pendingComments?.length} comment
            {node.pendingComments?.length === 1 ? '' : 's'} queued
          </span>
          <button
            onClick={() => clearPendingComments(nodeId)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--term-muted)',
              cursor: 'pointer',
            }}
          >
            clear
          </button>
        </div>
      )}

      {drawerOpen && (
        <StructureDrawer
          project={activeProject}
          nodes={nodes}
          currentNodeId={nodeId}
          rootNodeId={
            (() => {
              const tid = findTreeIdForNode(nodeId, activeProject);
              const t = activeProject.trees.find((x) => x.id === tid);
              if (t?.rootNodeId) return t.rootNodeId;
              const firstLive = activeProject.trees.find((x) => !nodes[x.rootNodeId]?.deletedAt);
              return firstLive?.rootNodeId ?? nodeId;
            })()
          }
          onPickNode={(id) => onNavigateNode(id)}
          onClose={() => setDrawerOpen(false)}
        />
      )}

      {actionMsg && (
        <ActionSheet items={actionItems} onClose={() => setActionMsg(null)} />
      )}
    </div>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
