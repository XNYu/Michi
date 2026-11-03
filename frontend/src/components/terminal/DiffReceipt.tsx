import React, { useMemo, useState } from 'react';
import { AnimatePresence, PresenceContext, motion } from 'motion/react';
import type { ChatMessage } from '../../state/chatTypes';
import { deriveDiffReceipt } from '../../lib/turnDiffReceipt';
import { EASE } from '../../motion/tokens';
import { Reveal } from './agentBlockMotion';
import { DiffModal } from './DiffModal';

export interface DiffReceiptProps {
  /** The turn's final assistant message (tool calls live here). */
  message: ChatMessage;
  /** Workspace owning the pane — needed for the click-to-diff endpoint. */
  workspaceId: string;
  /** Grow in on mount: the turn just ended on screen (read on mount only).
   *  A receipt there when the transcript opens renders settled. */
  enter?: boolean;
}

/** A receipt arriving at the turn's end grows in under the reply (180ms). */
const RECEIPT_FROM = { height: 0, opacity: 0, overflow: 'hidden' } as const;
const RECEIPT_TO = {
  height: 'auto',
  opacity: 1,
  transition: { height: { duration: 0.18, ease: EASE.out }, opacity: { duration: 0.14, ease: 'linear' } },
  transitionEnd: { overflow: 'visible' },
} as const;
/** Keeps the receipt's margin inside the growing box, clipping or not. */
const RECEIPT_GROW_STYLE: React.CSSProperties = { display: 'flow-root' };

/**
 * Turn diff receipt — a compact "N files changed (+X −Y)" chip rendered
 * below the last assistant message of a completed turn. Expands to a
 * per-file list; clicking a file opens a read-only unified-diff modal.
 *
 * Renders nothing when the turn had no successful write/edit tool calls.
 * The caller gates on turn completion (status !== 'streaming').
 */
export function DiffReceipt({ message, workspaceId, enter = false }: DiffReceiptProps) {
  const receipt = useMemo(() => deriveDiffReceipt(message), [message]);
  const [expanded, setExpanded] = useState(false);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  // Decided once, so the element tree never changes under the receipt.
  const [grows] = useState(enter);

  if (!receipt) return null;

  const { files, totalAdded, totalRemoved } = receipt;
  const fileWord = files.length === 1 ? 'file' : 'files';
  // Subagent-relayed / Codex edits recover the path but not the line deltas,
  // so their counts are 0 and would render a misleading "+0 −0". Only show
  // the totals when every file's counts are locally derivable; otherwise the
  // click-through diff (live `git diff`) is the source of truth.
  const showTotals = files.every((f) => f.countsKnown);

  const card = (
    <div
      data-testid="diff-receipt"
      style={{
        fontSize: 'var(--fs-sm)',
        fontFamily: 'var(--ui-font)',
        marginTop: 2,
        padding: '2px 0',
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
          {files.length} {fileWord} changed
          {showTotals && (
            <>
              {' '}
              <span style={{ color: 'var(--term-digest)' }}>+{totalAdded}</span>{' '}
              <span style={{ color: 'var(--term-danger)' }}>−{totalRemoved}</span>
            </>
          )}
        </span>
        <span style={{ color: 'var(--term-muted)', flexShrink: 0, marginLeft: 8 }}>
          {expanded ? '⌃' : '›'}
        </span>
      </button>

      {/* The file list opens and closes as a height disclosure (260/160ms). */}
      <Reveal show={expanded}>
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
              {f.countsKnown && (
                <span style={{ flexShrink: 0, marginLeft: 8 }}>
                  <span style={{ color: 'var(--term-digest)' }}>+{f.added}</span>{' '}
                  <span style={{ color: 'var(--term-danger)' }}>−{f.removed}</span>
                </span>
              )}
            </button>
          ))}
        </div>
      </Reveal>

      {/* ModalShell plays its exit (110ms) when it leaves this presence. */}
      <AnimatePresence>
        {diffPath && (
          <DiffModal
            key={diffPath}
            workspaceId={workspaceId}
            filePath={diffPath}
            onClose={() => setDiffPath(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
  if (!grows) return card;
  return (
    // Its own entrance: an enclosing AnimatePresence child must not settle it.
    <PresenceContext.Provider value={null}>
      <motion.div initial={RECEIPT_FROM} animate={RECEIPT_TO} style={RECEIPT_GROW_STYLE}>
        {card}
      </motion.div>
    </PresenceContext.Provider>
  );
}
