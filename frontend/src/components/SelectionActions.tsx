import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface ViewRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface Anchor {
  /** Bounding rect of the whole selection, viewport coords. */
  bounds: ViewRect;
  /** Per-line selection rects, clipped to the scroll container viewport. */
  highlightRects: ViewRect[];
  /** Selected plain text. */
  text: string;
  /** Cloned Range so we can recompute the bounding box on scroll/resize. */
  range: Range;
}

export interface SelectionActionsProps {
  containerRef: React.RefObject<HTMLElement>;
  /** Quote-reply to the current pane/node. */
  onQuote: (quoted: string) => void;
  /** Branch: create a child thread seeded with the quote + a prompt. */
  onBranch: (quoted: string, prompt: string, anchorMessageId?: string) => void;
  /**
   * Comment: queue a reply-to-selection on the current node. Unlike
   * Quote / Branch this does not send or branch anything - the comment
   * sits in the node's pendingComments until the next outgoing prompt
   * is submitted, at which point TPane flushes them all into a
   * prepended markdown block.
   */
  onComment: (quoted: string, body: string) => void;
}

type ComposerMode = 'closed' | 'branch' | 'comment';

const POPUP_GAP = 16;
const BAR_APPROX_WIDTH = 280;
const COMPOSER_WIDTH = 340;
const COMPOSER_MIN_HEIGHT = 110;
const VIEWPORT_MARGIN = 8;

/**
 * Text-selection action bar + composer, rendered via portal so it can
 * escape pane clipping and overlap neighboring panes.
 *
 *   1. Select text inside containerRef → `[branch] [comment] [quote reply]`
 *      bar appears beside the selection.
 *   2. Branch / Comment → a composer replaces the bar at the same anchor:
 *      one input box, no preview. The textarea steals native selection
 *      focus, so we keep painting a lightweight highlight over the saved
 *      source range.
 *   3. Submit (⌘↵) → onBranch / onComment with (quoted, body). Esc /
 *      click away / selection cleared → close. Quote reply is one-shot:
 *      clicking it fires `onQuote(quoted)` without ever opening a
 *      composer.
 */
