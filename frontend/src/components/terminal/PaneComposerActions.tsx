import React from 'react';
import { kbd } from '../../lib/platform';

export type PaneComposerSendMode = 'send' | 'stop' | 'retry';

interface PaneComposerActionsProps {
  draftHasText: boolean;
  sendMode: PaneComposerSendMode;
  streaming: boolean;
  sendDisabled: boolean;
  steerNative?: boolean;
  onBranch: () => void;
  onSend: () => void;
  onStop: () => void;
  onRetry: () => void;
}

export function PaneComposerActions({
  draftHasText,
  sendMode,
  streaming,
  sendDisabled,
  steerNative = false,
  onBranch,
  onSend,
  onStop,
  onRetry,
}: PaneComposerActionsProps) {
  return (
    <>
      {draftHasText && (
        <button
          type="button"
          className="t-action-btn is-outline"
          onClick={onBranch}
          aria-label={`Branch (${kbd('mod', 'enter')})`}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M8 14V9" />
            <path d="M8 9 L4 5" />
            <path d="M8 9 L12 5" />
            <circle cx="4" cy="4" r="1.4" />
            <circle cx="12" cy="4" r="1.4" />
            <circle cx="8" cy="14" r="1.4" />
          </svg>
          <span className="t-action-kbd">
            Branch <span className="t-action-kbd-key">{kbd('mod', 'enter')}</span>
          </span>
        </button>
      )}

      <button
        type="button"
        className={
          sendMode === 'stop' || sendMode === 'retry'
            ? 't-action-btn is-primary'
            : streaming && !sendDisabled
              ? 't-action-btn is-queue'
              : 't-action-btn is-primary'
        }
        onClick={
          sendMode === 'stop'
            ? onStop
            : sendMode === 'retry'
              ? onRetry
              : onSend
        }
        disabled={sendMode === 'send' ? sendDisabled : false}
        aria-label={
          sendMode === 'stop'
            ? 'Stop stream'
            : sendMode === 'retry'
              ? 'Retry last turn'
              : streaming
                ? steerNative
                  ? 'Steer (inject this turn)'
                  : 'Send next (Enter) — sends after the current response'
                : 'Send (Enter)'
        }
      >
        {sendMode === 'stop' && (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <rect x="3" y="3" width="10" height="10" rx="1.5" />
          </svg>
        )}
        {sendMode === 'retry' && (
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
            <path d="M3 8a5 5 0 1 0 1.5-3.5" />
            <polyline points="3 2 3 5.5 6.5 5.5" />
          </svg>
        )}
        {sendMode === 'send' && (
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
        )}
        <span className="t-action-kbd">
          {sendMode === 'stop'
            ? 'Stop'
            : sendMode === 'retry'
              ? 'Retry'
              : <>{streaming ? (steerNative ? 'Steer' : 'Send next') : 'Send'} <span className="t-action-kbd-key">{kbd('enter')}</span></>
          }
        </span>
      </button>
    </>
  );
}
