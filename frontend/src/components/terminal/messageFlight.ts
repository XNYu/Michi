import { animate } from 'motion/react';
import { SPRING } from '../../motion/tokens';

/**
 * A new user bubble that came from something on screen flies in from it:
 * a queued message the turn's end sends, a follow-up the user picked, a
 * queued message steered into the turn. One element moving from where the
 * text was to where it now lives, instead of one vanishing while another
 * fades in elsewhere.
 *
 * The source and the bubble usually land in different commits (the queue
 * drains in one, its send arrives on a later task; manual "restore to
 * composer" removes the same queue entry), so nothing in the store links
 * them. The source records the box the user saw when it starts leaving; the
 * next fresh user bubble in that conversation claims it within FLIGHT_MS.
 * A steered message is linked exactly (`ChatMessage.queueId`), through the
 * queued block still on screen in that commit.
 *
 * Everything is kept per surface (flightScope): the same conversation can be
 * open in a grid pane and the ⌘J panel at once, and a bubble only flies from
 * something in its own pane.
 *
 * A measured flight rather than a shared `layoutId`: a layoutId would stay
 * on the bubble for good and replay layout moves on later re-renders (font
 * size, density), and scoping it per pane needs a LayoutGroup above both the
 * transcript and the composer.
 */

/** A launch older than this went nowhere (a send that was refused); a claim older than this is spent. */
export const FLIGHT_MS = 1000;

/** The surface a flight stays within: the pane showing both the composer and the transcript. */
export function flightScope(el: Element | null | undefined): Element | null {
  if (!el) return null;
  return el.closest('.terminal-pane') ?? el.ownerDocument.documentElement;
}

interface Launch { rect: DOMRectReadOnly; at: number }
interface Claim { rect: DOMRectReadOnly | null; at: number }
interface ScopeState {
  /** Mounted queued blocks, by node and queue id: steer lookups. */
  sources: Map<string, HTMLElement>;
  /** Boxes of sources that started leaving, by node, newest last. */
  launches: Map<string, Launch[]>;
  /** By node and message key. Re-renders within FLIGHT_MS get the same box; later mounts get none. */
  claims: Map<string, Claim>;
}

/** Per surface element: a closed pane takes its flights with it. */
const scopes = new WeakMap<Element, ScopeState>();
/** Queue entries taken back into the composer (×): not sends, in whichever surface. */
const restored = new Map<string, number>();
const MAX_CLAIMS = 64;

const pairKey = (a: string, b: string) => `${a}\u0000${b}`;

function stateOf(scope: Element): ScopeState {
  let state = scopes.get(scope);
  if (!state) scopes.set(scope, (state = { sources: new Map(), launches: new Map(), claims: new Map() }));
  return state;
}

/** Ref callback body for a queued block, so a steered message can find it. Returns its cleanup. */
export function registerQueuedSource(nodeId: string, queueId: string, el: HTMLElement): () => void {
  const scope = flightScope(el);
  if (!scope) return () => {};
  const { sources } = stateOf(scope);
  const key = pairKey(nodeId, queueId);
  sources.set(key, el);
  return () => {
    if (sources.get(key) === el) sources.delete(key);
  };
}

/** The user took a queued entry back (×); every surface showing it sees it go. */
export function markRestored(nodeId: string, queueId: string, now = Date.now()): void {
  for (const [key, at] of restored) if (now - at >= FLIGHT_MS) restored.delete(key);
  restored.set(pairKey(nodeId, queueId), now);
}

export function wasRestored(nodeId: string, queueId: string, now = Date.now()): boolean {
  const at = restored.get(pairKey(nodeId, queueId));
  return at !== undefined && now - at < FLIGHT_MS;
}

/** A source starts leaving to become the next user bubble here. */
export function launchFlight(nodeId: string, el: Element | null | undefined, now = Date.now()): void {
  if (!el?.isConnected) return;
  const scope = flightScope(el);
  if (!scope) return;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  const { launches } = stateOf(scope);
  const list = (launches.get(nodeId) ?? []).filter((launch) => now - launch.at < FLIGHT_MS);
  list.push({ rect, at: now });
  launches.set(nodeId, list);
}

