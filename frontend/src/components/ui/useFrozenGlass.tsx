import React from 'react';
import { getElectron } from '../../lib/electronBridge';
import { blurSnapshot } from './frozenGlassBitmap';

/**
 * Frozen glass: a frosted panel whose blur is computed once, from a capture of
 * the window taken as it opens, instead of a live backdrop-filter.
 *
 * On macOS, Chromium re-blurs a live backdrop every frame the page behind it
 * repaints (a streaming reply) and now and then presents a frame without it,
 * so the panel's frost blinks off and on. A captured, pre-blurred bitmap has
 * nothing to recompute. What's behind the panel is unreadable through the
 * blur anyway, so the frost not following it while open goes unnoticed.
 *
 * Phases: 'capturing' (the modal is mounted and its input focused, but
 * neither the scrim nor the panel is drawn, so the capture is the page as it
 * was), then 'frozen', or 'live' when there is nothing to freeze: no desktop
 * bridge (web), glass turned off, a failed capture, or one slower than the
 * budget. The modal's entrance plays after it. A late capture is dropped (the
 * open panel would be in it), and so is the snapshot once the window resizes.
 * Live glass is the panel as it always was. The frozen layer lays the scrim's
 * dim over the capture, as the live glass sees it through the scrim.
 */
type GlassPhase = 'live' | 'capturing' | 'frozen';

/** Past this the panel opens with live glass: it must not feel slow to open. */
const FROZEN_GLASS_BUDGET_MS = 150;

interface Snapshot { canvas: HTMLCanvasElement; width: number; height: number }

function px(value: string, fallback: number): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

export function useFrozenGlass(
  panelRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
): { phase: GlassPhase; layer: React.ReactNode } {
  const [phase, setPhase] = React.useState<GlassPhase>(() => (
    enabled && typeof getElectron()?.captureBackdrop === 'function' ? 'capturing' : 'live'
  ));
  const [snapshot, setSnapshot] = React.useState<Snapshot | null>(null);

  React.useLayoutEffect(() => {
    if (phase !== 'capturing') return;
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
      setPhase('live');
      return;
    }
    let done = false;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const budget = window.setTimeout(() => { if (!done) { done = true; setPhase('live'); } }, FROZEN_GLASS_BUDGET_MS);
    void (async () => {
      // Nothing of the modal is drawn yet: the window is still the page.
      const url = await capture({ x: 0, y: 0, width, height }).catch(() => null);
      if (done) return;
      const canvas = url
        ? await blurSnapshot(url, {
            blurPx,
            saturate: style?.getPropertyValue('--term-glass-saturate').trim() || '160%',
            viewportWidth: width,
          }).catch(() => null)
        : null;
      if (done) return;
      done = true;
      window.clearTimeout(budget);
      if (!canvas || window.innerWidth !== width || window.innerHeight !== height) {
        setPhase('live');
        return;
      }
      setSnapshot({ canvas, width, height });
      setPhase('frozen');
    })();
    return () => {
      done = true;
      window.clearTimeout(budget);
    };
  }, [phase, panelRef]);

  // A resized window no longer matches the capture: go back to live glass.
  React.useEffect(() => {
    if (phase !== 'frozen' || !snapshot) return;
    const onResize = () => {
      if (window.innerWidth !== snapshot.width || window.innerHeight !== snapshot.height) {
        setSnapshot(null);
        setPhase('live');
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
