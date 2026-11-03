import { toSurfaceBounds, type SurfaceBounds } from './browserBounds';

/**
 * Frozen glass (⌘K): the renderer blurs one capture of the window instead of
 * a live backdrop-filter, which on macOS Chromium sometimes misses a frame and
 * shows the panel without its frost. The capture is blurred anyway, so a
 * quarter of the window's points is plenty and keeps the IPC payload small.
 */
const BACKDROP_SCALE = 0.25;

/** The rect (CSS px) in window points, clipped to the window's content; null if nothing is left. */
export function backdropCaptureBounds(
  rect: unknown,
  zoomFactor: number,
  content: { width: number; height: number },
): SurfaceBounds | null {
  const bounds = toSurfaceBounds(rect, zoomFactor);
  if (!bounds) return null;
  const x = Math.max(0, bounds.x);
  const y = Math.max(0, bounds.y);
  const right = Math.min(content.width, bounds.x + bounds.width);
  const bottom = Math.min(content.height, bounds.y + bounds.height);
  if (right - x < 1 || bottom - y < 1) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/** Width to resize a capture of `bounds` to before it crosses IPC. */
export function backdropImageWidth(bounds: SurfaceBounds): number {
  return Math.max(1, Math.round(bounds.width * BACKDROP_SCALE));
}
