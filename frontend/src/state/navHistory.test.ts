import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { NavHistoryStore, useNavHistory, type NavEntry } from './navHistory';

const alive: () => true = () => true;
const e = (nodeId: string, projectId = 'p1', treeId = 't1'): NavEntry => ({ nodeId, projectId, treeId });

/** Feed a sequence of "focus landed here" observations into the store. */
function focus(store: NavHistoryStore, ...entries: NavEntry[]) {
  for (const entry of entries) store.record(entry);
}

describe('NavHistoryStore', () => {
  it('dedups consecutive identical locations', () => {
    const s = new NavHistoryStore();
    focus(s, e('A'), e('A'), e('A'), e('B'));
    // Only A→B should be a real transition.
    expect(s.back(alive)).toEqual(e('A'));
    s.record(e('A'));
    expect(s.canBack()).toBe(false);
  });

  it('skips dead entries on the way back like a closed tab', () => {
    const s = new NavHistoryStore();
    focus(s, e('A'), e('B'), e('C'), e('D'));
    // B and C are dead; back from D should land on A.
    const deadIds = new Set(['B', 'C']);
    const isLive = (x: NavEntry) => !deadIds.has(x.nodeId);
    expect(s.back(isLive)).toEqual(e('A'));
  });

  it('caps the back stack at 50 entries, dropping the oldest', () => {
    const s = new NavHistoryStore();
    for (let i = 0; i < 60; i += 1) s.record(e(`n${i}`));
    // current = n59; the 59 would-be back entries are capped to the newest 50.
    let steps = 0;
    while (s.back(alive)) { steps += 1; if (steps > 100) break; }
    expect(steps).toBe(50);
  });
});

describe('useNavHistory (React binding)', () => {
  it('exposes canBack/canForward reactively and survives a back→forward round-trip', () => {
    const { result } = renderHook(() => useNavHistory());
    expect(result.current.canBack).toBe(false);
    expect(result.current.canForward).toBe(false);

    act(() => { result.current.record(e('A')); });
    act(() => { result.current.record(e('B')); });
    expect(result.current.canBack).toBe(true);
    expect(result.current.canForward).toBe(false);

    let target: NavEntry | null = null;
    act(() => { target = result.current.back(alive); });
    expect(target).toEqual(e('A'));
    // The focus change the back triggered lands on A — suppressed, no re-push.
    act(() => { result.current.record(e('A')); });
    expect(result.current.canBack).toBe(false);
    expect(result.current.canForward).toBe(true);

    act(() => { target = result.current.forward(alive); });
    expect(target).toEqual(e('B'));
    act(() => { result.current.record(e('B')); });
    expect(result.current.canForward).toBe(false);
    expect(result.current.canBack).toBe(true);
  });
});