export default function SelectionActions({
  containerRef,
  onQuote,
  onBranch,
  onComment,
}: SelectionActionsProps) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [composerMode, setComposerMode] = useState<ComposerMode>('closed');
  const [prompt, setPrompt] = useState('');
  const [measuredSize, setMeasuredSize] = useState<{ width: number; height: number } | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  // Ref mirrors composerMode so the selectionchange handler always reads
  // the latest value, even if the event fires before useEffect swaps
  // listeners.
  const composerOpenRef = useRef(false);
  composerOpenRef.current = composerMode !== 'closed';

  // Track native selection while the composer is closed.
  // Uses content-stability detection: the bar only appears once the selected
  // text stops changing for STABLE_THRESHOLD ms. This naturally debounces
  // double/triple-click intermediate states without needing an isDragging
  // state machine, and doesn't conflict with scroll events.
  const stableTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSelTextRef = useRef('');

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const STABLE_THRESHOLD = 80; // ms — content must be unchanged this long

    const updateFromSelection = () => {
      if (composerOpenRef.current) { return; }
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        // Selection cleared → immediately hide, reset stability tracking
        if (stableTimerRef.current) { clearTimeout(stableTimerRef.current); stableTimerRef.current = null; }
        lastSelTextRef.current = '';
        setAnchor(null);
        return;
      }
      const text = sel.toString().trim();
      if (!text || text.length < 2) {
        if (stableTimerRef.current) { clearTimeout(stableTimerRef.current); stableTimerRef.current = null; }
        lastSelTextRef.current = '';
        setAnchor(null);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) {
        if (stableTimerRef.current) { clearTimeout(stableTimerRef.current); stableTimerRef.current = null; }
        lastSelTextRef.current = '';
        setAnchor(null);
        return;
      }

      const measured = measureRange(range, container);
      // Transient zero-size rects show up mid-drag; don't clobber a good anchor
      // with a collapsed one — the next selectionchange will bring the real box.
      if (!measured) return;

      const contentChanged = text !== lastSelTextRef.current;
      lastSelTextRef.current = text;

      if (anchor) {
        // Bar already visible → update position immediately (no delay),
        // so it follows drag-to-extend without feeling sluggish.
        setAnchor({
          bounds: measured.bounds,
          highlightRects: measured.highlightRects,
          text,
          range: range.cloneRange(),
        });
      } else {
        // Bar not yet visible → wait for content to stabilize.
        // Every time text changes, reset the timer.
        if (contentChanged || !stableTimerRef.current) {
          if (stableTimerRef.current) clearTimeout(stableTimerRef.current);
          stableTimerRef.current = setTimeout(() => {
            stableTimerRef.current = null;
            // Re-read selection at the time the timer fires — it may have
            // changed or disappeared during the wait.
            const freshSel = window.getSelection();
            if (!freshSel || freshSel.isCollapsed) return;
            const freshText = freshSel.toString().trim();
            if (!freshText || freshText.length < 2) return;
            const freshRange = freshSel.getRangeAt(0);
            if (!container.contains(freshRange.commonAncestorContainer)) return;
            const freshMeasured = measureRange(freshRange, container);
            if (!freshMeasured) return;
            setAnchor({
              bounds: freshMeasured.bounds,
              highlightRects: freshMeasured.highlightRects,
              text: freshText,
              range: freshRange.cloneRange(),
            });
          }, STABLE_THRESHOLD);
        }
      }
    };

    document.addEventListener('selectionchange', updateFromSelection);
    return () => {
      document.removeEventListener('selectionchange', updateFromSelection);
      if (stableTimerRef.current) { clearTimeout(stableTimerRef.current); stableTimerRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, anchor]);

  // Reposition on scroll / resize. Coalesce bursts through a single rAF: a
  // scroll generates many events per frame, and each recompute reads layout
  // (getBoundingClientRect) + setState. Without throttling that re-measures
  // and re-renders multiple times per frame while the user scrolls a pane
  // that happens to contain a selection. One measurement per frame is enough
  // to keep the highlight glued to the text.
  useEffect(() => {
    if (!anchor) return;
    let frame: number | null = null;
    const recompute = () => {
      try {
        const measured = measureRange(anchor.range, containerRef.current);
        if (!measured) return;
        setAnchor((prev) => (prev ? { ...prev, ...measured } : prev));
      } catch {
        /* range detached; next selection change rebuilds */
      }
    };
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        recompute();
      });
    };
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
    };
  }, [anchor?.range]);

  const close = useCallback(() => {
    setAnchor(null);
    setComposerMode('closed');
    setPrompt('');
    window.getSelection()?.removeAllRanges();
  }, []);

  // Close on outside mousedown (anywhere except the popup itself).
  useEffect(() => {
    if (!anchor) return;
    const onMouseDown = (e: MouseEvent) => {
      const popup = popupRef.current;
      if (popup && popup.contains(e.target as Node)) return;
      close();
    };
    // Use mousedown (not click) so the selection change that follows a
    // click outside doesn't race with the next selectionchange handler.
    window.addEventListener('mousedown', onMouseDown);
    return () => window.removeEventListener('mousedown', onMouseDown);
  }, [anchor, close]);

  const openComposer = useCallback(
    (mode: Exclude<ComposerMode, 'closed'>) => {
      if (!anchor) return;
      setComposerMode(mode);
      setPrompt('');
      requestAnimationFrame(() => composerInputRef.current?.focus());
    },
    [anchor],
  );

  const submitComposer = useCallback(() => {
    if (!anchor) return;
    const p = prompt.trim();
    if (!p) return;
    if (composerMode === 'branch') {
      onBranch(anchor.text, p, findMessageIdForRange(anchor.range));
    } else if (composerMode === 'comment') {
      onComment(anchor.text, p);
    } else {
      return;
    }
    close();
  }, [anchor, prompt, composerMode, onBranch, onComment, close]);

  const fireQuote = useCallback(() => {
    if (!anchor) return;
    onQuote(anchor.text);
    close();
  }, [anchor, onQuote, close]);

  // Global hotkeys while the bar / composer is active.
  useEffect(() => {
    if (!anchor) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (composerMode !== 'closed') return; // In-composer keys handled on textarea.
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        openComposer('branch');
      } else if (e.key === "'" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        fireQuote();
      } else if (e.key === ';' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        openComposer('comment');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [anchor, composerMode, openComposer, close, fireQuote]);

  // Reset measured size whenever the popup mode/content changes so we can
  // re-measure with the new layout instead of carrying stale dimensions.
  useLayoutEffect(() => {
    setMeasuredSize(null);
  }, [composerMode, anchor?.text]);

  // Measure actual rendered popup size so placement uses real height/width
  // instead of the constant estimates — those underestimate the composer
  // and let it overlap the selection when placed above.
  //
  // Deps are scoped to the inputs that actually change the popup's *size*:
  // mode (bar↔composer), the selected text (bar width), and the composer
  // draft (textarea auto-grow). It must NOT depend on `anchor` itself — that
  // object gets a fresh reference on every scroll frame (its bounds update as
  // the selection moves), so depending on it would re-run this layout effect
  // every scroll tick and force a synchronous reflow per frame, dropping the
  // chat pane off the compositor thread and tanking scroll smoothness.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (!anchor) return;
    const el = popupRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    setMeasuredSize((prev) => {
      if (prev && Math.abs(prev.width - rect.width) < 0.5 && Math.abs(prev.height - rect.height) < 0.5) {
        return prev;
      }
      return { width: rect.width, height: rect.height };
    });
  }, [anchor?.text, composerMode, prompt]);

  if (!anchor) return null;

  const styles = getStyles();
  const composerOpen = composerMode !== 'closed';
  const submitDisabled = !prompt.trim();
  const fallbackWidth = composerOpen ? COMPOSER_WIDTH : BAR_APPROX_WIDTH;
  const fallbackHeight = composerOpen ? COMPOSER_MIN_HEIGHT : 34;
  const popupWidth = measuredSize?.width ?? fallbackWidth;
  const popupHeight = measuredSize?.height ?? fallbackHeight;
  const bottomBoundary = getComposerTopBoundary(containerRef.current);
  const placement = placePopup(
    anchor.bounds,
    anchor.highlightRects,
    bottomBoundary,
    popupWidth,
    popupHeight,
  );

  const composerHeaderLabel =
    composerMode === 'branch' ? 'BRANCH FROM SELECTION' : 'COMMENT ON SELECTION';
  const composerPlaceholder =
    composerMode === 'branch'
      ? 'ask something about this selection…'
      : 'your reply to this passage…';

  const originY = placement.above ? 'top' : 'bottom';

  return createPortal(
    <>
      {composerOpen && anchor.highlightRects.length > 0 && (
        <div className={styles.highlightLayer} aria-hidden="true">
          {anchor.highlightRects.map((rect, i) => (
            <span
              key={`${i}-${rect.left}-${rect.top}`}
              className={styles.highlightMark}
              style={{
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
              }}
            />
          ))}
        </div>
      )}
      <div
        ref={popupRef}
        key={composerOpen ? `composer-${composerMode}` : 'bar'}
        className={`${composerOpen ? styles.composerWrap : styles.barWrap} sel-actions-enter`}
        style={{
          position: 'fixed',
          left: placement.left,
          top: placement.top,
          width: composerOpen ? COMPOSER_WIDTH : undefined,
          zIndex: 9999,
          transformOrigin: `left ${originY}`,
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {composerOpen ? (
          <>
            <div className={styles.composerHeader}>
              <span>{composerHeaderLabel}</span>
              <span
                role="button"
                tabIndex={0}
                onClick={close}
                className={styles.closeBtn}
                aria-label="cancel"
              >
                ×
              </span>
            </div>
            <textarea
              ref={composerInputRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={composerPlaceholder}
              className={styles.textarea}
              rows={3}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submitComposer();
                }
              }}
            />
            <div className={styles.composerFooter}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={close}
                className={styles.footerBtn}
              >
                Cancel
                <span className={styles.footerKbd}>Esc</span>
              </button>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={submitComposer}
                disabled={submitDisabled}
                className={styles.footerBtn}
              >
                {composerMode === 'branch' ? 'Branch' : 'Save'}
                <span className={styles.footerKbd}>↵</span>
              </button>
            </div>
          </>
        ) : (
          <>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => openComposer('branch')}
              className={styles.barBtn}
              aria-label="Branch"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 3h5v5" />
                <path d="M8 3H3v5" />
                <path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3" />
                <path d="m15 9 6-6" />
              </svg>
              Branch
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => openComposer('comment')}
              className={styles.barBtn}
              aria-label="Comment"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              Comment
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={fireQuote}
              className={styles.barBtn}
              aria-label="Quote"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z" />
                <path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z" />
              </svg>
              Quote
            </button>
          </>
        )}
      </div>
    </>,
    document.body,
  );
}

