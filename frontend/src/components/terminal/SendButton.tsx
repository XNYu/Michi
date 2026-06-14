import React from 'react';

export interface SendButtonProps {
  onClick: () => void;
  disabled?: boolean;
  /** When true, render dashed shaft to indicate "queue while streaming". */
  streaming?: boolean;
  /** Override the visible label (default: "Send"). */
  label?: string;
  /** Override the keyboard hint (default: "↵"). */
  kbd?: string;
  ariaLabel?: string;
}

export function SendButton({
  onClick,
  disabled,
  streaming,
  label = 'Send',
  kbd = '↵',
  ariaLabel,
}: SendButtonProps) {
  return (
    <button
      type="button"
      className="t-action-btn is-primary"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel ?? label}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M8 13V3" strokeDasharray={streaming ? '1.6 2' : undefined} />
        <path d="M3.5 7.5L8 3l4.5 4.5" />
      </svg>
      <span className="t-action-kbd">
        {label} <span className="t-action-kbd-key">{kbd}</span>
      </span>
    </button>
  );
}
