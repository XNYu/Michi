import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight } from 'lucide-react';
import { relativeTime } from '../../lib/relativeTime';
import type { ChatNodeState } from '../../state/chatTypes';
import { BranchStatusLabel } from './BranchAnchorRow';
import { BranchIcon } from './icons';

export interface BranchQuoteAnchor {
  childNodeId: string;
  title: string;
  /** When the branch was made. */
  createdAt: number;
  status: ChatNodeState['status'];
  /** What the user asked in the branch: its first message. */
  question?: string;
  /** The reply to that question, once it has finished. */
  reply?: string;
  onOpen: () => void;
}

/** Branches shown with their question and reply; any more get one line each. */
const EXPANDED_BRANCHES = 2;

/**
 * One branch as a footnote to the passage: its title, then what was asked in
 * it and what it answered. A quiet branch shows its age, a running or failed
 * one its state. The whole section opens the branch.
 */
function BranchCardItem({ anchor, compact, onOpen }: {
  anchor: BranchQuoteAnchor;
  compact: boolean;
  onOpen: () => void;
}) {
  const stateId = useId();
  const exchangeId = useId();
  const exchange = !compact && (anchor.question || anchor.reply || anchor.status === 'streaming');
  return (
    <button
      type="button"
      className={`t-branch-card-item${compact ? ' is-compact' : ''}`}
      aria-label={`Open branch: ${anchor.title}`}
      aria-describedby={exchange ? `${stateId} ${exchangeId}` : stateId}
      onClick={onOpen}
    >
      <span className="t-branch-card-head">
        <BranchIcon size={13} className="t-branch-card-glyph" />
        <span className="t-branch-card-title">{anchor.title}</span>
        <span className="t-branch-card-state" id={stateId}>
          {anchor.status === 'idle'
            ? <span className="t-branch-card-time">{relativeTime(anchor.createdAt)}</span>
            : <BranchStatusLabel status={anchor.status} size={12} />}
        </span>
        <ArrowUpRight className="t-branch-card-open" size={13} aria-hidden />
      </span>
      {exchange && (
        <span className="t-branch-card-exchange" id={exchangeId}>
          {anchor.question && (
            <>
              <span className="t-branch-card-who">you</span>
              <span className="t-branch-card-question">{anchor.question}</span>
            </>
          )}
          {anchor.reply ? (
            <>
              <span className="t-branch-card-who">michi</span>
              <span className="t-branch-card-reply">{anchor.reply}</span>
            </>
          ) : anchor.status === 'streaming' && (
            <>
              <span className="t-branch-card-who">michi</span>
              <span className="t-branch-card-typing">
                <span className="sr-only">Writing a reply</span>
                <span aria-hidden className="typing-dot" />
                <span aria-hidden className="typing-dot" style={{ animationDelay: '.15s' }} />
                <span aria-hidden className="typing-dot" style={{ animationDelay: '.3s' }} />
              </span>
            </>
          )}
        </span>
      )}
    </button>
  );
}

interface BranchQuoteUnderlineProps {
  /** All branch children whose quotedText matches the wrapped text. Render an entry per anchor in the hover card. */
  anchors: BranchQuoteAnchor[];
  children: ReactNode;
}

const CARD_WIDTH = 364; // = the width of .t-branch-card in index.css
const CARD_GAP = 6;
const VIEWPORT_MARGIN = 8;
const ESTIMATED_CARD_HEIGHT = 120; // until the open card has been measured
const CLOSE_DELAY_MS = 100;

/** Hides the card that is open, so moving between passages never shows two. */
let hideOpenCard: (() => void) | null = null;

/**
 * A dotted underline over a passage that child branches quoted. Hovering it,
 * focusing it or tapping it opens a card listing those branches; the card
 * stays while the pointer or focus is on it. Enter or Space moves the focus
 * into the card, Esc closes it.
 */
