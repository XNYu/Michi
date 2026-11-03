import { serverEntityId } from '../../config/backendIdentity';
import React, { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import { AnimatePresence, motion, useIsPresent, type TargetAndTransition } from 'motion/react';
import type { ChatNodeState, PendingQueuedMessage } from '../../state/chatTypes';
import { useChatProjects } from '../../state/chatStore';
import { parseChatCommand } from '../../state/chatCommands';
import { workspaceBackendApiBase } from '../../config/backendConnections';
import { EASE } from '../../motion/tokens';
import { AssistantAttachmentsPreBlock } from './assistant/AssistantAttachments';
import { launchFlight, markRestored, registerQueuedSource, wasRestored } from './messageFlight';

/** A queued block leaving folds away (its text flies on as the bubble). */
const QUEUED_EXIT: TargetAndTransition = {
  opacity: 0,
  height: 0,
  marginTop: 0,
  paddingTop: 0,
  paddingBottom: 0,
  overflow: 'hidden',
  transition: { duration: 0.2, ease: EASE.drawer, opacity: { duration: 0.08, ease: 'linear' } },
};

const NO_QUEUE: readonly PendingQueuedMessage[] = [];

export interface PanePendingAttachment {
  id: string;
  name: string;
  absPath: string;
  /** Workspace-relative path (e.g. ".attachments/img.png"). Present for uploaded files. */
  relPath?: string;
}

interface PaneComposerPreBlocksProps {
  node: ChatNodeState;
  quoteMaxLines: number;
  quotedText: string | null;
  pendingAttachments: readonly PanePendingAttachment[];
  canSteerQueued: boolean;
  steeringQueueId: string | null;
  onSteerQueued: (queueId: string) => void;
  onRestoreQueued: (queueId: string) => void;
  onEditPendingComment: (commentId: string, body: string) => void;
  onRemovePendingComment: (commentId: string) => void;
  onDismissQuote: () => void;
  onRemovePendingAttachment: (attachmentId: string) => void;
}

/** Build a thumbnail src for a pending image attachment. Always uses the
 *  backend /api/files route — file:// URLs are blocked when the renderer
 *  loads from http:// (Electron dev and prod both use localhost). */
function pendingThumbSrc(p: PanePendingAttachment, workspaceId?: string): string | null {
  if (workspaceId && p.relPath) {
    const encoded = p.relPath.split('/').map(encodeURIComponent).join('/');
    return `${workspaceBackendApiBase(workspaceId)}/files/${encodeURIComponent(serverEntityId(workspaceId))}/${encoded}`;
  }
  // Fallback: derive relPath from absPath if it contains .attachments/
  if (workspaceId && p.absPath) {
    const marker = '/.attachments/';
    const idx = p.absPath.indexOf(marker);
    if (idx !== -1) {
      const rel = '.attachments/' + p.absPath.slice(idx + marker.length);
      const encoded = rel.split('/').map(encodeURIComponent).join('/');
      return `${workspaceBackendApiBase(workspaceId)}/files/${encodeURIComponent(serverEntityId(workspaceId))}/${encoded}`;
    }
  }
  return null;
}

export function PaneComposerPreBlocks({
  node,
  quoteMaxLines,
  quotedText,
  pendingAttachments,
  canSteerQueued,
  steeringQueueId,
  onSteerQueued,
  onRestoreQueued,
  onEditPendingComment,
  onRemovePendingComment,
  onDismissQuote,
  onRemovePendingAttachment,
}: PaneComposerPreBlocksProps) {
  const { activeProject } = useChatProjects();
  const workspaceId = activeProject?.id;
  const queued = node.pendingQueued ?? NO_QUEUE;
  const nodeId = node.nodeId;

  // This pane's queued blocks: the launch reads them; steered messages find
  // them through the registry.
  const blocksRef = useRef(new Map<string, HTMLElement>());
  const registerBlock = useCallback((queueId: string, el: HTMLElement) => {
    blocksRef.current.set(queueId, el);
    const unregister = registerQueuedSource(nodeId, queueId, el);
    return () => {
      unregister();
      if (blocksRef.current.get(queueId) === el) blocksRef.current.delete(queueId);
    };
  }, [nodeId]);

  // An entry that leaves the queue is sent (the turn's end drains it, or
  // "Send now"), unless the user took it back into the composer (×, in any
  // surface showing it), it is being steered (that message links to its
  // block itself) or it is a command (no bubble). A drain launches once:
  // a batch merges into one bubble, which flies from its first block, still
  // on screen here, leaving.
  const runtimeId = node.runtimeId;
  const engine = node.sessionState?.nativeEngine;
  const previousRef = useRef<{ nodeId: string; entries: readonly PendingQueuedMessage[] }>({ nodeId, entries: queued });
  useLayoutEffect(() => {
    const previous = previousRef.current;
    previousRef.current = { nodeId, entries: queued };
    if (previous.nodeId !== nodeId) return;
    const sent = previous.entries.find((entry) =>
      !queued.some((q) => q.id === entry.id)
      && !entry.steering
      && !wasRestored(nodeId, entry.id)
      && !parseChatCommand(entry.value, runtimeId, engine));
    if (sent) launchFlight(nodeId, blocksRef.current.get(sent.id));
  }, [nodeId, queued, runtimeId, engine]);
  const restore = useCallback((queueId: string) => {
    markRestored(nodeId, queueId);
    onRestoreQueued(queueId);
  }, [nodeId, onRestoreQueued]);

  return (
    <>
      <AssistantAttachmentsPreBlock nodeId={node.nodeId} />

      <AnimatePresence initial={false}>
        {queued.map((q, i) => {
          const isErrored = !!node.queueErrored;
          return (
            <QueuedBlock
              key={q.id}
              register={registerBlock}
              entry={q}
              index={i}
              errored={isErrored}
              steerable={canSteerQueued && !isErrored}
              steerDisabled={steeringQueueId !== null || queued.some((entry) => entry.steering)}
              steering={steeringQueueId === q.id || !!q.steering}
              onSteer={onSteerQueued}
              onRestore={restore}
            />
          );
        })}
      </AnimatePresence>

      {(node.pendingComments ?? []).map((c, i) => (
        <EditableCommentChip
          key={c.id}
          index={i}
          quotedText={c.quotedText}
          body={c.body}
          source={c.source}
          onEdit={(body) => onEditPendingComment(c.id, body)}
          onRemove={() => onRemovePendingComment(c.id)}
        />
      ))}

      {quotedText && (
        <div className="t-pre-block tone-accent">
          <div className="t-pre-block-col">
            <div className="t-pre-block-cap">
              replying to <b>selection</b>
              {node.composerDraft?.quoteSource?.type === 'artifact' ? (
                <span> · {node.composerDraft.quoteSource.name || node.composerDraft.quoteSource.filePath} · {node.composerDraft.quoteSource.snapshot?.contentHash.slice(0, 8) || 'version unknown'}</span>
              ) : null}
            </div>
            <div
              className={quoteMaxLines > 1 ? 't-pre-block-body is-multi' : 't-pre-block-body'}
              style={quoteMaxLines > 1 ? { WebkitLineClamp: quoteMaxLines } : undefined}
            >
              {quotedText.replace(/\s+/g, ' ').trim()}
            </div>
          </div>
          <button
            type="button"
            aria-label="Dismiss quote"
            className="t-pre-block-x"
            onClick={onDismissQuote}
          >
            ×
          </button>
        </div>
      )}

      {pendingAttachments.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '4px 8px' }}>
          {pendingAttachments.map((p) => {
            const ext = p.name.split('.').pop()?.toLowerCase() ?? '';
            const isImage = ['png','jpg','jpeg','gif','webp'].includes(ext);
            const thumbSrc = isImage ? pendingThumbSrc(p, workspaceId) : null;

            if (isImage && thumbSrc) {
              return (
                <span key={p.id} title={p.name} className="t-att-pending-item" style={{ display: 'inline-block' }}>
                  <img
                    src={thumbSrc}
                    alt={p.name}
                    style={{ width: 64, height: 64, objectFit: 'cover', display: 'block' }}
                  />
                  <span
                    className="t-att-pending-x"
                    onClick={() => onRemovePendingAttachment(p.id)}
                  >
                    ×
                  </span>
                </span>
              );
            }

            return (
              <span key={p.id} className="t-att-pending-item t-att-pending-file" title={p.absPath}>
                <span style={{ fontSize: 'var(--fs-xs)', opacity: 0.7 }}>📄</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>
                  {p.name}
                </span>
                <span
                  className="t-att-pending-x"
                  onClick={() => onRemovePendingAttachment(p.id)}
                >
                  ×
                </span>
              </span>
            );
          })}
        </div>
      )}
    </>
  );
}

