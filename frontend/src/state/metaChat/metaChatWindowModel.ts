export type MetaChatForm = 'float' | 'dock';
export type ResizeDir = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

export interface Rect { x: number; y: number; w: number; h: number }
export interface Bounds { width: number; height: number }

export interface MetaChatWindowState {
  form: MetaChatForm;
  minimized: boolean;
  /** Last floating box in main-area coordinates; null means the default bottom-right box. */
  rect: Rect | null;
  /** The window's share of the main area when docked, in percent. */
  dockRatio: number;
}

export const DEFAULT_SIZE = { w: 384, h: 520 } as const;
export const MIN_SIZE = { w: 320, h: 300 } as const;
export const FLOAT_MARGIN = 18;
export const TITLE_BAR_HEIGHT = 46;
export const DOCK_EDGE = 40;
export const DOCK_RATIO = { min: 30, max: 70, initial: 50 } as const;
export const METACHAT_STORAGE_KEY = 'michi:metaChat:window:v1';

export const INITIAL_METACHAT_STATE: MetaChatWindowState = {
  form: 'float',
  minimized: false,
  rect: null,
  dockRatio: DOCK_RATIO.initial,
};

const clamp = (value: number, lo: number, hi: number) => Math.min(Math.max(value, lo), Math.max(lo, hi));
const measured = (b: Bounds) => b.width > 0 && b.height > 0;

export function defaultRect(b: Bounds): Rect {
  return clampRect({
    x: b.width - DEFAULT_SIZE.w - FLOAT_MARGIN,
    y: b.height - DEFAULT_SIZE.h - FLOAT_MARGIN,
    w: DEFAULT_SIZE.w,
    h: DEFAULT_SIZE.h,
  }, b);
}

/**
 * The box may hang off the left, right and bottom edges, but is never wider or
 * taller than the area. Its title bar stays inside: the top edge never leaves
 * the area and at least half the bar's width stays in it, so it can always be
 * dragged back.
 */
export function clampRect(r: Rect, b: Bounds): Rect {
  if (!measured(b)) return r;
  const w = Math.round(clamp(r.w, Math.min(MIN_SIZE.w, b.width), b.width));
  const h = Math.round(clamp(r.h, Math.min(MIN_SIZE.h, b.height), b.height));
  const keep = Math.ceil(w / 2);
  return {
    w,
    h,
    x: Math.round(clamp(r.x, keep - w, b.width - keep)),
    y: Math.round(clamp(r.y, 0, b.height - TITLE_BAR_HEIGHT)),
  };
}

export function effectiveRect(state: MetaChatWindowState, b: Bounds): Rect {
  return state.rect ? clampRect(state.rect, b) : defaultRect(b);
}

/** The page's main text column, in main-area coordinates. */
export interface ColumnSpan { left: number; right: number }

/**
 * Width of the Spaces document column (the content box of
 * `.area-settings__doc`), assumed while the page has not rendered its column.
 */
export const ASSUMED_COLUMN_WIDTH = 768;

export interface FirstOpenPlacement { minimized: boolean; rect: Rect | null }

/**
 * Where the window opens the first time, before the user has placed it: the
 * default bottom-right box when that leaves the page's main column clear;
 * else a narrower box beside the column when one at least MIN_SIZE wide fits;
 * else minimized, so the page can be read and the pill is one click away.
 */
export function firstOpenPlacement(b: Bounds, column: ColumnSpan | null): FirstOpenPlacement {
  if (!measured(b)) return { minimized: false, rect: null };
  const col = column ?? { left: (b.width - ASSUMED_COLUMN_WIDTH) / 2, right: (b.width + ASSUMED_COLUMN_WIDTH) / 2 };
  const box = defaultRect(b);
  if (box.x >= col.right + FLOAT_MARGIN) return { minimized: false, rect: null };
  const room = b.width - col.right - 2 * FLOAT_MARGIN;
  if (room >= MIN_SIZE.w) {
    const w = Math.floor(Math.min(DEFAULT_SIZE.w, room));
    return { minimized: false, rect: clampRect({ x: b.width - FLOAT_MARGIN - w, y: box.y, w, h: box.h }, b) };
  }
  return { minimized: true, rect: null };
}