export function BranchQuoteUnderline({ anchors, children }: BranchQuoteUnderlineProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [cardHeight, setCardHeight] = useState(ESTIMATED_CARD_HEIGHT);
  const spanRef = useRef<HTMLSpanElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const focusCardRef = useRef(false);
  const refocusRef = useRef(false);
  const cardId = useId();

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const hide = useCallback(() => {
    cancelClose();
    setOpen(false);
  }, [cancelClose]);

  const show = useCallback(() => {
    cancelClose();
    if (hideOpenCard !== hide) {
      hideOpenCard?.();
      hideOpenCard = hide;
    }
    if (spanRef.current) setRect(spanRef.current.getBoundingClientRect());
    setOpen(true);
  }, [cancelClose, hide]);

  const scheduleHide = useCallback(() => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(hide, CLOSE_DELAY_MS);
  }, [cancelClose, hide]);

  useEffect(() => cancelClose, [cancelClose]);

  useEffect(() => {
    if (!open) return undefined;
    let frame: number | null = null;
    let scroller: Element | null = null;
    const track = () => {
      frame = null;
      const span = spanRef.current;
      if (!span?.isConnected) {
        hide();
        return;
      }
      const next = span.getBoundingClientRect();
      const clip = scroller?.getBoundingClientRect();
      // Scrolled out of its pane: the card would point at nothing.
      if (clip && (next.bottom <= clip.top || next.top >= clip.bottom)) {
        hide();
        return;
      }
      setRect(next);
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(track);
    };
    const onScroll = (event: Event) => {
      // Other panes scroll too (a streaming reply follows its tail); only the
      // passage's own scrollers move it.
      const target = event.target;
      const span = spanRef.current;
      if (!span || !(target instanceof Node) || !target.contains(span)) return;
      if (target instanceof Element) scroller = target;
      schedule();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && (spanRef.current?.contains(target) || cardRef.current?.contains(target))) return;
      hide();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // The card is an Esc layer ("over"), so the page's own Esc yields to it.
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      const focusInCard = !!cardRef.current?.contains(document.activeElement);
      hide();
      if (focusInCard && spanRef.current) {
        // Back on the passage, without opening the card again.
        refocusRef.current = true;
        spanRef.current.focus();
        refocusRef.current = false;
      }
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', schedule);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
      if (hideOpenCard === hide) hideOpenCard = null;
    };
  }, [open, hide]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!open || !card) return;
    if (card.offsetHeight > 0) setCardHeight(card.offsetHeight);
    if (focusCardRef.current) {
      focusCardRef.current = false;
      card.querySelector<HTMLButtonElement>('button')?.focus();
    }
  }, [open, anchors]);

  const leavesCard = (next: EventTarget | null) => {
    const node = next instanceof Node ? next : null;
    return !cardRef.current?.contains(node) && !spanRef.current?.contains(node);
  };

  return (
    <>
      <span
        ref={spanRef}
        className="t-branch-anchor-underline"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        // Touch has no hover: a tap opens the card (onClick) and a tap
        // elsewhere closes it.
        onPointerEnter={(event) => { if (event.pointerType !== 'touch') show(); }}
        onPointerLeave={(event) => { if (event.pointerType !== 'touch') scheduleHide(); }}
        onClick={show}
        onFocus={() => { if (!refocusRef.current) show(); }}
        onBlur={(event) => { if (leavesCard(event.relatedTarget)) scheduleHide(); }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          const firstItem = cardRef.current?.querySelector<HTMLButtonElement>('button');
          if (open && firstItem) {
            firstItem.focus();
          } else {
            focusCardRef.current = true;
            show();
          }
        }}
      >
        {children}
      </span>
      {open && rect && createPortal(
        <div
          ref={cardRef}
          id={cardId}
          role="group"
          aria-label={anchors.length === 1 ? 'Branch from this passage' : `${anchors.length} branches from this passage`}
          data-escape-layer="over"
          className="t-branch-card"
          style={{
            left: Math.min(
              Math.max(VIEWPORT_MARGIN, rect.left),
              Math.max(VIEWPORT_MARGIN, window.innerWidth - Math.min(CARD_WIDTH, window.innerWidth - 2 * VIEWPORT_MARGIN) - VIEWPORT_MARGIN),
            ),
            top:
              rect.bottom + CARD_GAP + cardHeight > window.innerHeight
                ? Math.max(VIEWPORT_MARGIN, rect.top - cardHeight - CARD_GAP)
                : rect.bottom + CARD_GAP,
          }}
          onPointerEnter={cancelClose}
          onPointerLeave={(event) => { if (event.pointerType !== 'touch') scheduleHide(); }}
          onFocus={cancelClose}
          onBlur={(event) => { if (leavesCard(event.relatedTarget)) scheduleHide(); }}
        >
          {anchors.map((a, i) => (
            <BranchCardItem
              key={a.childNodeId}
              anchor={a}
              compact={i >= EXPANDED_BRANCHES}
              onOpen={() => {
                hide();
                a.onOpen();
              }}
            />
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
