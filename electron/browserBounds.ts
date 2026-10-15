export interface SurfaceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Convert a renderer rect into bounds for `WebContentsView.setBounds`.
 *
 * The renderer measures with getBoundingClientRect, which returns CSS pixels.
 * setBounds takes window points. The two differ by the host page's zoom
 * factor (View > Zoom In/Out, which Chromium persists per origin), so a
 * zoomed window would otherwise draw the surface shrunk toward its top-left.
 *
 * Edges are rounded rather than sizes so neighbouring rects never open a gap.
 * Returns null for a malformed rect.
 */
export function toSurfaceBounds(value: unknown, zoomFactor: number): SurfaceBounds | null {
  if (!value || typeof value !== 'object') return null;
  const { x, y, width, height } = value as Record<string, unknown>;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) return null;
  const scale = isFiniteNumber(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const left = Math.round(x * scale);
  const top = Math.round(y * scale);
  return {
    x: left,
    y: top,
    width: Math.max(1, Math.round((x + width) * scale) - left),
    height: Math.max(1, Math.round((y + height) * scale) - top),
  };
}