export function moveRect(start: Rect, dx: number, dy: number, b: Bounds): Rect {
  return clampRect({ ...start, x: start.x + dx, y: start.y + dy }, b);
}

export function resizeRect(start: Rect, dir: ResizeDir, dx: number, dy: number, b: Bounds): Rect {
  let { x, y, w, h } = start;
  if (dir.includes('e')) w = start.w + dx;
  if (dir.includes('s')) h = start.h + dy;
  if (dir.includes('w')) { w = start.w - dx; x = start.x + dx; }
  if (dir.includes('n')) { h = start.h - dy; y = start.y + dy; }
  if (w < MIN_SIZE.w) { if (dir.includes('w')) x = start.x + start.w - MIN_SIZE.w; w = MIN_SIZE.w; }
  if (h < MIN_SIZE.h) { if (dir.includes('n')) y = start.y + start.h - MIN_SIZE.h; h = MIN_SIZE.h; }
  // A dragged edge stops at the area's edge; an edge already past it (a box hanging off) stays where it is.
  const left = Math.min(start.x, 0);
  if (x < left) { w -= left - x; x = left; }
  if (y < 0) { h += y; y = 0; }
  if (measured(b)) {
    w = Math.min(w, Math.max(start.x + start.w, b.width) - x, b.width);
    h = Math.min(h, Math.max(start.y + start.h, b.height) - y, b.height);
  }
  return {
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(Math.max(w, Math.min(MIN_SIZE.w, b.width || MIN_SIZE.w))),
    h: Math.round(Math.max(h, Math.min(MIN_SIZE.h, b.height || MIN_SIZE.h))),
  };
}

/** Pointer x is relative to the main area's left edge. */
export function isDockHint(pointerX: number, b: Bounds): boolean {
  return measured(b) && pointerX >= b.width - DOCK_EDGE;
}

export function clampDockRatio(ratio: number): number {
  return clamp(ratio, DOCK_RATIO.min, DOCK_RATIO.max);
}

export function dockRatioFromPointer(pointerX: number, b: Bounds): number {
  if (!measured(b)) return DOCK_RATIO.initial;
  return clampDockRatio(((b.width - pointerX) / b.width) * 100);
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseRect(raw: unknown): Rect | null {
  if (!raw || typeof raw !== 'object') return null;
  const { x, y, w, h } = raw as Record<string, unknown>;
  if (!finite(x) || !finite(y) || !finite(w) || !finite(h) || w <= 0 || h <= 0) return null;
  return { x, y, w: Math.max(w, MIN_SIZE.w), h: Math.max(h, MIN_SIZE.h) };
}

/** Each field falls back on its own, so one bad value does not reset the rest. */
export function parseStoredState(raw: string | null): MetaChatWindowState | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  return {
    form: d.form === 'dock' ? 'dock' : 'float',
    minimized: d.minimized === true,
    rect: parseRect(d.rect),
    dockRatio: finite(d.dockRatio) ? clampDockRatio(d.dockRatio) : DOCK_RATIO.initial,
  };
}

export function readStoredState(storage: Storage | null, key = METACHAT_STORAGE_KEY): MetaChatWindowState {
  try {
    return parseStoredState(storage?.getItem(key) ?? null) ?? INITIAL_METACHAT_STATE;
  } catch {
    return INITIAL_METACHAT_STATE;
  }
}

export function writeStoredState(storage: Storage | null, state: MetaChatWindowState, key = METACHAT_STORAGE_KEY): void {
  try {
    storage?.setItem(key, JSON.stringify(state));
  } catch {
    // Quota or privacy mode: the window still works for this session.
  }
}
