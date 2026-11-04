import React from 'react';
import { getElectron } from '../../lib/electronBridge';
import { blurSnapshot } from './frozenGlassBitmap';
import * as perf from '../../services/perf';

/**
 * Frozen glass: a frosted panel whose blur is computed once, from a capture of
 * the window taken as it opens, instead of a live backdrop-filter.
 *
 * This avoids live backdrop sampling while a transcript or Working indicator
 * repaints. It does not depend on Chromium presentation feature flags.
 *
 * Phases: 'capturing' (the modal is mounted and its input focused, but
 * neither the scrim nor the panel is drawn, so the capture is the page as it
 * was), then 'frozen', or 'solid' if capture is unavailable, disabled, fails or
 * exceeds the budget. Resize also falls back to solid, never to live blur.
 * A late capture is dropped: the open panel could be in it. 'live' is only
 * used when the caller did not request frozen glass (the web default).
 * The frozen layer lays the scrim's dim over the capture.
 */
type GlassPhase = 'live' | 'capturing' | 'frozen' | 'solid';

/** Past this the panel opens solid: never wait indefinitely for decoration. */
const FROZEN_GLASS_BUDGET_MS = 150;

interface Snapshot { canvas: HTMLCanvasElement; width: number; height: number }

function releaseBitmap(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  // React's retiring fiber can retain the canvas object after unmount. Drop
  // its pixel backing immediately instead of waiting for that object's GC.
  canvas.width = 0;
  canvas.height = 0;
}

function px(value: string, fallback: number): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

export function useFrozenGlass(
  panelRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  allowCapture = true,
): { phase: GlassPhase; layer: React.ReactNode } {
  const [initialPhase] = React.useState<GlassPhase>(() => (
    !enabled ? 'live' : allowCapture && typeof getElectron()?.captureBackdrop === 'function' ? 'capturing' : 'solid'
  ));
  const [phase, setPhase] = React.useState<GlassPhase>(initialPhase);
  const [snapshot, setSnapshot] = React.useState<Snapshot | null>(null);

  React.useLayoutEffect(() => {
    if (initialPhase !== 'capturing') return;
    const started = perf.now();
    const panel = panelRef.current;
    const capture = getElectron()?.captureBackdrop;
    const style = panel ? getComputedStyle(panel) : null;
    // Reduced transparency (.term-glass turns solid) or a zero blur (the Glass
    // blur setting): there is no live frost to replace. Not read from the
    // panel's backdrop-filter, which the capturing phase itself turns off.
    const blurPx = px(style?.getPropertyValue('--term-glass-blur') ?? '', 26);
    const reducedTransparency = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-transparency: reduce)').matches;
    if (!panel || !capture || blurPx <= 0 || reducedTransparency) {
      perf.measure('glass.open', started, { outcome: 'disabled' });
      setPhase('solid');
      return;
    }
    let done = false;
    let ownedCanvas: HTMLCanvasElement | null = null;
    const deadline = performance.now() + FROZEN_GLASS_BUDGET_MS;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const budget = window.setTimeout(() => {
      if (!done) {
        done = true;
        perf.measure('glass.open', started, { outcome: 'deadline' });
        setPhase('solid');
      }
    }, FROZEN_GLASS_BUDGET_MS);
    void (async () => {
      // Nothing of the modal is drawn yet: the window is still the page.
      const captureStart = perf.now();
      let rejected = false;
      const url = await capture({ x: 0, y: 0, width, height }).catch(() => { rejected = true; return null; });
      perf.measure('glass.capture', captureStart, { outcome: rejected ? 'rejected' : url ? 'success' : 'empty', late: done, dataUrlChars: url?.length ?? 0 });
      if (done) return;
      const canvas = url && performance.now() < deadline
        ? await blurSnapshot(url, {
            blurPx,
            saturate: style?.getPropertyValue('--term-glass-saturate').trim() || '160%',
            viewportWidth: width,
          }).catch(() => null)
        : null;
      if (done) { releaseBitmap(canvas); return; }
      done = true;
      window.clearTimeout(budget);
      // Decoding/blur can finish after the deadline before the timer gets a
      // turn on a busy main thread. Do not accept that late image either.
      if (!canvas || performance.now() >= deadline || window.innerWidth !== width || window.innerHeight !== height) {
        perf.measure('glass.open', started, { outcome: performance.now() >= deadline ? 'deadline' : !url ? 'capture-failed' : !canvas ? 'decode-failed' : 'resized' });
        releaseBitmap(canvas);
        setPhase('solid');
        return;
      }
      ownedCanvas = canvas;
      setSnapshot({ canvas, width, height });
      perf.measure('glass.open', started, { outcome: 'frozen' });
      setPhase('frozen');
    })();
    return () => {
      if (!done) perf.measure('glass.open', started, { outcome: 'cancelled' });
      done = true;
      window.clearTimeout(budget);
      releaseBitmap(ownedCanvas);
      if (ownedCanvas) perf.mark('glass.release', { reason: 'unmount' });
    };
  // This effect owns the bitmap for this opening, not just the capture phase.
  // It must not release the image when capturing transitions to frozen.
  }, [initialPhase, panelRef]);

  // A resized window no longer matches the capture. Stay independent of the
  // moving background for the rest of this opening, even if it resizes back.
  React.useEffect(() => {
    if (phase !== 'frozen' || !snapshot) return;
    const onResize = () => {
      if (window.innerWidth !== snapshot.width || window.innerHeight !== snapshot.height) {
        perf.mark('glass.invalidate', { reason: 'resize' });
        releaseBitmap(snapshot.canvas);
        setSnapshot(null);
        setPhase('solid');
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [phase, snapshot]);

  const layer = phase === 'frozen' && snapshot
    ? <FrozenGlassLayer panelRef={panelRef} snapshot={snapshot} />
    : null;
  return { phase, layer };
}

/** The pre-blurred capture, lined up with the window under the panel, plus the glass tint. */
function FrozenGlassLayer({ panelRef, snapshot }: { panelRef: React.RefObject<HTMLElement | null>; snapshot: Snapshot }) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const imageRef = React.useRef<HTMLDivElement>(null);

  React.useLayoutEffect(() => {
    const root = rootRef.current;
    const image = imageRef.current;
    const panel = panelRef.current;
    if (!root || !image || !panel) return;
    image.appendChild(snapshot.canvas);
    // The panel can grow or move (results arriving, a centered modal's
    // height changing); keep the capture registered to the window. Measured
    // from layout offsets, not getBoundingClientRect: the panel enters scaled
    // (0.96 → 1), and a scaled rect would leave the capture off by its
    // shrink once the entrance ends.
    const place = () => {
      const parent = panel.offsetParent as HTMLElement | null;
      const base = parent ? parent.getBoundingClientRect() : { left: 0, top: 0 };
      // The layer sits 1px outside the panel's padding box (inset: -1px).
      const left = base.left + panel.offsetLeft + panel.clientLeft - 1;
      const top = base.top + panel.offsetTop + panel.clientTop - 1;
      image.style.left = `${-left}px`;
      image.style.top = `${-top}px`;
    };
    place();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    ro?.observe(panel);
    return () => {
      ro?.disconnect();
      snapshot.canvas.remove();
    };
  }, [panelRef, snapshot]);

  return (
    <div ref={rootRef} className="ui-frozen-glass" aria-hidden="true">
      <div ref={imageRef} className="ui-frozen-glass__image" style={{ width: snapshot.width, height: snapshot.height }} />
      <div className="ui-frozen-glass__dim" />
      <div className="term-glass ui-frozen-glass__tint" />
    </div>
  );
}
