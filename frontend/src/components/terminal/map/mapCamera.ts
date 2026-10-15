// Pure camera math for the Map graph view. The camera maps world (layout)
// coordinates to surface pixels: screen = world * k + (x, y). Kept free of
// React and the DOM so the framing rules are unit-testable.

export type Camera = { x: number; y: number; k: number };
export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
export type Rect = { minX: number; minY: number; maxX: number; maxY: number };

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 3;

/** Auto framing never enlarges past this. */
export const AUTO_MAX_ZOOM = 1.25;
/** Auto framing never shrinks below this, so card text stays readable; a
 *  focus region that doesn't fit overflows instead (anchored on the root). */
export const AUTO_MIN_ZOOM = 0.8;
/** Branches after the root that the default view frames. */
export const FOCUS_BRANCHES = 3;

/** Per-event cap on the pinch / ctrl+wheel delta (in pixel units) so one
 *  mouse-wheel notch (deltaY ≈ 100) zooms ≈1.35x instead of jumping. */
const MAX_ZOOM_DELTA = 30;
/** ln(k'/k) per pixel of deltaY. A macOS trackpad pinch emits small deltas
 *  (≈1–10px per event), so this keeps the scale tracking the fingers. */
const ZOOM_RATE = 0.01;
const LINE_HEIGHT = 16;

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Convert a WheelEvent delta to pixels regardless of deltaMode. */
export function wheelDeltaPixels(
  delta: number,
  deltaMode: number,
  pageSize: number,
): number {
  if (deltaMode === 1) return delta * LINE_HEIGHT; // DOM_DELTA_LINE
  if (deltaMode === 2) return delta * pageSize; // DOM_DELTA_PAGE
  return delta;
}

/** Zoom factor for a pinch (ctrlKey wheel) or ⌘/ctrl + wheel event. */
export function wheelZoomFactor(deltaYPixels: number): number {
  const d = clamp(deltaYPixels, -MAX_ZOOM_DELTA, MAX_ZOOM_DELTA);
  return Math.exp(-d * ZOOM_RATE);
}

/** Scale the camera by `factor` keeping the world point under `anchor`
 *  (surface pixels) fixed on screen. */
export function zoomAt(
  cam: Camera,
  anchor: Point,
  factor: number,
  minK = MIN_ZOOM,
  maxK = MAX_ZOOM,
): Camera {
  const k = clamp(cam.k * factor, minK, maxK);
  const ratio = k / cam.k;
  return {
    k,
    x: anchor.x - (anchor.x - cam.x) * ratio,
    y: anchor.y - (anchor.y - cam.y) * ratio,
  };
}

/** Keep at least `margin` px of the content on screen on each axis so a
 *  fling can't lose the graph entirely. */
export function clampCamera(
  cam: Camera,
  viewport: Size,
  content: Size,
  margin = 96,
): Camera {
  const w = content.width * cam.k;
  const h = content.height * cam.k;
  const mx = Math.min(margin, w);
  const my = Math.min(margin, h);
  return {
    k: cam.k,
    x: clamp(cam.x, mx - w, viewport.width - mx),
    y: clamp(cam.y, my - h, viewport.height - my),
  };
}

/**
 * The root plus the first `count` nodes after it, breadth-first, taking
 * siblings in drawn order (top to bottom, then left to right). A bushy root
 * yields its first three child branches; a linear thread yields the next three
 * nodes of the chain.
 */
export function focusIds(
  rootId: string,
  children: ReadonlyMap<string, readonly string[]>,
  positions: ReadonlyMap<string, Point>,
  count: number,
): string[] {
  if (!positions.has(rootId)) return [];
  const out = [rootId];
  const seen = new Set(out);
  const drawnOrder = (a: string, b: string) => {
    const pa = positions.get(a)!;
    const pb = positions.get(b)!;
    return pa.y - pb.y || pa.x - pb.x;
  };
  for (let i = 0; i < out.length && out.length <= count; i++) {
    const kids = (children.get(out[i]) ?? [])
      .filter((id) => positions.has(id) && !seen.has(id))
      .sort(drawnOrder);
    for (const id of kids) {
      if (out.length > count) break;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Bounding box of node boxes centred on their layout positions. */
export function boundsOf(
  ids: Iterable<string>,
  positions: ReadonlyMap<string, Point>,
  sizeOf: (id: string) => Size,
): Rect | null {
  let rect: Rect | null = null;
  for (const id of ids) {
    const p = positions.get(id);
    if (!p) continue;
    const { width, height } = sizeOf(id);
    const minX = p.x - width / 2;
    const minY = p.y - height / 2;
    const maxX = p.x + width / 2;
    const maxY = p.y + height / 2;
    rect = rect
      ? {
          minX: Math.min(rect.minX, minX),
          minY: Math.min(rect.minY, minY),
          maxX: Math.max(rect.maxX, maxX),
          maxY: Math.max(rect.maxY, maxY),
        }
      : { minX, minY, maxX, maxY };
  }
  return rect;
}

function fitScale(rect: Rect, viewport: Size, padding: number): number {
  const usableW = Math.max(1, viewport.width - padding * 2);
  const usableH = Math.max(1, viewport.height - padding * 2);
  return Math.min(
    usableW / Math.max(1, rect.maxX - rect.minX),
    usableH / Math.max(1, rect.maxY - rect.minY),
  );
}

/** One axis: centre the frame when it fits; otherwise centre on the anchor
 *  but never leave an empty gap past the padding on the frame's near side. */
function placeAxis(
  min: number,
  max: number,
  anchor: number,
  k: number,
  viewportLen: number,
  padding: number,
): number {
  const span = (max - min) * k;
  if (span <= viewportLen - padding * 2) {
    return viewportLen / 2 - ((min + max) / 2) * k;
  }
  const centred = viewportLen / 2 - anchor * k;
  const lo = viewportLen - padding - max * k; // far edge reaches the far side
  const hi = padding - min * k; // near edge sits at the padding
  return clamp(centred, lo, hi);
}

export type AutoFrameInput = {
  /** Bounds of the cards to frame (root + first branches, or everything). */
  focus: Rect;
  /** World point to keep in view when the focus overflows (the root). */
  anchor: Point;
  viewport: Size;
  padding: number;
};

/** Default framing: fit the focus cards, between AUTO_MIN_ZOOM and
 *  AUTO_MAX_ZOOM. Everything outside the focus is reached by panning. */
export function autoCamera({ focus, anchor, viewport, padding }: AutoFrameInput): Camera {
  const k = clamp(fitScale(focus, viewport, padding), AUTO_MIN_ZOOM, AUTO_MAX_ZOOM);
  return {
    k,
    x: placeAxis(focus.minX, focus.maxX, anchor.x, k, viewport.width, padding),
    y: placeAxis(focus.minY, focus.maxY, anchor.y, k, viewport.height, padding),
  };
}

export function sameCamera(a: Camera, b: Camera, eps = 0.01): boolean {
  return (
    Math.abs(a.x - b.x) < eps &&
    Math.abs(a.y - b.y) < eps &&
    Math.abs(a.k - b.k) < eps / 100
  );
}

export function cameraTransform(cam: Camera): string {
  return `translate3d(${cam.x}px, ${cam.y}px, 0) scale(${cam.k})`;
}
