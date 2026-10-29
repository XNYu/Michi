import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePhoneLayout } from '../hooks/usePhoneLayout';
import { useKeyboardInset } from '../hooks/useKeyboardInset';

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
  /** Cloned Range for scroll/resize; absent for a restored immutable draft. */
  range?: Range;
  /** Caller-owned snapshot captured when this native selection is established. */
  context?: unknown;
  hasContext: boolean;
  /** Made by touch, so the platform shows its own edit menu beside it. */
  touch?: boolean;
}

/**
 * Pointer type of the most recent pointerdown anywhere on the page. A
 * selection made by touch gets the platform's own edit menu (iOS Copy /
 * Look Up / Translate, Android's floating toolbar), which the bar must avoid.
 */
let lastPointerType = '';
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (event) => {
    lastPointerType = (event as PointerEvent).pointerType ?? '';
  }, { capture: true, passive: true });
}
const touchSelection = () => lastPointerType === 'touch';

export interface SelectionActionsProps {
  containerRef: React.RefObject<HTMLElement | null>;
  /** Opt-in resource identity for serializable file drafts; callers must also key this component. */
  selectionDraftKey?: string;
  /** Quote-reply to the current pane/node. Return false to keep the action open. */
  onQuote: (quoted: string, range?: Range, context?: unknown) => void | boolean;
  /** Branch: create a child thread seeded with the quote + a prompt. False retains the draft. */
  onBranch: (quoted: string, prompt: string, anchorMessageId?: string, range?: Range, context?: unknown) => void | boolean;
  /**
   * Comment: queue a reply-to-selection on the current node. Unlike
   * Quote / Branch this does not send or branch anything - the comment
   * sits in the node's pendingComments until the next outgoing prompt
   * is submitted, at which point TPane flushes them all into a
   * prepended markdown block. Return false to retain the draft after validation fails.
   */
  onComment: (quoted: string, body: string, range?: Range, context?: unknown) => void | boolean;
  /** Capture source identity and destination once; return a new immutable token. */
  captureSelectionContext?: (text: string, range: Range) => unknown;
  /** Render current status / destination controls. Only explicit replacement changes the token. */
  renderSelectionContext?: (context: unknown, replaceContext: (context: unknown) => void) => React.ReactNode;
  /** Label for the captured source, shown with the quote only while composing. */
  getSelectionSourceLabel?: (context: unknown) => string | undefined;
}

type ComposerMode = 'closed' | 'branch' | 'comment';
interface SelectionDraft {
  text: string;
  context?: unknown;
  hasContext: boolean;
  mode: Exclude<ComposerMode, 'closed'>;
  prompt: string;
}

const DRAFT_STORAGE_KEY = 'michi:selection-drafts:v1';
const MAX_DRAFTS = 12;
const MAX_DRAFT_CHARS = 2_000_000;
// Serialized entries keep this fallback bounded even when browser storage is unavailable.
const selectionDrafts = new Map<string, string>();
let draftsHydrated = false;

function readDraft(key: string): SelectionDraft | null {
  try {
    const entries: unknown = draftsHydrated ? [] : JSON.parse(sessionStorage.getItem(DRAFT_STORAGE_KEY) || '[]');
    draftsHydrated = true;
    if (Array.isArray(entries)) {
      for (const entry of entries.slice(-MAX_DRAFTS)) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string'
          && entry[0].length + entry[1].length <= MAX_DRAFT_CHARS) selectionDrafts.set(entry[0], entry[1]);
      }
    }
  } catch { /* Memory fallback covers unavailable / full sessionStorage. */ }
  trimDrafts();
  try {
    const draft = JSON.parse(selectionDrafts.get(key) || 'null') as SelectionDraft | null;
    return draft && typeof draft.text === 'string' && typeof draft.prompt === 'string'
      && (draft.mode === 'comment' || draft.mode === 'branch') && typeof draft.hasContext === 'boolean'
      ? draft : null;
  } catch { return null; }
}