// ---------- Geometry helpers ----------

function toViewRect(r: DOMRect | ViewRect): ViewRect {
  return {
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
    width: r.width,
    height: r.height,
  };
}

/**
 * Walk up from a Range's start container to nearest `[data-msg-id]` ancestor.
 * PaneMessageList.tsx:61 sets this attribute on every message wrapper, so the
 * walk always terminates at the enclosing message bubble.
 *
 * Returns the message id, or undefined if the range is outside any message
 * wrapper (shouldn't happen for selections inside the transcript, but the
 * caller treats undefined as "no anchor").
 */
export function findMessageIdForRange(range: Range): string | undefined {
  let node: Node | null = range.startContainer;
  while (node && node !== document.body) {
    if (node instanceof HTMLElement) {
      const id = node.dataset.msgId;
      if (id) return id;
    }
    node = node.parentNode;
  }
  return undefined;
}

function measureRange(
  range: Range,
  clipElement?: HTMLElement | null,
): { bounds: ViewRect; highlightRects: ViewRect[] } | null {
  const bounds = toViewRect(range.getBoundingClientRect());
  if (bounds.width === 0 && bounds.height === 0) return null;

  const clipRect = clipElement ? toViewRect(clipElement.getBoundingClientRect()) : null;

  // Walk text nodes inside the range and collect per-text-node client rects.
  // This avoids the full-width block rects that range.getClientRects() returns
  // for block-level elements like <h2>, <li>, <p>.
  const rects: ViewRect[] = [];
  const root =
    range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentElement!
      : range.commonAncestorContainer;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    if (!range.intersectsNode(node)) continue;
    const sub = document.createRange();
    sub.selectNodeContents(node);
    // Clamp to the selection boundaries.
    if (node === range.startContainer) sub.setStart(node, range.startOffset);
    if (node === range.endContainer) sub.setEnd(node, range.endOffset);
    for (const r of Array.from(sub.getClientRects())) {
      const vr = toViewRect(r);
      if (vr.width === 0 && vr.height === 0) continue;
      const clipped = clipRect ? intersectRects(vr, clipRect) : vr;
      if (clipped && clipped.width > 0 && clipped.height > 0) rects.push(clipped);
    }
  }

  return {
    bounds,
    highlightRects: rects.length > 0 ? rects : [bounds],
  };
}

