import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { relativeTime } from '../../lib/relativeTime';

export interface BranchQuoteAnchor {
  childNodeId: string;
  title: string;
  createdAt: number;
  streaming: boolean;
  onOpen: () => void;
}

interface BranchQuoteUnderlineProps {
  /** All branch children whose quotedText matches the wrapped text. Render an entry per anchor in the hover card. */
  anchors: BranchQuoteAnchor[];
  children: React.ReactNode;
}

const ESTIMATED_CARD_HEIGHT = 120; // rough max for a few-anchor card

export function BranchQuoteUnderline({ anchors, children }: BranchQuoteUnderlineProps): JSX.Element {
  const [hovered, setHovered] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const spanRef = useRef<HTMLSpanElement>(null);
  const closeTimerRef = useRef<number | null>(null);

  const open = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    // TODO(v2): refresh rect on scroll/resize so the card tracks the underline
    if (spanRef.current) setRect(spanRef.current.getBoundingClientRect());
    setHovered(true);
  };

  const scheduleClose = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
    }
    closeTimerRef.current = window.setTimeout(() => {
      setHovered(false);
      closeTimerRef.current = null;
    }, 100);
  };

  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
  }, []);

  return (
    <>
      <span
        ref={spanRef}
        className="t-branch-anchor-underline"
        role="button"
        tabIndex={0}
        onPointerEnter={open}
        onPointerLeave={scheduleClose}
        onFocus={open}
        onBlur={scheduleClose}
      >
        {children}
      </span>
      {hovered && rect && createPortal(
        <div
          className="t-branch-anchor-card"
          style={{
            left: Math.min(
              Math.max(8, rect.left),
              Math.max(8, window.innerWidth - 320 - 8),
            ),
            top:
              rect.bottom + 4 + ESTIMATED_CARD_HEIGHT > window.innerHeight
                ? Math.max(8, rect.top - ESTIMATED_CARD_HEIGHT - 4)
                : rect.bottom + 4,
          }}
          onPointerEnter={open}
          onPointerLeave={scheduleClose}
        >
          {anchors.map((a) => (
            <div key={a.childNodeId} className="t-branch-anchor-card-row">
              <button className="t-branch-anchor-title" onClick={a.onOpen}>{a.title}</button>
              {a.streaming && <span aria-hidden className="t-branch-anchor-pulse" />}
              <span className="t-branch-anchor-time">{relativeTime(a.createdAt)}</span>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
