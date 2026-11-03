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
  img.src = url;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  // The sharp copy underneath keeps the edges opaque where the blur would
  // otherwise fade into the transparent area outside the image.
  ctx.drawImage(img, 0, 0);
  const scale = opts.viewportWidth > 0 ? img.naturalWidth / opts.viewportWidth : 1;
  ctx.filter = `blur(${Math.max(0, opts.blurPx * scale)}px) saturate(${opts.saturate})`;
  ctx.drawImage(img, 0, 0);
  return canvas;
}
