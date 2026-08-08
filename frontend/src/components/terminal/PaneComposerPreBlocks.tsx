import React, { useState, useRef, useEffect } from 'react';
import type { ChatNodeState } from '../../state/chatTypes';
import { useChatProjects } from '../../state/chatStore';
import { API_BASE_URL } from '../../config/env';

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
    return `${API_BASE_URL}/files/${encodeURIComponent(workspaceId)}/${encoded}`;
  }
  // Fallback: derive relPath from absPath if it contains .attachments/
  if (workspaceId && p.absPath) {
    const marker = '/.attachments/';
    const idx = p.absPath.indexOf(marker);
    if (idx !== -1) {
      const rel = '.attachments/' + p.absPath.slice(idx + marker.length);
      const encoded = rel.split('/').map(encodeURIComponent).join('/');
      return `${API_BASE_URL}/files/${encodeURIComponent(workspaceId)}/${encoded}`;
    }
  }
  return null;
}

export function PaneComposerPreBlocks({
  node,
  quoteMaxLines,
  quotedText,
  pendingAttachments,
  onRestoreQueued,
  onEditPendingComment,
  onRemovePendingComment,
  onDismissQuote,
  onRemovePendingAttachment,
}: PaneComposerPreBlocksProps) {
  let workspaceId: string | undefined;
  try {
    const { activeProject } = useChatProjects();
    workspaceId = activeProject?.id;
  } catch {
    // No ChatProvider (test environment) — thumbnails degrade to pills
  }
  return (
    <>
      {(node.pendingQueued ?? []).map((q, i) => {
        const isErrored = !!node.queueErrored;
        const tone = isErrored ? 'tone-danger' : 'tone-select';
        const captionSuffix = i === 0
          ? (isErrored ? ' · paused — review and send manually' : ' · sends when stream ends')
          : '';
        return (
          <div key={q.id} className={`t-pre-block ${tone}`}>
            <div className="t-pre-block-col">
              <div className="t-pre-block-cap">
                queued <b>{i + 1}</b>{captionSuffix}
              </div>
              <div className="t-pre-block-body">
                {q.value.replace(/\s+/g, ' ').trim()}
              </div>
            </div>
            <button
              type="button"
              aria-label="Dequeue message"
              className="t-pre-block-x"
              onClick={() => onRestoreQueued(q.id)}
            >
              ×
            </button>
          </div>
        );
      })}

      {(node.pendingComments ?? []).map((c, i) => (
        <EditableCommentChip
          key={c.id}
          index={i}
          quotedText={c.quotedText}
          body={c.body}
          onEdit={(body) => onEditPendingComment(c.id, body)}
          onRemove={() => onRemovePendingComment(c.id)}
        />
      ))}

      {quotedText && (
        <div className="t-pre-block tone-accent">
          <div className="t-pre-block-col">
            <div className="t-pre-block-cap">
              replying to <b>selection</b>
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
                <span style={{ fontSize: 10, opacity: 0.7 }}>📄</span>
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

function EditableCommentChip({
  index,
  quotedText,
  body,
  onEdit,
  onRemove,
}: {
  index: number;
  quotedText: string;
  body: string;
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
