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
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateFromSelection = () => {
      if (composerOpenRef.current) { return; }
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        setAnchor(null);
        return;
      }
      const text = sel.toString().trim();
      if (!text || text.length < 2) {
        setAnchor(null);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) {
        setAnchor(null);
        return;
      }
      const measured = measureRange(range, container);
      // Transient zero-size rects show up mid-drag; don't clobber a good anchor
      // with a collapsed one — the next selectionchange will bring the real box.
      if (!measured) return;
      setAnchor({
        bounds: measured.bounds,
        highlightRects: measured.highlightRects,
        text,
        range: range.cloneRange(),
      });
    };

    document.addEventListener('selectionchange', updateFromSelection);
    return () =>
      document.removeEventListener('selectionchange', updateFromSelection);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef]);

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
        className={`${composerOpen ? styles.composerWrap : styles.barWrap} sel-actions-spring-in`}
        style={{
          position: 'fixed',
          left: placement.left,
          top: placement.top,
          width: composerOpen ? COMPOSER_WIDTH : undefined,
          zIndex: 9999,
          // Opt out of Electron's window drag region: when the popup is
          // clamped near the top, it overlays the topbar (which sets
          // `-webkit-app-region: drag`). Without this, the OS treats hovers
          // and clicks on the pill as a window drag and swallows them.
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
            >
              <span className={styles.barIcon}>↳</span>
              branch
            </button>
            <span className={styles.barSep} />
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => openComposer('comment')}
              className={styles.barBtn}
            >
              <span className={styles.barIcon}>💬</span>
              comment
            </button>
            <span className={styles.barSep} />
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={fireQuote}
              className={styles.barBtn}
            >
              <span className={styles.barIcon}>⊕</span>
              quote reply
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
): { left: number; top: number } {
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

  const anchorRect = useBelow ? lastVisible : firstVisible;
  let top = useBelow
    ? lastVisible.bottom + POPUP_GAP
    : firstVisible.top - POPUP_GAP - height;

  let left = anchorRect.left + anchorRect.width / 2 - width / 2;
  left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - width - VIEWPORT_MARGIN));
  top = Math.max(VIEWPORT_MARGIN, Math.min(top, vh - height - VIEWPORT_MARGIN));

  return { left, top };
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
  barSep: string;
  barIcon: string;
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
    barSep: 'sel-actions-term-sep',
    barIcon: 'sel-actions-term-icon',
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
@keyframes sel-spring-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
.sel-actions-spring-in {
  animation: sel-spring-in 150ms ease-out both;
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
  background: Highlight;
  opacity: 0.4;
}
.sel-actions-term-bar {
  display: inline-flex;
  align-items: stretch;
  background: var(--term-surface);
  color: var(--term-fg);
  font-family: var(--ui-font);
  font-size: 11px;
  border: 1px solid var(--term-line-s);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
}
.sel-actions-term-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 10px; background: transparent; border: 0;
  color: inherit; font: inherit; cursor: pointer;
  transition: background 120ms ease-out;
}
.sel-actions-term-btn:hover { background: var(--term-hover-bg, var(--term-alt)); }
.sel-actions-term-sep { width: 1px; background: var(--term-line); margin: 4px 0; }
.sel-actions-term-icon { font-family: var(--ui-font); }
.sel-actions-term-composer {
  background: var(--term-surface);
  border: 1px solid var(--term-line-s);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
  font-family: var(--ui-font);
}
.sel-actions-term-composer-hdr {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; background: var(--term-alt);
  border-bottom: 1px solid var(--term-line);
  font-size: 9.5px; letter-spacing: .14em;
  color: var(--term-muted); text-transform: uppercase;
}
.sel-actions-term-close {
  cursor: pointer; padding: 0 4px;
  color: var(--term-faint);
}
.sel-actions-term-close:hover { color: var(--term-fg); }
.sel-actions-term-textarea {
  display: block; width: calc(100% - 24px);
  margin: 10px 12px;
  padding: 0;
  background: transparent;
  border: 0;
  outline: none; resize: none;
  font-family: var(--ui-font); font-size: 13px;
  color: var(--term-fg);
  line-height: 1.55;
}
.sel-actions-term-textarea::placeholder { color: var(--term-faint); }
.sel-actions-term-footer {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 8px; border-top: 1px solid var(--term-line);
  color: var(--term-faint);
}
.sel-actions-term-footer-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 8px; background: transparent; border: 0;
  color: inherit; cursor: pointer;
  font-family: var(--ui-font); font-size: 9.5px;
  transition: background 120ms ease-out, color 120ms ease-out;
}
.sel-actions-term-footer-btn:hover:not(:disabled) {
  background: var(--term-hover-bg, var(--term-alt)); color: var(--term-fg);
}
.sel-actions-term-footer-btn:disabled {
  cursor: not-allowed; opacity: 0.5;
}
.sel-actions-term-footer-kbd {
  font-family: var(--ui-font); font-size: 9px;
  padding: 1px 4px;
  border: 1px solid var(--term-line);
  color: var(--term-mid);
  background: var(--term-surface);
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