/** One queued message. While it leaves it is out of the a11y tree and inert. */
function QueuedBlock({ register: registerBlock, entry, index, errored, steerable, steerDisabled, steering, onSteer, onRestore }: {
  register: (queueId: string, el: HTMLElement) => () => void;
  entry: PendingQueuedMessage;
  index: number;
  errored: boolean;
  steerable: boolean;
  steerDisabled: boolean;
  steering: boolean;
  onSteer: (queueId: string) => void;
  onRestore: (queueId: string) => void;
}) {
  const present = useIsPresent();
  const queueId = entry.id;
  // Stays registered while it leaves: a steered message finds it then.
  const register = useCallback((el: HTMLDivElement | null) => (el ? registerBlock(queueId, el) : undefined), [registerBlock, queueId]);
  const captionSuffix = index === 0
    ? (errored ? ' · paused, review and send manually' : ' · sends when stream ends')
    : '';
  return (
    <motion.div
      ref={register}
      exit={QUEUED_EXIT}
      className={`t-pre-block ${errored ? 'tone-danger' : 'tone-select'}`}
      aria-hidden={present ? undefined : true}
      inert={!present}
    >
      <div className="t-pre-block-col">
        <div className="t-pre-block-cap">
          queued <b>{index + 1}</b>{captionSuffix}
        </div>
        <div className="t-pre-block-body">
          {entry.value.replace(/\s+/g, ' ').trim()}
        </div>
      </div>
      <div className="t-pre-block-actions">
        {steerable && (
          <button
            type="button"
            className="t-pre-block-steer"
            disabled={steerDisabled}
            onClick={() => onSteer(queueId)}
          >
            {steering ? 'Steering…' : 'Steer now'}
          </button>
        )}
        <button
          type="button"
          aria-label="Dequeue message"
          disabled={steering}
          className="t-pre-block-x"
          onClick={() => onRestore(queueId)}
        >
          ×
        </button>
      </div>
    </motion.div>
  );
}

