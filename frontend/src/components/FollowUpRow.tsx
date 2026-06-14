import React, { useCallback } from 'react';

export interface FollowUpRowProps {
  index: number;
  question: string;
  onContinue: (question: string) => void;
  onBranch: (question: string) => void;
  disabled?: boolean;
}

export function FollowUpRow({
  index,
  question,
  onContinue,
  onBranch,
  disabled = false,
}: FollowUpRowProps): JSX.Element {
  const number = index + 1;
  const ariaContinue = `Continue follow-up ${number} in current pane: ${question}. Press B to branch into a new pane.`;
  const ariaBranch = `Branch follow-up ${number} into new pane: ${question}`;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (disabled) return;
      if (e.key === 'b' || e.key === 'B') {
        e.preventDefault();
        e.stopPropagation();
        onBranch(question);
      }
    },
    [disabled, onBranch, question],
  );

  const handleBranchClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      if (disabled) return;
      onBranch(question);
    },
    [disabled, onBranch, question],
  );

  return (
    <div
      className="t-followup-row"
      role="group"
      style={{ '--followup-delay': `${index * 90}ms` } as React.CSSProperties}
      data-disabled={disabled ? 'true' : undefined}
    >
      <span className="t-followup-num" aria-hidden>
        {number}.
      </span>
      <button
        type="button"
        className="t-followup-text"
        aria-label={ariaContinue}
        disabled={disabled}
        onClick={() => onContinue(question)}
        onKeyDown={handleKeyDown}
      >
        {question}
      </button>
      <button
        type="button"
        className="t-followup-branch"
        aria-label={ariaBranch}
        title="Branch into new pane"
        tabIndex={-1}
        disabled={disabled}
        onClick={handleBranchClick}
      >
        <span className="t-followup-branch-glyph" aria-hidden>⎇</span>
        <span className="t-followup-branch-label">Branch</span>
      </button>
    </div>
  );
}
