import React, { useMemo, useState } from 'react';
import type { ChatMessage } from '../../state/chatTypes';
import { deriveDiffReceipt } from '../../lib/turnDiffReceipt';
import { DiffModal } from './DiffModal';

export interface DiffReceiptProps {
  /** The turn's final assistant message (tool calls live here). */
  message: ChatMessage;
  /** Workspace owning the pane — needed for the click-to-diff endpoint. */
  workspaceId: string;
}

/**
 * Turn diff receipt — a compact "N files changed (+X −Y)" chip rendered
 * below the last assistant message of a completed turn. Expands to a
 * per-file list; clicking a file opens a read-only unified-diff modal.
 *
 * Renders nothing when the turn had no successful write/edit tool calls.
 * The caller gates on turn completion (status !== 'streaming').
 */
export function DiffReceipt({ message, workspaceId }: DiffReceiptProps) {
  const receipt = useMemo(() => deriveDiffReceipt(message), [message]);
  const [expanded, setExpanded] = useState(false);
  const [diffPath, setDiffPath] = useState<string | null>(null);

  if (!receipt) return null;

  const { files, totalAdded, totalRemoved } = receipt;
  const fileWord = files.length === 1 ? 'file' : 'files';

  return (
    <div
      data-testid="diff-receipt"
      style={{
        fontSize: 10.5,
        fontFamily: 'var(--ui-font)',
        marginTop: 4,
        padding: '3px 0',
        borderTop: '1px dotted var(--term-line)',
        color: 'var(--term-mid)',
      }}
    >
      <button
        type="button"
        data-testid="diff-receipt-header"
        onClick={() => setExpanded((e) => !e)}
        className="t-hover-fg"
        aria-expanded={expanded}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: 'transparent',
          border: 'none',
          padding: 0,
          color: 'inherit',
          font: 'inherit',
          cursor: 'pointer',
          textAlign: 'left',
          width: '100%',
        }}
      >
        <span style={{ opacity: 0.7, flexShrink: 0 }}>±</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          {files.length} {fileWord} changed{' '}
          <span style={{ color: 'var(--term-digest)' }}>+{totalAdded}</span>{' '}
          <span style={{ color: 'var(--term-danger)' }}>−{totalRemoved}</span>
        </span>
        <span style={{ color: 'var(--term-muted)', flexShrink: 0, marginLeft: 8 }}>
          {expanded ? '⌃' : '›'}
        </span>
      </button>

      {expanded && (
        <div style={{ marginTop: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {files.map((f) => (
            <button
              key={f.path}
              type="button"
              data-testid="diff-receipt-file"
              onClick={() => setDiffPath(f.path)}
              className="t-hover-fg"
              title={`show diff for ${f.path}`}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                paddingLeft: 16,
                background: 'transparent',
                border: 'none',
                color: 'inherit',
                font: 'inherit',
                cursor: 'pointer',
                textAlign: 'left',
                width: '100%',
              }}
            >
              <span style={{ opacity: 0.7, flexShrink: 0 }}>·</span>
              <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-all' }}>
                {f.path}
              </span>
              <span style={{ flexShrink: 0, marginLeft: 8 }}>
                <span style={{ color: 'var(--term-digest)' }}>+{f.added}</span>{' '}
                <span style={{ color: 'var(--term-danger)' }}>−{f.removed}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {diffPath && (
        <DiffModal
          workspaceId={workspaceId}
          filePath={diffPath}
          onClose={() => setDiffPath(null)}
        />
      )}
    </div>
  );
}
