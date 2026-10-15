import React from 'react';
import { Circle, CircleAlert, LoaderCircle } from 'lucide-react';
import { relativeTime } from '../../lib/relativeTime';
import type { ChatNodeState } from '../../state/chatTypes';
import { BranchIcon } from './icons';

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
}

const branchStatuses = {
  idle: { label: 'Idle', Icon: Circle },
  streaming: { label: 'Running', Icon: LoaderCircle },
  error: { label: 'Needs attention', Icon: CircleAlert },
} as const;

export const BranchAnchorRow = React.memo(function BranchAnchorRow({
  title,
  messageCount,
  createdAt,
  status,
  onOpen,
}: BranchAnchorRowProps): JSX.Element {
  const msgLabel = messageCount === 1 ? '1 message' : `${messageCount} messages`;
  const timeLabel = relativeTime(createdAt);
  const metaId = React.useId();
  const { label, Icon } = branchStatuses[status];

  return (
    <button
      type="button"
      className="t-branch-anchor-row"
      aria-label={`Open branch: ${title}`}
      aria-describedby={metaId}
      onClick={onOpen}
    >
      <span className="t-branch-anchor-glyph" aria-hidden><BranchIcon size={18} /></span>
      <span className="t-branch-anchor-name">{title}</span>
      <span className="t-branch-anchor-meta" id={metaId}>
        <span className={`t-branch-anchor-status is-${status}`}>
          <Icon size={13} aria-hidden />{label}
        </span>
        <span className="t-branch-anchor-details">
          <span>{msgLabel}</span><span aria-hidden>·</span><span>{timeLabel}</span>
        </span>
      </span>
    </button>
  );
});