function trimDrafts() {
  let total = [...selectionDrafts].reduce((sum, [key, value]) => sum + key.length + value.length, 0);
  while (selectionDrafts.size > MAX_DRAFTS || total > MAX_DRAFT_CHARS) {
    const oldest = selectionDrafts.entries().next().value;
    if (!oldest) break;
    total -= oldest[0].length + oldest[1].length;
    selectionDrafts.delete(oldest[0]);
  }
}

function writeDraft(key: string, draft: SelectionDraft | null) {
  try {
    if (draft) {
      const serialized = JSON.stringify(draft);
      selectionDrafts.delete(key);
      selectionDrafts.set(key, serialized);
    } else selectionDrafts.delete(key);
    trimDrafts();
    sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify([...selectionDrafts]));
  } catch { /* Opt-in contexts must be serializable; browser storage is best effort. */ }
}

function restoreDraftAnchor(draft: SelectionDraft, container: HTMLElement): Anchor {
  const rect = container.getBoundingClientRect();
  const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.left, window.innerWidth - COMPOSER_WIDTH - VIEWPORT_MARGIN));
  const top = Math.max(VIEWPORT_MARGIN, Math.min(rect.top, window.innerHeight - COMPOSER_MIN_HEIGHT - VIEWPORT_MARGIN));
  return { bounds: { left, top, right: left, bottom: top, width: 0, height: 0 },
    highlightRects: [], text: draft.text, context: draft.context, hasContext: draft.hasContext };
}

const POPUP_GAP = 16;
const BAR_APPROX_WIDTH = 280;
const FILE_BAR_WIDTH = 320;
const COMPOSER_WIDTH = 340;
const COMPOSER_MIN_HEIGHT = 110;
const VIEWPORT_MARGIN = 8;
/** Clearance for the touch selection handles drawn past the first / last line. */
const HANDLE_ROOM = 24;
/**
 * Room the platform edit menu takes beside a touch selection, handle included.
 * Measured on iOS: about 40px tall, its far edge about 53px from the line.
 */
const PLATFORM_MENU_ROOM = 64;
/**
 * Selection-driven placement changes smaller than this (px, per axis) are
 * ignored and the popup keeps its current position. See `stickyPlacement`.
 */
const POSITION_DEADZONE = 8;

/**
 * Text-selection action bar + composer, rendered via portal so it can
 * escape pane clipping and overlap neighboring panes.
 *
 *   1. Select text inside containerRef → `[branch] [comment] [quote reply]`
 *      bar appears beside the selection. For a touch selection it goes on the
 *      side away from the platform's edit menu (`placeTouchPopup`).
 *   2. Branch / Comment → a composer replaces the bar at the same anchor:
 *      a compact quote preview and input. The textarea steals native selection
 *      focus, so we keep painting a lightweight highlight over the saved
 *      source range.
 *   3. Submit (⌘↵) → onBranch / onComment with (quoted, body). Esc /
 *      click away / selection cleared → close. Quote reply is one-shot:
 *      clicking it fires `onQuote(quoted)` without ever opening a
 *      composer.
 */