function intersectRects(a: ViewRect, b: ViewRect): ViewRect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;
  return { left, top, right, bottom, width, height };
}

/**
 * Decide where to render the popup.
 *
 *   1. Prefer above the selection.
 *   2. If above doesn't fit on screen, try below.
 *   3. If below would overlap the composer, fall back to above (even cramped).
 *
 * For long selections that extend beyond the viewport, the bounding box is
 * useless as an anchor (top/bottom are off-screen). Use the first / last
 * *visible* line rect — those are clipped to the scroll container by
 * `measureRange` — so the popup hugs whatever the user actually sees.
 */
export function placePopup(
  sel: ViewRect,
  highlightRects: ViewRect[],
  bottomBoundary: number,
  width: number,
  height: number,
): { left: number; top: number; above: boolean } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const firstVisible = highlightRects[0] ?? sel;
  const lastVisible = highlightRects[highlightRects.length - 1] ?? sel;
  const needed = height + POPUP_GAP;
  const topRoom = firstVisible.top - VIEWPORT_MARGIN;
  const bottomRoom = bottomBoundary - lastVisible.bottom - VIEWPORT_MARGIN;

  // Above is the default. Only swap to below when above won't fit AND below
  // both fits and stays clear of the composer.
  const useBelow = topRoom < needed && bottomRoom >= needed;

  let top = useBelow
    ? lastVisible.bottom + POPUP_GAP
    : firstVisible.top - POPUP_GAP - height;

  // Horizontally center on the union bounding box of all highlight rects
  // so the popup sits over the visual center of the entire selection,
  // not just the first or last line.
  const unionLeft = Math.min(...highlightRects.map(r => r.left));
  const unionRight = Math.max(...highlightRects.map(r => r.right));
  const unionCenterX = (unionLeft + unionRight) / 2;

  let left = unionCenterX - width / 2;
  left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - width - VIEWPORT_MARGIN));
  top = Math.max(VIEWPORT_MARGIN, Math.min(top, vh - height - VIEWPORT_MARGIN));

  return { left, top, above: !useBelow };
}

