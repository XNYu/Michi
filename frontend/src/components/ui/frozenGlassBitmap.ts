import * as perf from '../../services/perf';

/**
 * Blur one window capture into a canvas, once. The result is a plain static
 * bitmap: nothing about it is recomputed when the page behind it repaints.
 * `blurPx` is in CSS pixels; the capture is downscaled, so the radius is
 * scaled by the image's width over `viewportWidth` (CSS px).
 */
export async function blurSnapshot(
  url: string,
  opts: { blurPx: number; saturate: string; viewportWidth: number },
): Promise<HTMLCanvasElement | null> {
  const img = new Image();
  const decodeStart = perf.now();
  img.src = url;
  try {
    await img.decode();
  } catch {
    perf.measure('glass.decode', decodeStart, { outcome: 'failed' });
    img.removeAttribute('src');
    return null;
  }
  perf.measure('glass.decode', decodeStart, { outcome: 'success', width: img.naturalWidth, height: img.naturalHeight });
  const drawStart = perf.now();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    canvas.width = 0;
    canvas.height = 0;
    perf.measure('glass.draw', drawStart, { outcome: 'no-context' });
    img.removeAttribute('src');
    return null;
  }
  // The sharp copy underneath keeps the edges opaque where the blur would
  // otherwise fade into the transparent area outside the image.
  try {
    ctx.drawImage(img, 0, 0);
    const scale = opts.viewportWidth > 0 ? img.naturalWidth / opts.viewportWidth : 1;
    ctx.filter = `blur(${Math.max(0, opts.blurPx * scale)}px) saturate(${opts.saturate})`;
    ctx.drawImage(img, 0, 0);
    perf.measure('glass.draw', drawStart, { outcome: 'success' });
    return canvas;
  } catch {
    canvas.width = 0;
    canvas.height = 0;
    perf.measure('glass.draw', drawStart, { outcome: 'failed' });
    return null;
  } finally {
    img.removeAttribute('src');
  }
}
