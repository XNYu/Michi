import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Sparkle } from 'lucide-react';
import { AnimatePresence, animate, motion, useIsPresent, useReducedMotionConfig } from 'motion/react';
import { SPRING, TRANSITION } from '../../../../motion/tokens';
import {
  clampDockRatio,
  clampRect,
  dockRatioFromPointer,
  effectiveRect,
  firstOpenPlacement,
  isDockHint,
  moveRect,
  resizeRect,
  type Bounds,
  type ColumnSpan,
  type MetaChatForm,
  type Rect,
  type ResizeDir,
} from '../../../../state/metaChat/metaChatWindowModel';
import type { MetaChatWindowController } from '../../../../state/metaChat/useMetaChatWindow';
import { usePhoneLayout } from '../../../../hooks/usePhoneLayout';
import { firstRunActive, useSpacesFirstRun } from '../../../../state/metaAgent/spacesFirstRun';
import { MetaChatPanel, MINIMIZE_KEYS, type MetaChatContentProps } from './MetaChatPanel';
import './metaChat.css';

export interface MetaChatAreaProps extends MetaChatContentProps {
  controller: MetaChatWindowController;
  /** False outside Spaces: the page fills the area and the window keeps its state for the return. */
  visible?: boolean;
  /** Listen for ⌘J / Ctrl+J. Turn off when the host routes the shortcut to toggleMinimized itself. */
  shortcut?: boolean;
  /** Text beside the minimized pill's sparkle ("Create with agent"); the pill is the bare icon without it. */
  pillLabel?: string;
  /** The pill's dot also shows while the Meta agent's first run reads (Spaces). Off where that run is not this window's. */
  firstRunDot?: boolean;
  /** The page. It is never remounted by form changes. */
  children: ReactNode;
}

type Op =
  | { kind: 'move'; sx: number; sy: number; start: Rect; left: number }
  | { kind: 'resize'; dir: ResizeDir; sx: number; sy: number; start: Rect }
  | { kind: 'split'; left: number };

interface Live {
  kind: Op['kind'];
  rect?: Rect;
  ratio?: number;
  hint?: boolean;
}

const DIVIDER_STEP = 5;

/** The text column of a Spaces page: Home and workspace homes, then document pages. */
const PAGE_COLUMN_SELECTOR = '.area-settings__doc, .branches-document';

/** The page's main column inside `area`, as its content box in area coordinates; null before the page renders one. */
function pageColumn(area: HTMLElement | null): ColumnSpan | null {
  const column = area?.querySelector('.meta-chat-area__page')?.querySelector<HTMLElement>(PAGE_COLUMN_SELECTOR);
  if (!area || !column) return null;
  const box = column.getBoundingClientRect();
  if (box.width <= 0) return null;
  const style = window.getComputedStyle(column);
  const left = area.getBoundingClientRect().left;
  return {
    left: box.left - left + (parseFloat(style.paddingLeft) || 0),
    right: box.right - left - (parseFloat(style.paddingRight) || 0),
  };
}

const MetaChatDockedContext = createContext(false);

/** True while the window is docked beside the page: the page has part of the area and lays its blocks out narrow. */
export function useMetaChatDocked(): boolean {
  return useContext(MetaChatDockedContext);
}

const MetaChatRevealPageContext = createContext<(() => void) | null>(null);

/** Inside the window: gets it out of the way of a page something in it opens (View, a page link). Null elsewhere. */
export function useMetaChatRevealPage(): (() => void) | null {
  return useContext(MetaChatRevealPageContext);
}

/** The minimized pill's dot: the window's answer is streaming, or the Meta agent's first run is reading in the background. */
function PillWorkingDot({ busy, firstRun: withFirstRun = true }: { busy: boolean; firstRun?: boolean }) {
  const firstRun = useSpacesFirstRun('local');
  if (!busy && !(withFirstRun && firstRunActive(firstRun.data))) return null;
  return <span className="meta-chat-pill__dot" role="status" aria-label="Assistant is working" />;
}

/*
 * Window ⇄ pill. ⌘J toggles it, so the move is short and does not bounce:
 * the window shrinks into the pill (one uniform scale and a move, so the
 * conversation inside never stretches) and fades as the pill fades in in its
 * place; restoring grows it back out of the pill. A second ⌘J mid-way turns
 * it around where it is.
 */