/**
 * Find the top of the nearest composer card so `placePopup` can avoid
 * dropping the popup behind it. Walks up from the scroll container looking
 * for a `.terminal-composer` sibling, which is how TPane and friends mark
 * the floating composer.
 */
function getComposerTopBoundary(container: HTMLElement | null): number {
  const fallback = typeof window !== 'undefined' ? window.innerHeight : 0;
  if (!container) return fallback;
  let node: HTMLElement | null = container.parentElement;
  while (node) {
    const composer = node.querySelector('.terminal-composer');
    if (composer instanceof HTMLElement) {
      return composer.getBoundingClientRect().top;
    }
    node = node.parentElement;
  }
  return fallback;
}

// ---------- Styles ----------

interface Styles {
  highlightLayer: string;
  highlightMark: string;
  barWrap: string;
  barBtn: string;
  composerWrap: string;
  composerHeader: string;
  closeBtn: string;
  textarea: string;
  composerFooter: string;
  footerBtn: string;
  footerKbd: string;
}

function getStyles(): Styles {
  return {
    highlightLayer: 'sel-actions-term-highlight-layer',
    highlightMark: 'sel-actions-term-highlight-mark',
    barWrap: 'sel-actions-term-bar',
    barBtn: 'sel-actions-term-btn',
    composerWrap: 'sel-actions-term-composer',
    composerHeader: 'sel-actions-term-composer-hdr',
    closeBtn: 'sel-actions-term-close',
    textarea: 'sel-actions-term-textarea',
    composerFooter: 'sel-actions-term-footer',
    footerBtn: 'sel-actions-term-footer-btn',
    footerKbd: 'sel-actions-term-footer-kbd',
  };
}

// ---------- Terminal stylesheet (injected once) ----------