/**
 * The box a new user bubble flies in from, or undefined. `scopeEl` is any
 * element of the bubble's surface (none yet: no flight). Call only for a
 * fresh user message or one carrying `queueId`. The newest launch wins and
 * clears the rest: an older one belonged to a send that made no bubble (a
 * queued command) or was merged into this one.
 */
export function claimFlight(
  scopeEl: Element | null | undefined,
  nodeId: string,
  messageKey: string,
  queueId?: string,
  now = Date.now(),
): DOMRectReadOnly | undefined {
  const scope = flightScope(scopeEl);
  if (!scope) return undefined;
  const { sources, launches, claims } = stateOf(scope);
  const claimKey = pairKey(nodeId, messageKey);
  const cached = claims.get(claimKey);
  if (cached) return now - cached.at < FLIGHT_MS ? cached.rect ?? undefined : undefined;
  let rect: DOMRectReadOnly | null = null;
  if (queueId) {
    const el = sources.get(pairKey(nodeId, queueId));
    if (el?.isConnected) rect = el.getBoundingClientRect();
  } else {
    const list = (launches.get(nodeId) ?? []).filter((launch) => now - launch.at < FLIGHT_MS);
    rect = list[list.length - 1]?.rect ?? null;
    launches.delete(nodeId);
  }
  claims.set(claimKey, { rect, at: now });
  if (claims.size > MAX_CLAIMS) claims.delete(claims.keys().next().value!);
  return rect ?? undefined;
}

/**
 * Fly `target` from `from` to where it is (both viewport boxes), aligning
 * their top-left corners, with SPRING.soft; it fades in on the way. Position
 * only: scaling would stretch the text. Reduced motion keeps only the fade.
 * Returns the cleanup, which puts the bubble where it belongs.
 */
export function playFlight(target: HTMLElement, from: DOMRectReadOnly, reduce: boolean): () => void {
  // The row's content-visibility:auto implies paint containment, which would
  // clip the bubble while it is outside the row.
  const frame = target.closest<HTMLElement>('.terminal-message-frame');
  const frameVisibility = frame?.style.contentVisibility ?? '';
  if (frame) frame.style.contentVisibility = 'visible';
  // Measure the bubble's own box (a StrictMode re-run finds the first run's offset).
  target.style.transform = '';
  const to = target.getBoundingClientRect();
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  // Called from a layout effect: land the start pose before the first paint.
  target.style.opacity = '0';
  if (!reduce) target.style.transform = `translateX(${dx}px) translateY(${dy}px)`;

  // Written by hand: an element animation can write its last frame after it
  // completes, which would leave an inline transform behind on the bubble.
  let moving = !reduce;
  let fading = true;
  let done = false;
  const settle = () => {
    if (done) return;
    done = true;
    target.style.transform = '';
    target.style.opacity = '';
    if (frame) frame.style.contentVisibility = frameVisibility;
  };
  const settleIfIdle = () => {
    if (!moving && !fading) settle();
  };
  const fade = animate(0, 1, {
    duration: reduce ? 0.12 : 0.16,
    ease: 'linear',
    onUpdate: (o) => {
      if (!done) target.style.opacity = String(o);
    },
    onComplete: () => {
      fading = false;
      settleIfIdle();
    },
  });
  // One spring from 1 to 0 scaling both offsets; its rest thresholds kept in pixels.
  const distance = Math.max(Math.abs(dx), Math.abs(dy), 1);
  const move = reduce
    ? null
    : animate(1, 0, {
      ...SPRING.soft,
      restDelta: 0.5 / distance,
      restSpeed: 2 / distance,
      onUpdate: (p) => {
        if (!done) target.style.transform = `translateX(${dx * p}px) translateY(${dy * p}px)`;
      },
      onComplete: () => {
        moving = false;
        settleIfIdle();
      },
    });
  return () => {
    fade.stop();
    move?.stop();
    settle();
  };
}