const MORPH_SPRING = { ...SPRING.soft, bounce: 0 } as const;
const MORPH_FADE_OUT = { duration: 0.12, delay: 0.12, ease: 'linear' } as const;
const MORPH_FADE_IN = { duration: 0.1, ease: 'linear' } as const;
const PILL_FADE_IN = { duration: 0.14, delay: 0.12, ease: 'linear' } as const;
const PILL_SHOWN = { opacity: 1 } as const;
const PILL_GONE = { opacity: 0, transition: TRANSITION.exit } as const;
const LEAVING_STYLE = { pointerEvents: 'none' } as const;

interface Box { x: number; y: number; w: number; h: number }

/** The window as it was last on screen: held while it shrinks into the pill. */
interface ShownWindow { box: Box; form: MetaChatForm | 'full' }

type MorphRun = ReturnType<typeof animate>;
interface Morph { kind: 'min' | 'restore'; seq: number; runs: MorphRun[] }

/** Layout box in the area (the offset parent of the window and the pill), without transforms. */
function layoutBox(el: HTMLElement): Box {
  return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
}

function measurable(box: Box | null | undefined): box is Box {
  return !!box && box.w >= 1 && box.h >= 1;
}

/** Moves and uniformly scales `from` onto the centre of `to`. */
function morphTowards(from: Box, to: Box) {
  return {
    x: to.x + to.w / 2 - (from.x + from.w / 2),
    y: to.y + to.h / 2 - (from.y + from.h / 2),
    scale: Math.min(to.w / from.w, to.h / from.h),
  };
}

/**
 * Puts the window back to rest. The DOM at once (this frame paints it), and
 * motion's own values too: they stay bound to the element, and a later morph
 * starting from stale end values would open at the pill, transparent.
 */
function resetMorph(el: HTMLElement | null) {
  if (!el) return;
  el.style.transform = '';
  el.style.opacity = '';
  animate(el, { x: 0, y: 0, scale: 1, opacity: 1 }, { duration: 0 });
}

/** The minimized button. Leaving (the window grows back out of it), it fades and is no longer a control. */
function MetaChatPill({ label, busy, firstRunDot, onRestore }: { label?: string; busy: boolean; firstRunDot: boolean; onRestore: () => void }) {
  const present = useIsPresent();
  return (
    <motion.button
      type="button"
      className="meta-chat-pill"
      data-labelled={label ? '' : undefined}
      aria-label={label ?? 'Ask assistant'}
      title={label ?? `Ask assistant (${MINIMIZE_KEYS})`}
      aria-hidden={present ? undefined : true}
      tabIndex={present ? undefined : -1}
      inert={!present}
      style={present ? undefined : LEAVING_STYLE}
      initial={false}
      animate={PILL_SHOWN}
      exit={PILL_GONE}
      onClick={onRestore}
    >
      <Sparkle className="meta-chat-pill__icon" size={20} aria-hidden />
      {label ? <span className="meta-chat-pill__label">{label}</span> : null}
      <PillWorkingDot busy={busy} firstRun={firstRunDot} />
    </motion.button>
  );
}

/**
 * The Spaces main area with the Meta agent window: floating over the page,
 * docked beside it, or minimized to a pill. Drags stay local until release,
 * then commit once through the controller.
 */
