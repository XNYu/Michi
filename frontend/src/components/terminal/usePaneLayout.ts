import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { resolvePaneLayout, type PaneWidthMode } from '../../state/paneLayout';
import { PANE_ENTER_MS, PANE_EXIT_MS, PANE_EASE, paneMotionTiming, type PaneMotion } from './paneMotion';

const NO_EXITS: ReadonlySet<string> = new Set();
type Clip = { left: number; right: number };
const unclipped: Clip = { left: 0, right: 0 };
const inset = (clip: Clip) => `inset(0px ${clip.right}px 0px ${clip.left}px)`;
const singlePaneTiming = paneMotionTiming('soft-fade');

interface Options {
  paneIds: readonly string[];
  customWidths: readonly (number | undefined)[];
  mode?: PaneWidthMode;
  defaultPaneWidth: number;
  enabled: boolean;
  scope: string;
  exitingIds?: ReadonlySet<string>;
  motion?: PaneMotion;
  /** App-level reduce-motion pref (combines with OS media query). */
  appReduceMotion?: boolean;
  onExitStart?: (ids: readonly string[]) => void;
  onExitComplete?: (id: string) => void;
}

/** Final text widths are committed once; only the pane surfaces move. */
export function usePaneLayout(ref: RefObject<HTMLDivElement>, options: Options) {
  const { paneIds, customWidths, mode = 'adaptive', defaultPaneWidth, enabled, scope, exitingIds = NO_EXITS, motion, appReduceMotion, onExitStart, onExitComplete } = options;
  const [geometry, setGeometry] = useState({ width: 0, gap: 0, padding: 0 });
  const [settledVersion, setSettledVersion] = useState(0);
  const animationRef = useRef<Animation | null>(null);
  const animations = useRef(new Map<string, { animation: Animation; from: Clip; to: Clip }>());
  const previous = useRef<{
    ids: readonly string[]; activeIds: readonly string[]; widths: number[]; positions: number[]; scrollExtent: number; mode: PaneWidthMode;
    geometry: typeof geometry; defaultPaneWidth: number; scope: string; exits: readonly string[]; waitingForExit: boolean;
  } | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    const measure = () => {
      const style = getComputedStyle(element);
      const next = {
        width: element.clientWidth,
        gap: parseFloat(style.getPropertyValue('--term-dashboard-gap')) || 0,
        padding: parseFloat(style.getPropertyValue('--term-dashboard-padding')) || 0,
      };
      setGeometry(current => current.width === next.width && current.gap === next.gap && current.padding === next.padding ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, ref]);

  const layout = useMemo(() => {
    const activeIds = paneIds.filter(id => !exitingIds.has(id));
    const prev = previous.current?.scope === scope ? previous.current : null;
    // Keep both tracks, including the survivor's text width, until exit finishes.
    const waitingForExit = activeIds.length === 1 && exitingIds.size > 0 && !!prev;
    const active = resolvePaneLayout({
      viewportWidth: geometry.width, gap: geometry.gap, padding: geometry.padding,
      paneCount: waitingForExit ? paneIds.length : activeIds.length,
      customWidths: waitingForExit ? paneIds.map(id => prev.widths[prev.ids.indexOf(id)])
        : customWidths.filter((_, i) => !exitingIds.has(paneIds[i])), mode, defaultPaneWidth,
    });
    let index = 0;
    let left = geometry.padding;
    const positions: number[] = [];
    const paneStyles: CSSProperties[] = [];
    const widths = paneIds.map(id => {
      if (exitingIds.has(id) && !waitingForExit) {
        const oldIndex = prev?.ids.indexOf(id) ?? -1;
        const width = oldIndex >= 0 ? prev!.widths[oldIndex] : 0;
        const position = oldIndex >= 0 ? prev!.positions[oldIndex] : left;
        positions.push(position);
        // Keep the real content mounted at its original width, outside the
        // grid. Removing this visual later must not cause another layout phase.
        paneStyles.push({ position: 'absolute', left: position, width, top: geometry.padding, bottom: geometry.padding, zIndex: 0 });
        return width;
      }
      const width = active.widths[index++];
      positions.push(left);
      paneStyles.push({ gridColumn: index, gridRow: 1, ...(exitingIds.size ? { position: 'relative', zIndex: 1 } : {}) });
      left += width + geometry.gap;
      return width;
    });
    const contentWidth = active.widths.reduce((sum, width) => sum + width, 0)
      + Math.max(0, active.widths.length - 1) * geometry.gap;
    const finalExtent = geometry.padding + contentWidth + active.paddingRight;
    const scrollExtent = exitingIds.size ? Math.max(finalExtent, prev?.scrollExtent ?? 0) : finalExtent;
    return { ...active, widths, positions, paneStyles, activeIds, contentWidth, scrollExtent, waitingForExit };
  }, [geometry, paneIds, customWidths, exitingIds, mode, defaultPaneWidth, scope]);

  useLayoutEffect(() => {
    const element = ref.current;
    const cancel = () => {
      for (const { animation } of animations.current.values()) animation.cancel();
      animations.current.clear();
      animationRef.current = null;
    };
    if (!element || !enabled) {
      cancel();
      previous.current = null;
      return;
    }
    const prev = previous.current;
    if (prev && prev.scope === scope && prev.mode === mode && prev.geometry === geometry
      && prev.defaultPaneWidth === defaultPaneWidth && prev.ids.length === paneIds.length
      && prev.ids.every((id, i) => id === paneIds[i] && prev.widths[i] === layout.widths[i])
      && prev.exits.length === exitingIds.size && prev.exits.every(id => exitingIds.has(id))) return;
    const next = { ids: [...paneIds], activeIds: layout.activeIds, widths: layout.widths, positions: layout.positions, scrollExtent: layout.scrollExtent, mode, geometry, defaultPaneWidth, scope, exits: [...exitingIds], waitingForExit: layout.waitingForExit };
    const sameActiveLayout = prev && prev.scope === scope && prev.mode === mode && prev.geometry === geometry
      && prev.defaultPaneWidth === defaultPaneWidth && prev.activeIds.length === layout.activeIds.length
      && prev.activeIds.every((id, i) => id === layout.activeIds[i]
        && prev.widths[prev.ids.indexOf(id)] === layout.widths[paneIds.indexOf(id)]);
    // Exit cleanup is purely unmounting; don't restart the survivors' motion.
    if (sameActiveLayout && !prev.waitingForExit && paneIds.every(id => prev.ids.includes(id))
      && [...exitingIds].every(id => prev.exits.includes(id))) {
      previous.current = next;
      for (const [id, { animation }] of animations.current) {
        if (!paneIds.includes(id)) { animation.cancel(); animations.current.delete(id); }
      }
      if (animationRef.current && ![...animations.current.values()].some(({ animation }) => animation === animationRef.current)) {
        animationRef.current = animations.current.values().next().value?.animation ?? null;
        if (!animationRef.current) setSettledVersion(version => version + 1);
      }
      return;
    }
    const children = Array.from(element.children).filter((child): child is HTMLElement =>
      child instanceof HTMLElement && (child.hasAttribute('data-node-id') || child.hasAttribute('data-pane-caption-id')));
    // React has already committed the new tracks. Reconstruct the old visual
    // coordinates from the last layout and sample transforms before any writes.
    const sampled = new Map(children.map(child => {
      const id = child.dataset.nodeId ?? child.dataset.paneCaptionId!;
      const running = animations.current.get(id);
      const transform = running ? getComputedStyle(child).transform : 'none';
      const progress = running?.animation.effect?.getComputedTiming().progress ?? 0;
      const clip = running ? {
        left: running.from.left + (running.to.left - running.from.left) * progress,
        right: running.from.right + (running.to.right - running.from.right) * progress,
      } : unclipped;
      return [id, { x: transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m41, clip,
        opacity: running ? getComputedStyle(child).opacity || '1' : '1' }];
    }));
    const wasAnimating = !!animationRef.current;
    cancel();
    previous.current = next;
    const changedPanes = prev && (prev.ids.length !== paneIds.length || prev.ids.some((id, i) => id !== paneIds[i]));
    const changedExits = prev && (prev.exits.length !== exitingIds.size || prev.exits.some(id => !exitingIds.has(id)));
    const canAnimate = prev && prev.scope === scope && prev.geometry === geometry && geometry.width > 0
      && prev.defaultPaneWidth === defaultPaneWidth && (changedPanes || prev.mode !== mode || changedExits)
      && children.length > 0 && typeof children[0].animate === 'function'
      && !appReduceMotion && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!canAnimate) {
      if (wasAnimating) setSettledVersion(version => version + 1);
      for (const id of exitingIds) onExitComplete?.(id);
      return;
    }
    onExitStart?.([...exitingIds]);
    const oldPositions = new Map(prev.ids.map((id, i) => {
      return [id, prev.positions[i] + (sampled.get(id)?.x ?? 0)];
    }));
    let previousRight = geometry.padding;
    const expandingSingle = prev.waitingForExit && !layout.waitingForExit && layout.activeIds.length === 1;
    const closing = prev.activeIds.some(id => !layout.activeIds.includes(id));
    for (const [i, child] of children.entries()) {
      const id = child.dataset.nodeId ?? child.dataset.paneCaptionId!;
      const finalLeft = layout.positions[i];
      const width = layout.widths[i];
      const exiting = exitingIds.has(id);
      if (layout.waitingForExit && !exiting) continue;
      const start = exiting ? (oldPositions.get(id) ?? finalLeft)
        : Math.max(previousRight, oldPositions.get(id) ?? finalLeft);
      const delta = start - finalLeft;
      let from = sampled.get(id)?.clip ?? unclipped;
      let to = unclipped;
      if (exiting && !layout.waitingForExit) {
        const before = paneIds.slice(0, i).reverse().find(candidate => !exitingIds.has(candidate));
        const after = paneIds.slice(i + 1).find(candidate => !exitingIds.has(candidate));
        const beforeIndex = before ? paneIds.indexOf(before) : -1;
        const afterIndex = after ? paneIds.indexOf(after) : -1;
        // Clip only the portion being covered by the moving neighbours. Text
        // keeps its width, with no overlapping glyphs or per-frame reflow.
        to = {
          left: beforeIndex < 0 ? 0 : Math.max(0, layout.positions[beforeIndex] + layout.widths[beforeIndex] - finalLeft),
          right: afterIndex < 0 ? 0 : Math.max(0, finalLeft + width - layout.positions[afterIndex]),
        };
        // The trailing centering gutter can still expose a slice of the last
        // pane. Its whole wrapper (including border/background) must be hidden
        // at the shared endpoint, not only the portion covered by a neighbour.
        if (!after) to.right = Math.max(to.right, width - to.left);
      } else {
        const oldIndex = prev.ids.indexOf(id);
        if ((exitingIds.size || expandingSingle) && oldIndex >= 0) {
          from = { left: from.left, right: Math.max(from.right, width - prev.widths[oldIndex]) };
        }
        previousRight = start + width - from.right + geometry.gap;
      }
      const clipping = from.left !== 0 || from.right !== 0 || to.left !== 0 || to.right !== 0;
      const opacity = sampled.get(id)?.opacity ?? '1';
      const fading = layout.waitingForExit || opacity !== '1';
      if (!clipping && !fading && Math.abs(delta) <= 0.5 && animationRef.current) continue;
      const animation = child.animate(
        [{ transform: `translateX(${delta}px)`, ...(clipping ? { clipPath: inset(from) } : {}), ...(fading ? { opacity } : {}) },
          { transform: layout.waitingForExit ? `translateX(${delta}px)` : 'translateX(0px)',
            ...(clipping ? { clipPath: inset(to) } : {}), ...(fading ? { opacity: layout.waitingForExit ? '0' : '1' } : {}) }],
        { duration: layout.waitingForExit ? singlePaneTiming.exit : expandingSingle ? singlePaneTiming.exitLayout
          : closing ? PANE_EXIT_MS : PANE_ENTER_MS, easing: PANE_EASE, fill: 'both' },
      );
      animations.current.set(id, { animation, from, to });
      // Even a stationary pane supplies the reveal clock when all tracks grow.
      animationRef.current ??= animation;
      animation.onfinish = () => {
        // Let reveal's finish listener write its endpoint before cancelling.
        queueMicrotask(() => {
          if (animations.current.get(id)?.animation !== animation) return;
          if (animationRef.current === animation) {
            for (const exitingId of exitingIds) onExitComplete?.(exitingId);
          }
          if (exiting) return;
          animation.cancel();
          animations.current.delete(id);
          if (animations.current.size === 0) {
            animationRef.current = null;
            setSettledVersion(version => version + 1);
          }
        });
      };
    }
  }, [ref, enabled, paneIds, layout, mode, geometry, defaultPaneWidth, scope, exitingIds, motion, onExitStart, onExitComplete]);

  useLayoutEffect(() => {
    const running = animations.current;
    return () => { for (const { animation } of running.values()) animation.cancel(); running.clear(); };
  }, []);

  return { ...layout, ready: geometry.width > 0, padding: geometry.padding, gap: geometry.gap, animationRef, settledVersion };
}