function EditableCommentChip({
  index,
  quotedText,
  body,
  source,
  onEdit,
  onRemove,
}: {
  index: number;
  quotedText: string;
  body: string;
  source?: NonNullable<ChatNodeState['pendingComments']>[number]['source'];
  onEdit: (body: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(body);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.selectionStart = textareaRef.current.value.length;
    }
  }, [editing]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== body) onEdit(trimmed);
    setEditing(false);
  };

  const cancel = () => {
    setDraft(body);
    setEditing(false);
  };

  return (
    <div
      className="t-pre-block tone-select"
      title={`"${quotedText}"\n\n${body}`}
    >
      <div className="t-pre-block-col">
        <div className="t-pre-block-cap">
          comment <b>{index + 1}</b>{index === 0 ? ' · pending on next send' : ''}
          {source ? <span> · {source.name || source.filePath} · {source.snapshot?.contentHash.slice(0, 8) || 'version unknown'}</span> : null}
        </div>
        <div className="t-pre-block-quoted">
          "{quotedText.replace(/\s+/g, ' ').trim()}"
        </div>
        {editing ? (
          <textarea
            ref={textareaRef}
            className="t-pre-block-edit-textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                e.preventDefault();
                commit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              }
            }}
            onBlur={commit}
            rows={2}
          />
        ) : (
          <div
            className="t-pre-block-reply is-editable"
            onClick={() => { setDraft(body); setEditing(true); }}
          >
            {body.replace(/\s+/g, ' ').trim()}
          </div>
        )}
      </div>
      <button
        type="button"
        aria-label="Remove pending comment"
        className="t-pre-block-x"
        onClick={onRemove}
      >
        ×
      </button>
    </div>
  );
}