export function MetaChatArea({
  controller,
  visible = true,
  shortcut = true,
  pillLabel,
  firstRunDot = true,
  children,
  ...content
}: MetaChatAreaProps) {
  const areaRef = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState<Bounds>({ width: 0, height: 0 });
  const boundsRef = useRef(bounds);
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const opRef = useRef<Op | null>(null);
  const liveRef = useRef<Live | null>(null);
  const [live, setLiveState] = useState<Live | null>(null);
  const detachRef = useRef<(() => void) | null>(null);
  const phone = usePhoneLayout();
  // On a phone the window opens full screen each time; this session-only flag is the user shrinking it to the floating box.
  const [phoneWindowed, setPhoneWindowed] = useState(false);
  if (phoneWindowed && controller.state.minimized) setPhoneWindowed(false);

  const measure = useCallback(() => {
    const el = areaRef.current;
    if (!el) return boundsRef.current;
    const r = el.getBoundingClientRect();
    const next = { width: Math.round(r.width), height: Math.round(r.height) };
    if (next.width !== boundsRef.current.width || next.height !== boundsRef.current.height) {
      boundsRef.current = next;
      setBounds(next);
    }
    return next;
  }, []);

  useLayoutEffect(() => {
    measure();
    const el = areaRef.current;
    const observer = typeof ResizeObserver === 'undefined' || !el ? null : new ResizeObserver(() => measure());
    if (observer && el) observer.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [measure]);

  useEffect(() => () => detachRef.current?.(), []);

  // The first open, before the user placed the window, keeps the page's main column readable.
  const { firstOpen, placeFirstOpen } = controller;
  useLayoutEffect(() => {
    if (!visible || !firstOpen || !bounds.width || !bounds.height) return;
    placeFirstOpen(firstOpenPlacement(bounds, pageColumn(areaRef.current)));
  }, [visible, firstOpen, bounds, placeFirstOpen]);

  useEffect(() => {
    if (!visible || !shortcut) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (event.key !== 'j' && event.key !== 'J') return;
      event.preventDefault();
      controllerRef.current.toggleMinimized();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, shortcut]);

  const setLive = (next: Live | null) => {
    liveRef.current = next;
    setLiveState(next);
  };

  const finish = (commit: boolean) => {
    const op = opRef.current;
    const last = liveRef.current;
    detachRef.current?.();
    detachRef.current = null;
    opRef.current = null;
    setLive(null);
    if (!commit || !op || !last) return;
    const c = controllerRef.current;
    if (op.kind === 'move') {
      if (last.hint) c.dock();
      else if (last.rect) c.setRect(clampRect(last.rect, boundsRef.current));
    } else if (op.kind === 'resize') {
      if (last.rect) c.setRect(clampRect(last.rect, boundsRef.current));
    } else if (last.ratio !== undefined) {
      c.setDockRatio(last.ratio);
    }
  };

  const onMove = (event: PointerEvent) => {
    const op = opRef.current;
    if (!op) return;
    const b = boundsRef.current;
    if (op.kind === 'move') {
      setLive({
        kind: 'move',
        rect: moveRect(op.start, event.clientX - op.sx, event.clientY - op.sy, b),
        hint: !phone && isDockHint(event.clientX - op.left, b),
      });
    } else if (op.kind === 'resize') {
      setLive({ kind: 'resize', rect: resizeRect(op.start, op.dir, event.clientX - op.sx, event.clientY - op.sy, b) });
    } else {
      setLive({ kind: 'split', ratio: dockRatioFromPointer(event.clientX - op.left, b) });
    }
  };

  const begin = (op: Op, event: ReactPointerEvent<HTMLElement>, initial: Live) => {
    if (event.button !== 0) return;
    event.preventDefault();
    detachRef.current?.();
    opRef.current = op;
    setLive(initial);
    const move = (e: PointerEvent) => onMove(e);
    const up = () => finish(true);
    const cancel = () => finish(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    detachRef.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  };

  const areaLeft = () => areaRef.current?.getBoundingClientRect().left ?? 0;
  const { state, focusToken } = controller;
  const measured = bounds.width > 0 && bounds.height > 0;
  const committedRect = measured ? effectiveRect(state, bounds) : null;

  const onTitlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as Element).closest('button, a, input, textarea')) return;
    const b = measure();
    if (!b.width || !committedRect) return;
    begin({ kind: 'move', sx: event.clientX, sy: event.clientY, start: committedRect, left: areaLeft() }, event, { kind: 'move', rect: committedRect, hint: false });
  };
  const onResizePointerDown = (dir: ResizeDir, event: ReactPointerEvent<HTMLElement>) => {
    const b = measure();
    if (!b.width || !committedRect) return;
    begin({ kind: 'resize', dir, sx: event.clientX, sy: event.clientY, start: committedRect }, event, { kind: 'resize', rect: committedRect });
  };
  const onDividerPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    measure();
    begin({ kind: 'split', left: areaLeft() }, event, { kind: 'split', ratio: state.dockRatio });
  };
  const onDividerKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const delta = event.key === 'ArrowLeft' ? DIVIDER_STEP : event.key === 'ArrowRight' ? -DIVIDER_STEP : 0;
    if (!delta) return;
    event.preventDefault();
    controller.setDockRatio(clampDockRatio(Math.round(state.dockRatio) + delta));
  };

  const minimized = state.minimized;
  // A phone has no half screen: full screen, or the floating box when the user shrinks it.
  // The stored form stays as it is for wider screens.
  const form: MetaChatForm = phone ? 'float' : state.form;
  const fullscreen = visible && !minimized && (phone ? !phoneWindowed : controller.fullscreen);
  const floating = form === 'float' && !fullscreen;
  const docked = visible && !minimized && form === 'dock' && !fullscreen;
  const ratio = live?.ratio ?? state.dockRatio;
  const rect = live?.rect ? clampRect(live.rect, bounds) : committedRect;
  const panelStyle = floating
    ? rect
      ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h }
      : { visibility: 'hidden' as const }
    : undefined;
  const pageShare = Math.round(100 - ratio);
  // The window covers the page on a phone (full screen or the floating box) and in full screen: opening the page minimizes it.
  const coversPage = phone || fullscreen;
  const { minimize } = controller;
  const revealPage = useCallback(() => { if (coversPage) minimize(); }, [coversPage, minimize]);

  // ── Window ⇄ pill (see MORPH_SPRING) ──────────────────────────
  const reduceMotion = useReducedMotionConfig();
  const shownForm: MetaChatForm | 'full' = fullscreen ? 'full' : form;
  const lastShownRef = useRef<ShownWindow | null>(null);
  /** What has been on screen for a frame: only a form the user saw morphs (not the first open's placement). */
  const settledRef = useRef<'window' | 'pill' | null>(null);
  const morphRef = useRef<Morph | null>(null);
  const morphSeqRef = useRef(0);
  /** The shrink effect holds the window on screen; its cleanup puts it to rest as it hides. */
  const holdingRef = useRef(false);
  const prevMinimizedRef = useRef(minimized);

  /**
   * Set while the window shrinks into the pill: it stays on screen in its
   * last box until then. Decided while rendering the minimize, so no commit
   * shows the window hidden before it shrinks.
   */
  const [leaving, setLeaving] = useState<ShownWindow | null>(null);
  const [leavingFor, setLeavingFor] = useState(minimized);
  if (leavingFor !== minimized) {
    setLeavingFor(minimized);
    const last = lastShownRef.current;
    const seen = morphRef.current !== null || settledRef.current === 'window';
    setLeaving(minimized && visible && !reduceMotion && seen && measurable(last?.box) ? last : null);
  }

  const panelElement = () => areaRef.current?.querySelector<HTMLElement>(':scope > .meta-chat-panel') ?? null;
  const pillElement = () => areaRef.current?.querySelector<HTMLElement>(':scope > .meta-chat-pill') ?? null;

  const startMorph = (kind: Morph['kind']): Morph => {
    morphRef.current?.runs.forEach((run) => run.stop());
    const morph = { kind, seq: ++morphSeqRef.current, runs: [] };
    morphRef.current = morph;
    return morph;
  };
  const endMorph = useCallback(() => {
    const morph = morphRef.current;
    if (!morph) return;
    morphRef.current = null;
    morph.runs.forEach((run) => run.stop());
    // A window still held for its shrink is put to rest as it hides (the
    // shrink effect's cleanup), never before: it would flash at full size.
    if (holdingRef.current) setLeaving(null);
    else resetMorph(areaRef.current?.querySelector<HTMLElement>(':scope > .meta-chat-panel') ?? null);
  }, []);
  const finishWhenDone = (morph: Morph, run: MorphRun) => {
    morph.runs.push(run);
    void run.then(() => {
      if (morphRef.current?.seq === morph.seq) endMorph();
    });
  };

  // The window's box while it is on screen, for the next shrink (a hidden
  // window has none). Layout boxes ignore a morph's transform.
  useLayoutEffect(() => {
    const panel = panelElement();
    if (!visible || minimized || !panel) return;
    lastShownRef.current = { box: layoutBox(panel), form: shownForm };
  }, [visible, minimized, shownForm, ratio, rect?.x, rect?.y, rect?.w, rect?.h, bounds.width, bounds.height]);

  // Restore (and a minimize without a shrink). Runs before paint: the first
  // frame is already the morph's.
  useLayoutEffect(() => {
    // Leaving Spaces (or Reduce motion turned on) mid-morph ends it where the form is now.
    if (!visible || reduceMotion) endMorph();
    if (prevMinimizedRef.current === minimized) return;
    prevMinimizedRef.current = minimized;
    if (minimized) {
      // The render chose whether the window shrinks; the effect below runs it.
      if (!leaving) endMorph();
      return;
    }
    const running = morphRef.current;
    const panel = panelElement();
    const seen = running !== null || settledRef.current === 'pill';
    if (!visible || reduceMotion || !seen || !panel) {
      endMorph();
      return;
    }
    const pill = pillElement();
    const from = pill ? layoutBox(pill) : null;
    const to = layoutBox(panel);
    if (running?.kind !== 'min' && (!measurable(from) || !measurable(to))) {
      endMorph();
      return;
    }
    const morph = startMorph('restore');
    if (running?.kind === 'min') {
      // A shrink under way turns around where it is.
      finishWhenDone(morph, animate(panel, { x: 0, y: 0, scale: 1, opacity: 1 }, { ...MORPH_SPRING, opacity: MORPH_FADE_IN }));
      return;
    }
    const start = morphTowards(to, from!);
    panel.style.opacity = '0';
    finishWhenDone(morph, animate(
      panel,
      { x: [start.x, 0], y: [start.y, 0], scale: [start.scale, 1], opacity: [0, 1] },
      { ...MORPH_SPRING, opacity: MORPH_FADE_IN },
    ));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minimized, visible, reduceMotion, endMorph]);

  // The shrink: the window, held in its last box, goes into the pill. It is
  // no live layer meanwhile (no focus, pointer or screen reader).
  useLayoutEffect(() => {
    const panel = panelElement();
    if (!leaving || !panel) return undefined;
    const running = morphRef.current;
    const morph = startMorph('min');
    holdingRef.current = true;
    panel.setAttribute('inert', '');
    panel.setAttribute('aria-hidden', 'true');
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && panel.contains(focused)) focused.blur();
    const pill = pillElement();
    const to = pill ? layoutBox(pill) : null;
    if (measurable(to)) {
      const end = morphTowards(leaving.box, to);
      finishWhenDone(morph, animate(
        panel,
        running?.kind === 'restore'
          // A grow under way turns around where it is.
          ? { x: end.x, y: end.y, scale: end.scale, opacity: 0 }
          : { x: [0, end.x], y: [0, end.y], scale: [1, end.scale], opacity: [1, 0] },
        { ...MORPH_SPRING, opacity: MORPH_FADE_OUT },
      ));
      if (pill) {
        pill.style.opacity = '0';
        morph.runs.push(animate(pill, { opacity: [0, 1] }, PILL_FADE_IN));
      }
    } else {
      endMorph();
    }
    return () => {
      holdingRef.current = false;
      panel.removeAttribute('inert');
      panel.removeAttribute('aria-hidden');
      // Ended: the window hides in this commit, back at rest. A restore that
      // turns the shrink around carries on from where it is.
      if (!morphRef.current) resetMorph(panel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving, endMorph]);

  useLayoutEffect(() => {
    settledRef.current = null;
    if (!visible) return undefined;
    const frame = requestAnimationFrame(() => { settledRef.current = minimized ? 'pill' : 'window'; });
    return () => cancelAnimationFrame(frame);
  }, [visible, minimized]);

  useEffect(() => endMorph, [endMorph]);

  const panelHidden = !visible || (minimized && !leaving);
  const shownStyle: CSSProperties | undefined = leaving
    ? {
      position: 'absolute', left: leaving.box.x, top: leaving.box.y, width: leaving.box.w, height: leaving.box.h,
      zIndex: 'var(--z-pane-overlay)', pointerEvents: 'none',
    }
    : panelStyle;

  return (
    <div
      ref={areaRef}
      className="meta-chat-area"
      data-form={!visible ? 'hidden' : minimized ? 'min' : fullscreen ? 'full' : form}
      data-op={live?.kind}
    >
      <div className="meta-chat-area__page" hidden={fullscreen} style={docked ? { flexBasis: `${100 - ratio}%` } : undefined}>
        <MetaChatDockedContext.Provider value={docked}>{children}</MetaChatDockedContext.Provider>
      </div>
      {docked ? (
        <div
          className="meta-chat-divider"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize assistant"
          aria-valuemin={30}
          aria-valuemax={70}
          aria-valuenow={Math.round(ratio)}
          tabIndex={0}
          onPointerDown={onDividerPointerDown}
          onKeyDown={onDividerKeyDown}
        >
          <i aria-hidden />
          {live?.kind === 'split' ? <span className="meta-chat-divider__pct">{pageShare} : {100 - pageShare}</span> : null}
        </div>
      ) : null}
      {visible && floating && !minimized && !phone ? (
        <div className="meta-chat-dock-ghost" data-on={live?.hint ? '' : undefined} aria-hidden={!live?.hint}>
          Release to dock as half screen
        </div>
      ) : null}
      <MetaChatRevealPageContext.Provider value={revealPage}>
        <MetaChatPanel
          {...content}
          form={leaving ? leaving.form : shownForm}
          hidden={panelHidden}
          style={shownStyle}
          focusToken={focusToken}
          sizeLabel={live?.kind === 'resize' && rect ? `${rect.w} × ${rect.h}` : null}
          onTitlePointerDown={onTitlePointerDown}
          onResizePointerDown={onResizePointerDown}
          onToggleDock={phone ? undefined : floating ? controller.dock : controller.float}
          onMinimize={controller.minimize}
          onToggleFullscreen={phone ? () => setPhoneWindowed((value) => !value) : controller.toggleFullscreen}
        />
      </MetaChatRevealPageContext.Provider>
      <AnimatePresence initial={false}>
        {visible && minimized ? (
          <MetaChatPill
            key="pill"
            label={pillLabel}
            busy={Boolean(content.busy)}
            firstRunDot={firstRunDot}
            onRestore={controller.restore}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}
