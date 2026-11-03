import { describe, expect, it } from 'vitest';
import { PANE_EASE, PANE_ENTER_MS, PANE_EXIT_MS } from '../components/terminal/paneMotion';
import { DUR, EASE } from './tokens';
import { isFresh } from './useFresh';

function bezier(value: string): number[] {
  const inner = value.match(/cubic-bezier\(([^)]+)\)/)?.[1];
  if (!inner) throw new Error(`not a cubic-bezier: ${value}`);
  return inner.split(',').map((n) => Number(n.trim()));
}

// tokens.css.test.js checks these against the --t-* tokens in index.css.
describe('motion tokens', () => {
  it('share the pane curve', () => {
    expect(EASE.drawer).toEqual(bezier(PANE_EASE));
  });

  it('keep exits shorter than entrances, like pane motion', () => {
    expect(PANE_EXIT_MS).toBeLessThan(PANE_ENTER_MS);
    expect(DUR.exit).toBeLessThan(DUR.enter);
    expect(DUR.collapse).toBeLessThan(DUR.expand);
    // A scrim clears inside the collapse of the panel it dims.
    expect(DUR.scrimExit).toBeLessThan(DUR.collapse);
  });
});

describe('isFresh', () => {
  it('only counts items created within the window', () => {
    expect(isFresh(1_000, 1_500)).toBe(true);
    expect(isFresh(1_000, 2_000)).toBe(false);
    expect(isFresh(undefined, 1_000)).toBe(false);
    expect(isFresh(2_000, 1_000)).toBe(false);
  });
});
