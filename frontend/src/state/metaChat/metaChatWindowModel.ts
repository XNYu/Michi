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

/** Insets shrink only when the area itself is too small to leave the normal margin. */
function floatLimits(b: Bounds) {
  const x = Math.min(FLOAT_MARGIN, Math.max(0, (b.width - 1) / 2));
  const y = Math.min(FLOAT_MARGIN, Math.max(0, (b.height - 1) / 2));
  return { x, y, width: b.width - 2 * x, height: b.height - 2 * y };
}

/** Keep the entire floating box inside the area, with a gutter on all four sides. */
export function clampRect(r: Rect, b: Bounds): Rect {
  if (!measured(b)) return r;
  const limit = floatLimits(b);
  const w = clamp(Math.round(r.w), Math.min(MIN_SIZE.w, limit.width), limit.width);
  const h = clamp(Math.round(r.h), Math.min(MIN_SIZE.h, limit.height), limit.height);
  return {
    w,
    h,
    x: clamp(Math.round(r.x), limit.x, b.width - limit.x - w),
    y: clamp(Math.round(r.y), limit.y, b.height - limit.y - h),
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
  if (!measured(b)) return start;
  const box = clampRect(start, b);
  const limit = floatLimits(b);
  const minW = Math.min(MIN_SIZE.w, limit.width);
  const minH = Math.min(MIN_SIZE.h, limit.height);
  let left = box.x;
  let top = box.y;
  let right = box.x + box.w;
  let bottom = box.y + box.h;
  if (dir.includes('w')) left = clamp(Math.round(box.x + dx), limit.x, right - minW);
  if (dir.includes('e')) right = clamp(Math.round(right + dx), left + minW, b.width - limit.x);
  if (dir.includes('n')) top = clamp(Math.round(box.y + dy), limit.y, bottom - minH);
  if (dir.includes('s')) bottom = clamp(Math.round(bottom + dy), top + minH, b.height - limit.y);
  return { x: left, y: top, w: right - left, h: bottom - top };
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
