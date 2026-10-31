import React from 'react';
import { usePhoneLayout } from '../../hooks/usePhoneLayout';
import { kbd } from '../../lib/platform';
import { ContextRing, type ContextRingProps } from './ContextRing';
import { BranchIcon } from './icons';
import { COMPOSER_ICON_STROKE, composerIconSize } from './PaneComposerToolbarLeft';

export type PaneComposerSendMode = 'send' | 'stop' | 'retry';

interface PaneComposerActionsProps {
  draftHasText: boolean;
  sendMode: PaneComposerSendMode;
  streaming: boolean;
  sendDisabled: boolean;
  onBranch: () => void;
  onSend: () => void;
  onStop: () => void;
  onRetry: () => void;
  allowBranch?: boolean;
  /** An uncertain outcome checks the original task instead of resending it. */
  inspectOriginal?: boolean;
  checkingOriginal?: boolean;
  /** A restart cut the last turn short: the retry action carries it on instead of resending it. */
  resumeTurn?: boolean;
  /** Context window usage percentage (0–100). Shows ring indicator when present. */
  contextUsagePercentage?: number | null;
  /** Token breakdown for the ring tooltip. */
  usageSummary?: ContextRingProps['usageSummary'];
  /** What Stop also ends (e.g. a running workflow); shown as its tooltip. */
  stopHint?: string;
}

export function PaneComposerActions({
  draftHasText,
  sendMode,
  streaming,
  sendDisabled,
  onBranch,
  onSend,
  onStop,
  onRetry,
  allowBranch = true,
  inspectOriginal = false,
  checkingOriginal = false,
  resumeTurn = false,
  contextUsagePercentage,
  usageSummary,
  stopHint,
}: PaneComposerActionsProps) {
  const phone = usePhoneLayout();
  // Send/Stop/Retry glyphs sit on the inset plate (index.css): 14px on its 26px, 16px on a phone's 32px.
  const glyph = phone ? 16 : 14;
  return (
    <>
      <ContextRing percentage={contextUsagePercentage} usageSummary={usageSummary} />
      {draftHasText && allowBranch && (
        <button
          type="button"
          className="t-action-btn is-outline"
          onClick={onBranch}
          aria-label={`Branch (${kbd('mod', 'enter')})`}
        >
          <BranchIcon size={composerIconSize(phone)} strokePx={COMPOSER_ICON_STROKE} />
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
        disabled={sendMode === 'send' ? sendDisabled : sendMode === 'retry' && checkingOriginal}
        title={sendMode === 'stop' ? stopHint : undefined}
        aria-label={
          sendMode === 'stop'
            ? stopHint ? `Stop stream. ${stopHint}` : 'Stop stream'
          : sendMode === 'retry'
              ? resumeTurn ? 'Resume the interrupted turn' : inspectOriginal ? 'Check original turn' : 'Retry last turn'
              : streaming
                ? 'Send next (Enter). Sends after the current response'
                : 'Send (Enter)'
        }
      >
        {sendMode === 'stop' && (
          <svg width={glyph} height={glyph} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <rect x="3" y="3" width="10" height="10" rx="1.5" />
          </svg>
        )}
        {sendMode === 'retry' && resumeTurn && (
          <svg width={glyph} height={glyph} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M4.5 3.2v9.6a.6.6 0 0 0 .92.5l7-4.8a.6.6 0 0 0 0-1l-7-4.8a.6.6 0 0 0-.92.5z" />
          </svg>
        )}
        {sendMode === 'retry' && !resumeTurn && (
          <svg
            width={glyph}
            height={glyph}
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
            width={glyph}
            height={glyph}
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
              ? resumeTurn ? 'Resume' : inspectOriginal ? checkingOriginal ? 'Checking…' : 'Check result' : 'Retry'
              : <>{streaming ? 'Send next' : 'Send'} <span className="t-action-kbd-key">{kbd('enter')}</span></>
          }
        </span>
      </button>
    </>
  );
}
