import { describe, expect, it } from 'vitest';
import { blockRevealTracker } from './HomeDocument';

const page = (id: string, ...blocks: string[]) => ({ id, blocks: blocks.map((block) => ({ id: block })) }) as never;

describe('blockRevealTracker', () => {
  it('reveals only blocks that arrive after the home has settled on screen', () => {
    const tracker = blockRevealTracker(1000, 600);
    // The home opens with the Meta agent still writing: no blocks yet.
    expect(tracker.claim(page('home'), [], true, 0)).toEqual([]);
    // It writes them while the person watches.
    expect(tracker.claim(page('home', 'a', 'b'), ['a', 'b'], true, 5000)).toEqual(['a', 'b']);
    // Once seen, a block stays settled.
    expect(tracker.claim(page('home', 'a', 'b'), ['a', 'b'], true, 6000)).toEqual([]);
  });

  it('opens an already-written home settled, however late its own copy arrives', () => {
    const tracker = blockRevealTracker(1000, 600);
    // The home endpoint's copy first, then a remote backend takes three seconds for the page's own.
    expect(tracker.claim(page('home', 'a'), ['a'], false, 0)).toEqual([]);
    expect(tracker.claim(page('home', 'a', 'b'), ['a', 'b'], false, 200)).toEqual([]);
    // Live at last: this look starts the quiet window; what it brings is the page loading.
    expect(tracker.claim(page('home', 'a', 'b', 'c'), ['a', 'b', 'c'], true, 3000)).toEqual([]);
    expect(tracker.claim(page('home', 'a', 'b', 'c', 'x'), ['x'], true, 3500)).toEqual([]);
    expect(tracker.claim(page('home', 'a', 'b', 'c', 'x', 'd'), ['d'], true, 4500)).toEqual(['d']);
    // Stale again (offline): nothing rises in.
    expect(tracker.claim(page('home', 'a', 'b', 'c', 'x', 'd', 'e'), ['e'], false, 9000)).toEqual([]);
  });

  it('starts over, settled, on another page', () => {
    const tracker = blockRevealTracker(1000, 600);
    tracker.claim(page('one', 'a'), ['a'], true, 0);
    expect(tracker.claim(page('two', 'x', 'y'), ['x', 'y'], true, 5000)).toEqual([]);
    expect(tracker.claim(page('two', 'x', 'y'), ['x', 'y'], true, 9000)).toEqual([]);
  });

  it('leaves the blocks the person adds, however long the save takes', () => {
    const tracker = blockRevealTracker(1000, 600);
    tracker.claim(page('home', 'a'), ['a'], true, 0);
    const ended = tracker.ownEdit();
    // Drawn before it is saved, and the save takes three seconds.
    expect(tracker.claim(page('home', 'a', 'b'), ['a', 'b'], true, 5000)).toEqual([]);
    expect(tracker.claim(page('home', 'a', 'b', 'c'), ['c'], true, 7900)).toEqual([]);
    ended(8000);
    // Just after: still the person's (the saved page coming back).
    expect(tracker.claim(page('home', 'a', 'b', 'c', 'd'), ['d'], true, 8300)).toEqual([]);
    // Later, a block the Meta agent writes rises in again.
    expect(tracker.claim(page('home', 'a', 'b', 'c', 'd', 'e'), ['e'], true, 9000)).toEqual(['e']);
  });
});