export default function SelectionActions({
  containerRef,
  selectionDraftKey,
  onQuote,
  onBranch,
  onComment,
  captureSelectionContext,
  renderSelectionContext,
  getSelectionSourceLabel,
}: SelectionActionsProps) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [composerMode, setComposerMode] = useState<ComposerMode>('closed');
  const [prompt, setPrompt] = useState('');
  const [hiddenDraft, setHiddenDraft] = useState<SelectionDraft | null>(null);
  const hiddenDraftRef = useRef(false);
  hiddenDraftRef.current = hiddenDraft !== null;
  const [measuredSize, setMeasuredSize] = useState<{ width: number; height: number } | null>(null);
  const captureContextRef = useRef(captureSelectionContext);
  captureContextRef.current = captureSelectionContext;
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
  // Last placement actually rendered, tagged with the mode it was computed
  // for. Lets `stickyPlacement` suppress sub-perceptual selection-driven
  // repositioning, while a bar↔composer swap (different size, different
  // pinned edge) always starts from a freshly computed position.
  const stickyPlacementRef = useRef<
    { mode: ComposerMode; left: number; top: number; above: boolean } | null
  >(null);

  useEffect(() => {
    if (!selectionDraftKey || !containerRef.current) return;
    const draft = readDraft(selectionDraftKey);
    if (!draft) return;
    setAnchor(restoreDraftAnchor(draft, containerRef.current));
    setComposerMode(draft.mode);
    setPrompt(draft.prompt);
  }, [selectionDraftKey, containerRef]);

  useEffect(() => {
    if (!selectionDraftKey || !anchor || composerMode === 'closed') return;
    writeDraft(selectionDraftKey, { text: anchor.text, context: anchor.context,
      hasContext: anchor.hasContext, mode: composerMode, prompt });
    // Geometry changes during scrolling do not change the saved draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionDraftKey, anchor?.text, anchor?.context, anchor?.hasContext, composerMode, prompt]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const STABLE_THRESHOLD = 80; // ms — content must be unchanged this long

    const updateFromSelection = () => {
      if (composerOpenRef.current || hiddenDraftRef.current) { return; }
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
          touch: touchSelection(),
          // Native selectionchange also fires without a selection edit (for
          // example after focus changes). Do not recapture a different target.
          ...(sameSelection(anchor, text, range)
            ? { context: anchor.context, hasContext: anchor.hasContext }
            : { context: captureContextRef.current?.(text, range), hasContext: !!captureContextRef.current }),
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
              touch: touchSelection(),
              context: captureContextRef.current?.(freshText, freshRange),
              hasContext: !!captureContextRef.current,
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
        if (!anchor.range) {
          const container = containerRef.current;
          if (container) {
            stickyPlacementRef.current = null;
            setAnchor((previous) => previous ? { ...previous, bounds: restoreDraftAnchor({
              text: previous.text, hasContext: previous.hasContext, mode: 'comment', prompt: '',
            }, container).bounds } : previous);
          }
          return;
        }
        if (!containerRef.current?.contains(anchor.range.commonAncestorContainer)
          || anchor.range.toString().trim() !== anchor.text) return;
        const measured = measureRange(anchor.range, containerRef.current);
        if (!measured) return;
        // Scroll / resize must track the text 1:1. The dead-zone exists for
        // selection edits only — applying it here would make the popup lag
        // behind a slow scroll and then jump once the delta crossed the
        // threshold, so drop the sticky position and let this frame win.
        stickyPlacementRef.current = null;
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
  }, [anchor?.range, !!anchor]);

  const close = useCallback(() => {
    if (selectionDraftKey) writeDraft(selectionDraftKey, null);
    hiddenDraftRef.current = false;
    setHiddenDraft(null);
    setAnchor(null);
    setComposerMode('closed');
    setPrompt('');
    window.getSelection()?.removeAllRanges();
  }, [selectionDraftKey]);

  // Close on outside mousedown (anywhere except the popup itself).
  useEffect(() => {
    if (!anchor) return;
    const onMouseDown = (e: MouseEvent) => {
      const popup = popupRef.current;
      if (popup && popup.contains(e.target as Node)) return;
      if (selectionDraftKey && composerMode !== 'closed') {
        const draft: SelectionDraft = { text: anchor.text, context: anchor.context,
          hasContext: anchor.hasContext, mode: composerMode, prompt };
        writeDraft(selectionDraftKey, draft);
        hiddenDraftRef.current = true;
        setHiddenDraft(draft);
        setAnchor(null);
        setComposerMode('closed');
        setPrompt('');
        window.getSelection()?.removeAllRanges();
      } else close();
    };
    // Use mousedown (not click) so the selection change that follows a
    // click outside doesn't race with the next selectionchange handler.
    window.addEventListener('mousedown', onMouseDown);
    return () => window.removeEventListener('mousedown', onMouseDown);
  }, [anchor, close, selectionDraftKey, composerMode, prompt]);

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
    let result: void | boolean;
    if (composerMode === 'branch') {
      const args: Parameters<typeof onBranch> = [anchor.text, p, anchor.range ? findMessageIdForRange(anchor.range) : undefined, anchor.range];
      if (anchor.hasContext) args.push(anchor.context);
      result = onBranch(...args);
    } else if (composerMode === 'comment') {
      const args: Parameters<typeof onComment> = [anchor.text, p, anchor.range];
      if (anchor.hasContext) args.push(anchor.context);
      result = onComment(...args);
    } else {
      return;
    }
    if (result !== false) close();
  }, [anchor, prompt, composerMode, onBranch, onComment, close]);

  const fireQuote = useCallback(() => {
    if (!anchor) return;
    const args: Parameters<typeof onQuote> = [anchor.text, anchor.range];
    if (anchor.hasContext) args.push(anchor.context);
    if (onQuote(...args) !== false) close();
  }, [anchor, onQuote, close]);

  const replaceContext = useCallback((context: unknown) => {
    setAnchor((previous) => previous ? { ...previous, context, hasContext: true } : previous);
  }, []);

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
  }, [composerMode, anchor?.text, anchor?.context, renderSelectionContext]);

  // Drop the sticky placement once the popup is dismissed so the next
  // appearance is positioned from scratch instead of inheriting a stale spot.
  // Deliberately keyed on visibility rather than `anchor` itself — `anchor`
  // gets a new identity on every selection edit, which would defeat the
  // dead-zone entirely. The `if` matters: without it this would also fire on
  // the render that first shows the popup, clearing the placement it just
  // committed and letting the next selection edit move freely.
  const popupVisible = anchor !== null;
  useLayoutEffect(() => {
    if (!popupVisible) stickyPlacementRef.current = null;
  }, [popupVisible]);
  // A phone writes the prompt in a sheet along the bottom edge, which the
  // keyboard pushes up, instead of a floating box beside the selection.
  const phone = usePhoneLayout();
  const keyboardInset = useKeyboardInset(phone && popupVisible && composerMode !== 'closed');

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
    // Use offsetWidth/offsetHeight instead of getBoundingClientRect() because
    // the latter reports the *transformed* size. When the entry animation
    // applies scale(0.92), getBoundingClientRect() returns ~92% of the true
    // layout dimensions; this stale measurement then corrects on the next
    // trigger (first keystroke), causing a visible position jump.
    const measure = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (w === 0 || h === 0) return;
      setMeasuredSize((prev) => {
        if (prev && Math.abs(prev.width - w) < 0.5 && Math.abs(prev.height - h) < 0.5) return prev;
        // Content growth must not retain a position measured for the smaller popup.
        stickyPlacementRef.current = null;
        return { width: w, height: h };
      });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [anchor?.text, anchor?.context, composerMode, prompt, renderSelectionContext]);

  if (!anchor) return hiddenDraft ? (
    <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted">
      <button type="button" className="text-fg underline" onClick={() => {
        if (!containerRef.current) return;
        setAnchor(restoreDraftAnchor(hiddenDraft, containerRef.current));
        setComposerMode(hiddenDraft.mode);
        setPrompt(hiddenDraft.prompt);
        hiddenDraftRef.current = false;
        setHiddenDraft(null);
      }}>Resume selection {hiddenDraft.mode}</button>
      <button type="button" onClick={close}>Discard draft</button>
    </div>
  ) : null;

  const styles = getStyles();
  const composerOpen = composerMode !== 'closed';
  const submitDisabled = !prompt.trim();
  const fallbackWidth = composerOpen ? COMPOSER_WIDTH : renderSelectionContext ? FILE_BAR_WIDTH : BAR_APPROX_WIDTH;
  const fallbackHeight = composerOpen ? COMPOSER_MIN_HEIGHT : renderSelectionContext ? 68 : 36;
  const popupWidth = measuredSize?.width ?? fallbackWidth;
  const popupHeight = measuredSize?.height ?? fallbackHeight;
  const bottomBoundary = getComposerTopBoundary(containerRef.current);
  // The bar for a touch selection goes on the side of the selection away from
  // the platform's edit menu. The composer replaces that menu (the textarea
  // takes the focus), so it keeps its usual placement.
  const rawPlacement = anchor.touch && !composerOpen
    ? placeTouchPopup(
      containerRef.current ? toViewRect(containerRef.current.getBoundingClientRect()) : viewportRect(),
      anchor.highlightRects,
      bottomBoundary,
      popupWidth,
      popupHeight,
      window.visualViewport?.offsetTop ?? 0,
    )
    : placePopup(
      anchor.bounds,
      anchor.highlightRects,
      bottomBoundary,
      popupWidth,
      popupHeight,
    );
  // Suppress sub-perceptual twitching while the user is still adjusting the
  // selection. Writing the ref during render is safe because the write is
  // idempotent: a repeat render with the same inputs compares the fresh
  // placement against the value we just committed and reaches the same
  // decision, so a StrictMode double-invoke can't change the outcome.
  const sticky = stickyPlacementRef.current;
  const placement = stickyPlacement(rawPlacement, sticky?.mode === composerMode ? sticky : null);
  stickyPlacementRef.current = { mode: composerMode, ...placement };

  const composerHeaderLabel = composerMode === 'branch' ? 'Branch from selection' : 'Comment';
  const sourceLabel = getSelectionSourceLabel?.(anchor.context);
  const composerPlaceholder =
    composerMode === 'branch'
      ? 'ask something about this selection…'
      : 'your reply to this passage…';

  const originY = placement.above ? 'top' : 'bottom';
  const sheet = phone && composerOpen;

  return createPortal(
    <>
      {composerOpen && anchor.range && anchor.highlightRects.length > 0
        && containerRef.current?.contains(anchor.range.commonAncestorContainer)
        && anchor.range.toString().trim() === anchor.text && (
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
        // Closes on any Esc while up, over every surface ("over"): the ⌘J
        // panel's Esc always yields to it.
        data-escape-layer="over"
        key={composerOpen ? `composer-${composerMode}` : 'bar'}
        className={`${composerOpen ? styles.composerWrap : styles.barWrap}${sheet ? ' is-sheet' : ''}${renderSelectionContext ? ' sel-actions-with-context' : ''} sel-actions-enter`}
        style={{
          position: 'fixed',
          left: sheet ? 0 : placement.left,
          right: sheet ? 0 : undefined,
          top: sheet ? undefined : placement.top,
          bottom: sheet ? keyboardInset : undefined,
          '--keyboard-inset': `${keyboardInset}px`,
          width: sheet ? undefined : composerOpen ? COMPOSER_WIDTH : renderSelectionContext ? FILE_BAR_WIDTH : undefined,
          zIndex: 'var(--z-selection)',
          transformOrigin: `left ${originY}`,
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {composerOpen ? (
          <>
            <div className={styles.composerHeader}>
              <span>{composerHeaderLabel}</span>
              <button
                type="button"
                onClick={close}
                className={styles.closeBtn}
                aria-label="Close selection composer"
              >
                ×
              </button>
            </div>
            <blockquote className="sel-actions-term-preview" aria-label="Selected passage">
              <div className="sel-actions-term-preview-text">{anchor.text}</div>
              {sourceLabel && <cite title={sourceLabel}>{sourceLabel}</cite>}
            </blockquote>
            <textarea
              ref={composerInputRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={composerPlaceholder}
              className={styles.textarea}
              rows={3}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submitComposer();
                }
              }}
            />
            <div className={styles.composerFooter}>
              {renderSelectionContext ? (
                <div className="sel-actions-context">{renderSelectionContext(anchor.context, replaceContext)}</div>
              ) : <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={close}
                className={styles.footerBtn}
              >
                Cancel
                <span className={styles.footerKbd}>Esc</span>
              </button>}
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={submitComposer}
                disabled={submitDisabled}
                className={`${styles.footerBtn} sel-actions-term-submit`}
              >
                {composerMode === 'branch' ? 'Branch' : 'Save comment'}
                <span className={styles.footerKbd}>↵</span>
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="sel-actions-term-toolbar" role="group" aria-label="Selection actions">
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
            </div>
            {renderSelectionContext && (
              <div className="sel-actions-term-routing">{renderSelectionContext(anchor.context, replaceContext)}</div>
            )}
          </>
        )}
      </div>
    </>,
    document.body,
  );
}

function sameSelection(anchor: Anchor, text: string, range: Range): boolean {
  return anchor.text === text && !!anchor.range
    && anchor.range.startContainer === range.startContainer
    && anchor.range.startOffset === range.startOffset
    && anchor.range.endContainer === range.endContainer
    && anchor.range.endOffset === range.endOffset;
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

function viewportRect(): ViewRect {
  const width = window.innerWidth;
  const height = window.innerHeight;
  return { left: 0, top: 0, right: width, bottom: height, width, height };
}

/**
 * Placement of the bar for a selection made by touch.
 *
 * The platform draws its own edit menu next to such a selection, and a page
 * can neither move nor suppress it. Its position is predictable:
 *
 *   - iOS (UIMenuController / UIEditMenuInteraction) centres it above the
 *     target rect, or below when there is not enough space above. WebKit's
 *     target is the selection clipped to the viewport and to every scrolling
 *     ancestor, which is what `measureRange` reports in `highlightRects`.
 *   - WebKit only evades page UI above the selection for a focused
 *     contentEditable / textarea, so a transcript selection always gets the
 *     default.
 *   - Android's floating toolbar uses the same above-then-below order.
 *
 * On a phone that menu spans nearly the full width (about 40px tall, its
 * bottom about 15px above the first line), so the bar goes on the other side
 * of the selection rather than beside the menu:
 *
 *   1. Below the selection: clear of the end handle when the menu is above,
 *      or of the menu as well when it is below.
 *   2. Otherwise above the selection, beyond the room the menu takes there.
 *   3. Otherwise, a selection filling the pane: dock just above the composer.
 *
 * Predicting "below" is the safe error. A bar placed under the selection and
 * the menu's lower slot is clear of the menu on either side, so the threshold
 * for "the menu is above" leans high.
 */
export function placeTouchPopup(
  pane: ViewRect,
  highlightRects: ViewRect[],
  bottomBoundary: number,
  width: number,
  height: number,
  viewportTop = 0,
): { left: number; top: number; above: boolean } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rects = highlightRects.length > 0 ? highlightRects : [pane];
  const firstTop = Math.min(...rects.map(r => r.top));
  const lastBottom = Math.max(...rects.map(r => r.bottom));
  const floor = Math.min(bottomBoundary, pane.bottom, vh) - VIEWPORT_MARGIN;
  const ceiling = Math.max(pane.top, 0) + VIEWPORT_MARGIN;
  const menuAbove = firstTop - viewportTop >= PLATFORM_MENU_ROOM;

  const below = lastBottom + (menuAbove ? HANDLE_ROOM : PLATFORM_MENU_ROOM);
  const above = firstTop - PLATFORM_MENU_ROOM - height;
  let top: number;
  let isAbove = false;
  if (below + height <= floor) top = below;
  else if (above >= ceiling) { top = above; isAbove = true; }
  else top = floor - height;

  const unionCenterX = (Math.min(...rects.map(r => r.left)) + Math.max(...rects.map(r => r.right))) / 2;
  const minLeft = Math.max(pane.left, 0) + VIEWPORT_MARGIN;
  const maxLeft = Math.min(pane.right, vw) - width - VIEWPORT_MARGIN;
  const left = Math.max(minLeft, Math.min(unionCenterX - width / 2, maxLeft));
  top = Math.max(VIEWPORT_MARGIN, Math.min(top, vh - height - VIEWPORT_MARGIN));
  return { left, top, above: isAbove };
}

/**
 * Dead-zone filter for popup placement.
 *
 * `placePopup` is recomputed from live selection geometry, and that geometry
 * wobbles for reasons the user never intended as movement:
 *
 *   - `getBoundingClientRect` returns fractional values, so the same visual
 *     line can measure 123.48 one frame and 123.51 the next;
 *   - the first highlight rect can change identity mid-selection (an inline
 *     `<code>` / `<strong>` run has a slightly different top than the plain
 *     text around it), shifting `top` by a pixel or two;
 *   - extending a selection by one short word moves `unionCenterX` — and
 *     therefore `left` — by only a few pixels.
 *
 * Individually those are sub-perceptual, but each one triggers a re-render
 * that re-pins `left`/`top`, which reads as the popup twitching around while
 * the user is still adjusting their selection. Holding the last rendered
 * position until the popup would move meaningfully removes the twitch.
 *
 * Both axes are gated together: the point is "the popup barely moved, so
 * leave it alone", not "freeze one axis while the other slides". Comparing
 * against the *rendered* position (not the previous computed one) means many
 * small steps still accumulate and eventually cross the threshold, so the
 * popup can't drift away from its selection.
 */
export function stickyPlacement(
  next: { left: number; top: number; above: boolean },
  prev: { left: number; top: number; above: boolean } | null,
): { left: number; top: number; above: boolean } {
  if (!prev) return next;
  // Flipping sides changes edge-pinning and transform-origin — never a jitter.
  if (prev.above !== next.above) return next;
  const settled =
    Math.abs(next.left - prev.left) < POSITION_DEADZONE &&
    Math.abs(next.top - prev.top) < POSITION_DEADZONE;
  return settled ? prev : next;
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
  animation: sel-enter var(--t-enter) cubic-bezier(0.2, 0, 0, 1) both;
}
.sel-actions-term-highlight-layer {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-selection) - 1);
  pointer-events: none;
}
.sel-actions-term-highlight-mark {
  position: absolute;
  border-radius: var(--ui-radius-sm);
  background: color-mix(in srgb, var(--term-accent) 30%, transparent);
}
/* Every selection surface uses the same raised palette, including chat,
   files and the expanded composer. No per-caller color overrides. */
