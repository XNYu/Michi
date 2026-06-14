import React from 'react';
import { relativeTime } from '../../lib/relativeTime';

export interface BranchAnchorRowProps {
  /** Display title of the child branch. */
  title: string;
  /** Number of messages in the child. Renders as "1 message" / "3 messages". */
  messageCount: number;
  /** Unix ms when the fork was created. Used for relative time display. */
  createdAt: number;
  /** True iff the child branch's status === 'streaming'. Triggers the pulse dot. */
  streaming: boolean;
  /** Click handler invoked when the title is clicked. */
  onOpen: () => void;
}

export const BranchAnchorRow = React.memo(function BranchAnchorRow({
  title,
  messageCount,
  createdAt,
  streaming,
  onOpen,
}: BranchAnchorRowProps): JSX.Element {
  const msgLabel = messageCount === 1 ? '1 message' : `${messageCount} messages`;
  const timeLabel = relativeTime(createdAt);

  return (
    <div className="t-pre-block tone-mauve" style={{ margin: '0 0 12px 0' }}>
      <div className="t-pre-block-col">
        <div className="t-pre-block-cap">
          ↳{' '}
          <button
            className="t-branch-anchor-title"
            onClick={onOpen}
          >
            {title}
          </button>
          <span style={{ color: 'var(--term-mid)', marginLeft: 6 }}>
            · {msgLabel} · {timeLabel}
          </span>
          {streaming && <span aria-hidden className="t-branch-anchor-pulse" />}
        </div>
      </div>
    </div>
  );
});
