import React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { usePhoneLayout } from '../../hooks/usePhoneLayout';
import { kbd } from '../../lib/platform';
import { DUR, EASE, SPRING } from '../../motion/tokens';
import { ContextRing, type ContextRingProps } from './ContextRing';
import { BranchIcon } from './icons';
import { COMPOSER_ICON_STROKE, composerIconSize } from './PaneComposerToolbarLeft';

export type PaneComposerSendMode = 'send' | 'stop' | 'retry';

/** The glyph on the send plate; a change of glyph cross-scales. */
export type PaneComposerGlyph = 'send' | 'send-next' | 'stop' | 'retry' | 'resume';

export function composerGlyph(sendMode: PaneComposerSendMode, streaming: boolean, resumeTurn: boolean): PaneComposerGlyph {
  if (sendMode === 'stop') return 'stop';
  if (sendMode === 'retry') return resumeTurn ? 'resume' : 'retry';
  return streaming ? 'send-next' : 'send';
}

const STROKED = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function glyphPaint(glyph: PaneComposerGlyph) {
  return glyph === 'stop' || glyph === 'resume' ? { fill: 'currentColor' } : STROKED;
}

function glyphShape(glyph: PaneComposerGlyph): React.ReactNode {
  switch (glyph) {
    case 'stop':
      return <rect x="3" y="3" width="10" height="10" rx="1.5" />;
    case 'resume':
      return <path d="M4.5 3.2v9.6a.6.6 0 0 0 .92.5l7-4.8a.6.6 0 0 0 0-1l-7-4.8a.6.6 0 0 0-.92.5z" />;
    case 'retry':
      return <><path d="M3 8a5 5 0 1 0 1.5-3.5" /><polyline points="3 2 3 5.5 6.5 5.5" /></>;
    case 'send':
    case 'send-next':
      // Send next dashes the shaft: it goes out after the current response.
      return <><path d="M8 13V3" strokeDasharray={glyph === 'send-next' ? '1.6 2' : undefined} /><path d="M3.5 7.5L8 3l4.5 4.5" /></>;
  }
}

// The outgoing glyph shrinks away fast while the next one settles in its
// place (popLayout lifts the outgoing one out of the plate's layout, so the
// two never sit side by side). Reduced motion keeps only the fade.
const GLYPH_INITIAL = { opacity: 0, scale: 0.5 };
const GLYPH_ANIMATE = { opacity: 1, scale: 1, transition: SPRING.snappy };
const GLYPH_EXIT = { opacity: 0, scale: 0.5, transition: { duration: DUR.soft, ease: EASE.out } };

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
  const glyphKind = composerGlyph(sendMode, streaming, resumeTurn);
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
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={glyphKind}
            data-glyph={glyphKind}
            aria-hidden="true"
            style={{ display: 'inline-flex' }}
            initial={GLYPH_INITIAL}
            animate={GLYPH_ANIMATE}
            exit={GLYPH_EXIT}
          >
            <svg width={glyph} height={glyph} viewBox="0 0 16 16" {...glyphPaint(glyphKind)} aria-hidden="true">
              {glyphShape(glyphKind)}
            </svg>
          </motion.span>
        </AnimatePresence>
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
