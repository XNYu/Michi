import { prefersReducedMotion } from '../../hooks/useReducedMotion';
import type { ProjectEdge } from '../../state/chatTypes';
import { PANE_EASE } from './paneMotion';

/**
 * How a new branch arrives on a phone, which shows one pane at a time.
 *
 * Opening one pushes it in over its parent, so the parent is still there to
 * go back to. Starting one in the background leaves the screen as it was, so
 * a chip carries it from the tap to the pane switcher, where it now lives.
 * Reopening an existing pane stays instant: that is ordinary navigation.
 */

const PUSH_MS = 280;
const REDUCED_PUSH_MS = 150;
const PARENT_DRIFT = '24%';
const PARENT_DIM = 0.72;
const FLIGHT_MS = 360;
const FLIGHT_EASE = 'cubic-bezier(0.77, 0, 0.175, 1)';
const PULSE_MS = 420;
const RING_MS = 520;
/** Long enough for the commit that adds the edge; hydrated edges are older. */
const FRESH_MS = 1000;

export interface BranchFlightOrigin { x: number; y: number }

export function isFreshBranch(edges: readonly ProjectEdge[] | undefined, nodeId: string, now = Date.now()): boolean {
  return !!edges?.some(edge => edge.target === nodeId && (edge.kind ?? 'branch') === 'branch'
    && edge.createdAt !== undefined && now - edge.createdAt < FRESH_MS);
}

export function branchMotionAllowed(): boolean {
  return typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';
}

export function branchMotionReduced(): boolean {
  return prefersReducedMotion(document.documentElement.dataset.reduceMotion === 'on');
}

/**
 * Runs after the strip has scrolled to `incoming`, so `outgoing` is off screen
 * and hidden. Its animation holds it visible and in view until it is covered;
 * finishing or cancelling hands visibility and position back to React.
 */
export function playBranchPush(incoming: HTMLElement, outgoing: HTMLElement, title: Element | null | undefined): () => void {
  if (!branchMotionAllowed()) return () => {};
  if (branchMotionReduced()) {
    const fade = incoming.animate([{ opacity: 0 }, { opacity: 1 }], { duration: REDUCED_PUSH_MS, easing: 'ease' });
    return () => fade.cancel();
  }
  const timing = { duration: PUSH_MS, easing: PANE_EASE };
  const distance = incoming.offsetLeft - outgoing.offsetLeft;
  const shadow = 'var(--term-float-shadow)';
  const running = [
    incoming.animate([
      { transform: 'translateX(100%)', boxShadow: shadow },
      { transform: 'translateX(0)', boxShadow: shadow },
    ], timing),
    outgoing.animate([
      { transform: `translateX(${distance}px)`, opacity: 1, visibility: 'visible' },
      { transform: `translateX(calc(${distance}px - ${PARENT_DRIFT}))`, opacity: PARENT_DIM, visibility: 'visible' },
    ], timing),
  ];
  if (title) {
    running.push(title.animate([
      { transform: 'translateX(16px)', opacity: 0 },
      { transform: 'translateX(0)', opacity: 1 },
    ], timing));
  }
  return () => { for (const animation of running) animation.cancel(); };
}

/** The switcher acknowledging what just landed in it. */
export function pulseBranchTarget(target: HTMLElement): void {
  if (!branchMotionAllowed()) return;
  const accent = 'var(--term-accent)';
  if (branchMotionReduced()) {
    target.animate([{ color: accent }, { color: accent }], { duration: PULSE_MS });
    return;
  }
  // Swells, overshoots back and settles; the accent holds until it has settled.
  target.animate([
    { transform: 'scale(1)', easing: 'ease-out' },
    { transform: 'scale(1.4)', color: accent, offset: 0.3, easing: 'ease-in-out' },
    { transform: 'scale(0.92)', color: accent, offset: 0.65, easing: 'ease-out' },
    { transform: 'scale(1)' },
  ], { duration: PULSE_MS });
  // The ring (mobile.css) carries the landing past the button's own bounds.
  target.animate([
    { transform: 'scale(0.7)', opacity: 0.8 },
    { transform: 'scale(1.7)', opacity: 0 },
  ], { duration: RING_MS, easing: 'ease-out', pseudoElement: '::after' });
}

export function playBranchFlight(chip: HTMLElement, target: HTMLElement, from: BranchFlightOrigin, onDone: () => void): () => void {
  const box = target.getBoundingClientRect();
  const to = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  const place = ({ x, y }: BranchFlightOrigin, scale: number) => `translate(${x}px, ${y}px) scale(${scale})`;
  const flight = chip.animate([
    { transform: place(from, 0.8), opacity: 0, easing: 'ease-out' },
    { transform: place(from, 1), opacity: 1, offset: 0.2, easing: FLIGHT_EASE },
    { transform: place(to, 0.5), opacity: 0.85 },
  ], { duration: FLIGHT_MS, fill: 'both' });
  flight.onfinish = () => { pulseBranchTarget(target); onDone(); };
  return () => { flight.onfinish = null; flight.cancel(); };
}
