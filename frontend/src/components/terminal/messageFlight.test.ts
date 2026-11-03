import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FLIGHT_MS,
  claimFlight,
  launchFlight,
  markRestored,
  playFlight,
  registerQueuedSource,
  wasRestored,
} from './messageFlight';

function pane(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'terminal-pane';
  document.body.appendChild(el);
  return el;
}

/** Each test gets its own surface, so flight state never carries over. */
let surface: HTMLElement;

function box(left: number, top: number, parent: Element = surface): HTMLElement {
  const el = document.createElement('div');
  parent.appendChild(el);
  el.getBoundingClientRect = () => ({ left, top, width: 200, height: 30, right: left + 200, bottom: top + 30, x: left, y: top, toJSON() {} }) as DOMRect;
  return el;
}

describe('messageFlight', () => {
  beforeEach(() => {
    surface = pane();
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('hands a launched source to the next fresh bubble of that conversation, once', () => {
    launchFlight('n1', box(10, 500), 1_000);
    expect(claimFlight(surface, 'n2', 'u-other', undefined, 1_010)).toBeUndefined();
    const rect = claimFlight(surface, 'n1', 'u-a', undefined, 1_010);
    expect(rect?.top).toBe(500);
    // Re-renders (StrictMode, later chunks) get the same answer…
    expect(claimFlight(surface, 'n1', 'u-a', undefined, 1_020)?.top).toBe(500);
    // …and nothing is left for another bubble.
    expect(claimFlight(surface, 'n1', 'u-b', undefined, 1_020)).toBeUndefined();
  });

  it('a claim is spent after FLIGHT_MS: a later mount of the message does not fly again', () => {
    const block = box(20, 600);
    registerQueuedSource('n1', 'q1', block);
    expect(claimFlight(surface, 'n1', 'steer-1', 'q1', 1_000)?.top).toBe(600);
    expect(claimFlight(surface, 'n1', 'steer-1', 'q1', 1_000 + FLIGHT_MS)).toBeUndefined();
  });

  it('drops a launch nobody claimed in time (a send that never happened)', () => {
    launchFlight('n1', box(10, 500), 1_000);
    expect(claimFlight(surface, 'n1', 'u-late', undefined, 1_000 + FLIGHT_MS)).toBeUndefined();
  });

  it('the newest launch wins and clears the older ones (a queued command made no bubble)', () => {
    launchFlight('n1', box(10, 400), 1_000);
    launchFlight('n1', box(10, 500), 1_100);
    expect(claimFlight(surface, 'n1', 'u-a', undefined, 1_200)?.top).toBe(500);
    expect(claimFlight(surface, 'n1', 'u-b', undefined, 1_200)).toBeUndefined();
  });

  it('ignores sources that are not on screen', () => {
    const detached = document.createElement('div');
    launchFlight('n1', detached, 1_000);
    launchFlight('n1', undefined, 1_000);
    expect(claimFlight(surface, 'n1', 'u-a', undefined, 1_001)).toBeUndefined();
    // No surface yet (the list's first render): no flight, nothing spent.
    launchFlight('n1', box(10, 500), 1_000);
    expect(claimFlight(null, 'n1', 'u-b', undefined, 1_001)).toBeUndefined();
    expect(claimFlight(surface, 'n1', 'u-b', undefined, 1_002)?.top).toBe(500);
  });

  it('links a steered message to its queued block exactly', () => {
    const block = box(20, 600);
    const unregister = registerQueuedSource('n1', 'q1', block);
    launchFlight('n1', box(10, 500), 1_000);
    // The queue id wins over the launch order.
    expect(claimFlight(surface, 'n1', 'steer-1', 'q1', 1_001)?.top).toBe(600);
    unregister();
    expect(claimFlight(surface, 'n1', 'steer-2', 'q1', 1_002)).toBeUndefined();
  });

  it('keeps each surface to itself (a grid pane and the ⌘J panel on one conversation)', () => {
    const grid = pane();
    const panel = pane();
    const gridBlock = box(20, 600, grid);
    const panelBlock = box(900, 300, panel);
    const unregisterGrid = registerQueuedSource('n1', 'q1', gridBlock);
    registerQueuedSource('n1', 'q1', panelBlock);
    // One surface unmounting its block leaves the other's registration.
    unregisterGrid();
    expect(claimFlight(grid, 'n1', 'steer', 'q1', 1_000)).toBeUndefined();
    expect(claimFlight(panel, 'n1', 'steer', 'q1', 1_000)?.left).toBe(900);

    // A follow-up picked in the panel does not fly the grid's bubble.
    launchFlight('n1', box(900, 700, panel), 2_000);
    expect(claimFlight(grid, 'n1', 'u-a', undefined, 2_001)).toBeUndefined();
    expect(claimFlight(panel, 'n1', 'u-a', undefined, 2_001)?.top).toBe(700);
  });

  it('remembers a restore (×) for every surface, briefly', () => {
    // The record is global (by node): this conversation is only used here.
    markRestored('n-restore', 'q1', 1_000);
    expect(wasRestored('n-restore', 'q1', 1_500)).toBe(true);
    expect(wasRestored('n-restore', 'q2', 1_500)).toBe(false);
    expect(wasRestored('n-restore', 'q1', 1_000 + FLIGHT_MS)).toBe(false);
  });

  describe('playFlight', () => {
    function bubbleInFrame() {
      const frame = document.createElement('div');
      frame.className = 'terminal-message-frame';
      document.body.appendChild(frame);
      const bubble = document.createElement('div');
      frame.appendChild(bubble);
      // Where the bubble lays out; any transform on it moves its box.
      bubble.getBoundingClientRect = () => {
        const m = /translateY\((-?[\d.]+)px\)/.exec(bubble.style.transform);
        const top = 100 + (m ? Number(m[1]) : 0);
        return { left: 40, top, width: 200, height: 30, right: 240, bottom: top + 30, x: 40, y: top, toJSON() {} } as DOMRect;
      };
      return { frame, bubble };
    }
    const from = { left: 40, top: 600, width: 200, height: 30 } as DOMRectReadOnly;

    it('lets the bubble paint outside its row while it flies, then puts everything back', () => {
      const { frame, bubble } = bubbleInFrame();
      const stop = playFlight(bubble, from, false);
      expect(frame.style.contentVisibility).toBe('visible');
      expect(bubble.style.transform).toBe('translateX(0px) translateY(500px)');
      stop();
      expect(frame.style.contentVisibility).toBe('');
      expect(bubble.style.transform).toBe('');
      expect(bubble.style.opacity).toBe('');
    });

    it('a StrictMode re-run measures the bubble’s own box, not the first run’s offset', () => {
      const { bubble } = bubbleInFrame();
      playFlight(bubble, from, false)();
      playFlight(bubble, from, false);
      expect(bubble.style.transform).toBe('translateX(0px) translateY(500px)');
    });

    it('reduced motion only fades', () => {
      const { bubble } = bubbleInFrame();
      playFlight(bubble, from, true);
      expect(bubble.style.transform).toBe('');
      expect(bubble.style.opacity).toBe('0');
    });
  });
});