const TERMINAL_CSS = `
@keyframes sel-enter {
  from { opacity: 0; transform: scale(0.92); }
  to   { opacity: 1; transform: scale(1); }
}
.sel-actions-enter {
  animation: sel-enter 220ms cubic-bezier(0.2, 0, 0, 1) both;
}
.sel-actions-term-highlight-layer {
  position: fixed;
  inset: 0;
  z-index: 9998;
  pointer-events: none;
}
.sel-actions-term-highlight-mark {
  position: absolute;
  border-radius: 2px;
  background: color-mix(in srgb, var(--term-accent) 30%, transparent);
}
/* Bar + composer share ONE inverted-theme slab: on light themes the popup is
   dark, on dark themes it's light — creating a high-contrast float that pops
   against the page without needing translucency or blur. All colours are driven
   by --sel-bar-* tokens (emitted in tokens.ts based on isLight), so palette
   changes propagate automatically. --sel-bar-shadow provides the appropriate
   outer drop elevation for each polarity. */
.sel-actions-term-bar {
  display: inline-flex;
  align-items: center;
  gap: 0;
  padding: 0;
  background: var(--sel-bar-bg);
  color: var(--sel-bar-mid);
  font-family: var(--ui-font);
  font-size: 11px;
  font-weight: 450;
  letter-spacing: 0.015em;
  border: 1px solid var(--sel-bar-line);
  border-radius: 0;
  box-shadow: var(--sel-bar-shadow);
}
.sel-actions-term-btn {
  position: relative;
  display: inline-flex; align-items: center; gap: 5px;
  padding: 6px 12px; background: transparent; border: 0;
  border-radius: 0;
  color: inherit; font: inherit; cursor: pointer;
  transition: background 60ms ease, color 60ms ease;
}
/* Hairline separator between adjacent buttons, inset from top/bottom. */
.sel-actions-term-btn + .sel-actions-term-btn::before {
  content: '';
  position: absolute;
  left: 0; top: 4px; bottom: 4px;
  width: 1px;
  background: var(--sel-bar-line);
}
.sel-actions-term-btn:hover { background: var(--sel-bar-hover); color: var(--sel-bar-fg); }
.sel-actions-term-btn:active { background: color-mix(in srgb, var(--sel-bar-fg) 12%, transparent); }
.sel-actions-term-btn svg { flex-shrink: 0; }
.sel-actions-term-composer {
  background: var(--sel-bar-bg);
  border: 1px solid var(--sel-bar-line);
  border-radius: 0;
  box-shadow: var(--sel-bar-shadow);
  font-family: var(--ui-font);
  overflow: hidden;
}
.sel-actions-term-composer-hdr {
  display: flex; align-items: center; justify-content: space-between;
  padding: 7px 12px;
  border-bottom: 1px solid var(--sel-bar-line);
  font-size: 9.5px; letter-spacing: .1em; font-weight: 500;
  color: var(--sel-bar-muted); text-transform: uppercase;
}
.sel-actions-term-close {
  cursor: pointer; padding: 0 4px;
  color: var(--sel-bar-muted);
}
.sel-actions-term-close:hover { color: var(--sel-bar-fg); }
.sel-actions-term-textarea {
  display: block; width: calc(100% - 24px);
  margin: 10px 12px;
  padding: 0;
  background: transparent;
  border: 0;
  outline: none; resize: none;
  font-family: var(--ui-font); font-size: 12.5px;
  color: var(--sel-bar-fg);
  line-height: 1.5;
}
.sel-actions-term-textarea::placeholder { color: var(--sel-bar-muted); }
.sel-actions-term-footer {
  display: flex; align-items: center; justify-content: space-between;
  padding: 5px 8px;
  border-top: 1px solid var(--sel-bar-line);
}
.sel-actions-term-footer-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 8px; background: transparent; border: 0;
  border-radius: 0;
  color: var(--sel-bar-mid); cursor: pointer;
  font-family: var(--ui-font); font-size: 10px; font-weight: 450;
  letter-spacing: 0.02em;
  transition: background 60ms ease, color 60ms ease;
}
.sel-actions-term-footer-btn:hover:not(:disabled) {
  background: var(--sel-bar-hover); color: var(--sel-bar-fg);
}
.sel-actions-term-footer-btn:disabled {
  cursor: not-allowed; opacity: 0.4;
}
.sel-actions-term-footer-kbd {
  font-family: var(--ui-font); font-size: 9px;
  padding: 1px 4px;
  border: 1px solid var(--sel-bar-line);
  border-radius: 0;
  color: var(--sel-bar-muted);
  background: transparent;
}
`;

if (typeof document !== 'undefined') {
  let el = document.getElementById('sel-actions-term-css') as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = 'sel-actions-term-css';
    document.head.appendChild(el);
  }
  if (el.textContent !== TERMINAL_CSS) el.textContent = TERMINAL_CSS;
}
