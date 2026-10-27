import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Sparkle } from 'lucide-react';
import {
  clampDockRatio,
  dockRatioFromPointer,
  effectiveRect,
  firstOpenPlacement,
  isDockHint,
  moveRect,
  resizeRect,
  type Bounds,
  type ColumnSpan,
  type Rect,
  type ResizeDir,
} from '../../../../state/metaChat/metaChatWindowModel';
import type { MetaChatWindowController } from '../../../../state/metaChat/useMetaChatWindow';
import { firstRunActive, useSpacesFirstRun } from '../../../../state/metaAgent/spacesFirstRun';
import { MetaChatPanel, MINIMIZE_KEYS, type MetaChatContentProps } from './MetaChatPanel';
import './metaChat.css';

export interface MetaChatAreaProps extends MetaChatContentProps {
  controller: MetaChatWindowController;
  /** False outside Spaces: the page fills the area and the window keeps its state for the return. */
  visible?: boolean;
  /** Listen for ⌘J / Ctrl+J. Turn off when the host routes the shortcut to toggleMinimized itself. */
  shortcut?: boolean;
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

/** The minimized pill's dot: the window's answer is streaming, or the Meta agent's first run is reading in the background. */
function PillWorkingDot({ busy }: { busy: boolean }) {
  const firstRun = useSpacesFirstRun('local');
  if (!busy && !firstRunActive(firstRun.data)) return null;
  return <span className="meta-chat-pill__dot" role="status" aria-label="Assistant is working" />;
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
      else if (last.rect) c.setRect(last.rect);
    } else if (op.kind === 'resize') {
      if (last.rect) c.setRect(last.rect);
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
        hint: isDockHint(event.clientX - op.left, b),
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
  const fullscreen = visible && !state.minimized && controller.fullscreen;
  const floating = state.form === 'float' && !fullscreen;
  const docked = visible && !minimized && state.form === 'dock' && !fullscreen;
  const ratio = live?.ratio ?? state.dockRatio;
  const rect = live?.rect ?? committedRect;
  const panelStyle = floating
    ? rect
      ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h }
      : { visibility: 'hidden' as const }
    : undefined;
  const pageShare = Math.round(100 - ratio);

  return (
    <div
      ref={areaRef}
      className="meta-chat-area"
      data-form={!visible ? 'hidden' : minimized ? 'min' : fullscreen ? 'full' : state.form}
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
      {visible && floating && !minimized ? (
        <div className="meta-chat-dock-ghost" data-on={live?.hint ? '' : undefined} aria-hidden={!live?.hint}>
          Release to dock as half screen
        </div>
      ) : null}
      <MetaChatPanel
        {...content}
        form={fullscreen ? 'full' : state.form}
        hidden={!visible || minimized}
        style={panelStyle}
        focusToken={focusToken}
        sizeLabel={live?.kind === 'resize' && rect ? `${rect.w} × ${rect.h}` : null}
        onTitlePointerDown={onTitlePointerDown}
        onResizePointerDown={onResizePointerDown}
        onToggleDock={floating ? controller.dock : controller.float}
        onMinimize={controller.minimize}
        onToggleFullscreen={controller.toggleFullscreen}
      />
      {visible && minimized ? (
        <button
          type="button"
          className="meta-chat-pill"
          aria-label="Ask assistant"
          title={`Ask assistant (${MINIMIZE_KEYS})`}
          onClick={controller.restore}
        >
          <Sparkle className="meta-chat-pill__icon" size={20} aria-hidden />
          <PillWorkingDot busy={Boolean(content.busy)} />
        </button>
      ) : null}
    </div>
  );
}