.sel-actions-term-bar, .sel-actions-term-composer {
  background: var(--sel-bar-bg);
  color: var(--sel-bar-fg);
  border: 1px solid var(--sel-bar-line);
  border-radius: var(--ui-radius);
  box-shadow: var(--sel-bar-shadow);
  font-family: var(--ui-font);
  font-size: var(--fs-md);
  font-weight: 450;
  max-width: calc(100vw - 16px);
  max-height: calc(100dvh - 16px);
  overflow: auto;
  color-scheme: var(--sel-bar-color-scheme);
}
.sel-actions-term-bar { display: flex; flex-direction: column; }
.sel-actions-term-toolbar { display: flex; align-items: center; padding: 3px; }
.sel-actions-term-btn {
  position: relative;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  flex: 1; min-width: 0;
  padding: 5px 10px; background: transparent; border: 0;
  border-radius: var(--ui-radius-sm);
  color: inherit; font: inherit; cursor: pointer; white-space: nowrap;
  transition: background var(--t-quick) ease, color var(--t-quick) ease;
}
.sel-actions-term-btn + .sel-actions-term-btn::before {
  content: ''; position: absolute;
  left: 0; top: 5px; bottom: 5px; width: 1px;
  background: var(--sel-bar-line);
}
.sel-actions-term-btn:hover { background: var(--sel-bar-hover); }
.sel-actions-term-btn:active { background: color-mix(in srgb, var(--sel-bar-fg) 12%, transparent); }
.sel-actions-term-btn svg { width: 12px; height: 12px; flex-shrink: 0; color: var(--sel-bar-mid); }
.sel-actions-term-routing { border-top: 1px solid var(--sel-bar-line); padding: 3px 9px; }
.file-selection-context { display: grid; gap: 4px; min-width: 0; font-size: var(--fs-sm); line-height: 1.5; }
.file-selection-target { display: flex; gap: 4px; align-items: center; min-width: 0; }
.file-selection-target > span:first-child { flex-shrink: 0; color: var(--sel-bar-muted); }
.file-selection-picker { position: relative; display: flex; min-width: 0; max-width: 100%; }
.file-selection-picker select {
  appearance: none; min-width: 0; max-width: 100%;
  padding: 4px 20px 4px 6px;
  background: transparent; color: var(--sel-bar-fg);
  border: 0; border-radius: var(--ui-radius-sm);
  font: inherit; text-overflow: ellipsis; cursor: pointer;
}
.file-selection-picker select:hover { background: var(--sel-bar-hover); }
.file-selection-picker option { background: var(--sel-bar-bg); color: var(--sel-bar-fg); }
.file-selection-picker svg {
  position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
  width: 12px; height: 12px; pointer-events: none; color: var(--sel-bar-mid);
}
.file-selection-context [role="status"] { color: var(--sel-bar-mid); overflow-wrap: anywhere; }
.sel-actions-context { flex: 1; min-width: 0; }
.sel-actions-term-composer-hdr {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px 8px;
  font-size: var(--fs-md); font-weight: 500; color: var(--sel-bar-fg);
}
.sel-actions-term-close {
  display: grid; place-items: center; width: 24px; height: 24px;
  cursor: pointer; padding: 0; border: 0; border-radius: var(--ui-radius-sm);
  background: transparent; color: var(--sel-bar-muted); font-size: var(--fs-2xl);
}
.sel-actions-term-close:hover { background: var(--sel-bar-hover); color: var(--sel-bar-fg); }
.sel-actions-term-preview {
  margin: 0 12px 10px; padding: 7px 9px;
  border-left: 2px solid var(--sel-bar-muted);
  background: var(--sel-bar-quote-bg);
  color: var(--sel-bar-mid); font-size: var(--fs-sm); line-height: 1.65;
}
.sel-actions-term-preview-text { max-height: 80px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.sel-actions-term-preview cite {
  display: block; margin-top: 4px; font-style: normal; font-size: var(--fs-xs);
  color: var(--sel-bar-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sel-actions-term-textarea {
  display: block; width: calc(100% - 24px);
  min-height: 76px; margin: 10px 12px; padding: 0;
  background: transparent; border: 0; outline: none; resize: none;
  font-family: var(--ui-font); font-size: var(--fs-lg);
  color: var(--sel-bar-fg); line-height: 1.5;
}
.sel-actions-term-textarea::placeholder { color: var(--sel-bar-muted); }
.sel-actions-term-footer {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 6px 10px; border-top: 1px solid var(--sel-bar-line);
}
.sel-actions-term-footer-btn {
  display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0;
  padding: 4px 7px; background: transparent; border: 0;
  border-radius: var(--ui-radius-sm); white-space: nowrap;
  color: var(--sel-bar-mid); cursor: pointer;
  font-family: var(--ui-font); font-size: var(--fs-sm); font-weight: 450;
  transition: background var(--t-quick) ease, color var(--t-quick) ease;
}
.sel-actions-term-footer-btn:hover:not(:disabled) { background: var(--sel-bar-hover); color: var(--sel-bar-fg); }
.sel-actions-term-submit { background: var(--sel-bar-action-bg); color: var(--sel-bar-action-fg); font-weight: 550; }
.sel-actions-term-submit:hover:not(:disabled) { background: var(--sel-bar-action-bg); color: var(--sel-bar-action-fg); filter: brightness(1.08); }
.sel-actions-term-footer-btn:disabled { cursor: not-allowed; opacity: 0.4; }
.sel-actions-term-footer-kbd { font-family: var(--ui-font); font-size: var(--fs-2xs); color: inherit; opacity: .7; }
.sel-actions-term-bar button:focus-visible, .sel-actions-term-composer button:focus-visible, .file-selection-picker select:focus-visible {
  outline: 2px solid var(--sel-bar-fg); outline-offset: -2px;
}
/* Phone composer remains a keyboard-aware sheet; keep its footer reachable. */
.sel-actions-term-composer.is-sheet {
  max-width: 100%; max-height: calc(100dvh - var(--keyboard-inset, 0px) - 16px);
  border-left: 0; border-right: 0; border-bottom: 0;
  border-radius: var(--ui-radius) var(--ui-radius) 0 0;
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
.sel-actions-term-composer.is-sheet .sel-actions-term-textarea { margin: 12px 16px; width: calc(100% - 32px); }
.sel-actions-term-composer.is-sheet .sel-actions-term-footer-btn { min-height: 40px; padding: 0 12px; font-size: var(--fs-sm); }
.sel-actions-term-composer.is-sheet .sel-actions-term-footer-kbd { display: none; }
@media (hover: none) and (pointer: coarse) {
  .sel-actions-term-btn { min-height: 40px; padding: 0 12px; }
  .file-selection-picker select { min-height: 40px; }
  .sel-actions-term-close { width: 40px; height: 40px; }
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
