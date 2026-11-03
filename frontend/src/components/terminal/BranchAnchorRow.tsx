import React from 'react';
import { motion } from 'motion/react';
import { Circle, CircleAlert, LoaderCircle } from 'lucide-react';
import { relativeTime } from '../../lib/relativeTime';
import type { ChatNodeState } from '../../state/chatTypes';
import { EASE } from '../../motion/tokens';
import { LabelSwap } from './agentBlockMotion';
import { BranchIcon } from './icons';

/** A branch made just now grows into its list (180ms). */
export const ANCHOR_GROW_FROM = { height: 0, opacity: 0, overflow: 'hidden' } as const;
export const ANCHOR_GROW_TO = {
  height: 'auto',
  opacity: 1,
  transition: { duration: 0.18, ease: EASE.out },
  transitionEnd: { overflow: 'visible' },
} as const;
/** Keeps the row's margins inside the growing box, clipping or not. */
export const ANCHOR_GROW_STYLE: React.CSSProperties = { display: 'flow-root' };

export interface BranchAnchorRowProps {
  /** Display title of the child branch. */
  title: string;
  /** Number of messages in the child. Renders as "1 message" / "3 messages". */
  messageCount: number;
  /** Unix ms when the fork was created. Used for relative time display. */
  createdAt: number;
  status: ChatNodeState['status'];
  /** Opens the child branch from any part of the row. */
  onOpen: () => void;
  /** Grow in on mount: the branch was made just now (read on mount only). */
  enter?: boolean;
  /** The list's last row: rows keep their separators when wrapped to grow. */
  last?: boolean;
}

const branchStatuses = {
  idle: { label: 'Idle', Icon: Circle },
  streaming: { label: 'Running', Icon: LoaderCircle },
  error: { label: 'Needs attention', Icon: CircleAlert },
} as const;

/**
 * A branch's state as its glyph and word; the branch hover card shows it too.
 * A change of state cross-fades the word in place (the first one renders
 * settled); the outgoing one is aria-hidden.
 */
export function BranchStatusLabel({ status, size = 13 }: { status: ChatNodeState['status']; size?: number }): React.JSX.Element {
  const { label, Icon } = branchStatuses[status];
  return (
    <LabelSwap k={status} style={{ justifyItems: 'end' }}>
      <span className={`t-branch-anchor-status is-${status}`}>
        <Icon size={size} aria-hidden />{label}
      </span>
    </LabelSwap>
  );
}

const SEPARATOR: React.CSSProperties = { borderBottom: '1px solid var(--term-line)' };

export const BranchAnchorRow = React.memo(function BranchAnchorRow({
  title,
  messageCount,
  createdAt,
  status,
  onOpen,
  enter = false,
  last = true,
}: BranchAnchorRowProps): React.JSX.Element {
  const msgLabel = messageCount === 1 ? '1 message' : `${messageCount} messages`;
  const timeLabel = relativeTime(createdAt);
  const metaId = React.useId();
  // Decided once, so the element tree never changes under the row.
  const [grows] = React.useState(enter);

  const row = (
    <button
      type="button"
      className="t-branch-anchor-row"
      aria-label={`Open branch: ${title}`}
      aria-describedby={metaId}
      onClick={onOpen}
      // Wrapped, the row is its wrapper's last child, which drops the separator.
      style={grows && !last ? SEPARATOR : undefined}
    >
      <span className="t-branch-anchor-glyph" aria-hidden><BranchIcon size={18} /></span>
      <span className="t-branch-anchor-name">{title}</span>
      <span className="t-branch-anchor-meta" id={metaId}>
        <BranchStatusLabel status={status} />
        <span className="t-branch-anchor-details">
          <span>{msgLabel}</span><span aria-hidden>·</span><span>{timeLabel}</span>
        </span>
      </span>
    </button>
  );
  if (!grows) return row;
  return (
    <motion.div initial={ANCHOR_GROW_FROM} animate={ANCHOR_GROW_TO} style={ANCHOR_GROW_STYLE}>
      {row}
    </motion.div>
  );
});
