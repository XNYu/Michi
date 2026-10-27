import { describe, it, expect } from 'vitest';
import { EMPTY_SELECTION, applySelectionClick } from './selection';

const ORDER = ['a', 'b', 'c', 'd', 'e'];
const ids = (s: { selected: ReadonlySet<string> }) => Array.from(s.selected).sort();

describe('applySelectionClick', () => {
  it('toggles one card with the command key and anchors there', () => {
    const one = applySelectionClick(EMPTY_SELECTION, 'b', { toggle: true, range: false }, ORDER);
    expect(ids(one)).toEqual(['b']);
    expect(one.anchor).toBe('b');
    const two = applySelectionClick(one, 'd', { toggle: true, range: false }, ORDER);
    expect(ids(two)).toEqual(['b', 'd']);
    const back = applySelectionClick(two, 'b', { toggle: true, range: false }, ORDER);
    expect(ids(back)).toEqual(['d']);
  });

  it('selects the range from the anchor in view order with shift', () => {
    const start = applySelectionClick(EMPTY_SELECTION, 'b', { toggle: true, range: false }, ORDER);
    const range = applySelectionClick(start, 'd', { toggle: false, range: true }, ORDER);
    expect(ids(range)).toEqual(['b', 'c', 'd']);
    const backwards = applySelectionClick(start, 'a', { toggle: false, range: true }, ORDER);
    expect(ids(backwards)).toEqual(['a', 'b']);
  });

  it('treats a shift-click without an anchor as a single pick', () => {
    const range = applySelectionClick(EMPTY_SELECTION, 'c', { toggle: false, range: true }, ORDER);
    expect(ids(range)).toEqual(['c']);
    expect(range.anchor).toBe('c');
  });
});
