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
  it('records a chain and steps back through it', () => {
    const s = new NavHistoryStore();
    focus(s, e('A'), e('B'), e('C'));
    expect(s.canBack()).toBe(true);
    expect(s.canForward()).toBe(false);

    // Back from C → B. navigateToNode would then focus B; simulate that landing.
    expect(s.back(alive)).toEqual(e('B'));
    s.record(e('B')); // suppressed landing, no stack change
    expect(s.canForward()).toBe(true);

    expect(s.back(alive)).toEqual(e('A'));
    s.record(e('A'));
    expect(s.canBack()).toBe(false);
    expect(s.canForward()).toBe(true);
  });

  it('steps forward after going back', () => {
    const s = new NavHistoryStore();
    focus(s, e('A'), e('B'), e('C'));
    s.back(alive); s.record(e('B'));
    s.back(alive); s.record(e('A'));

    expect(s.forward(alive)).toEqual(e('B'));
    s.record(e('B'));
    expect(s.forward(alive)).toEqual(e('C'));
    s.record(e('C'));
    expect(s.canForward()).toBe(false);
  });

  it('clears the forward stack when a new location is visited', () => {
    const s = new NavHistoryStore();
    focus(s, e('A'), e('B'), e('C'));
    s.back(alive); s.record(e('B')); // forward now holds [C]
    expect(s.canForward()).toBe(true);

    focus(s, e('D')); // new navigation while on B
    expect(s.canForward()).toBe(false);
    expect(s.back(alive)).toEqual(e('B'));
  });

  it('dedups consecutive identical locations', () => {
    const s = new NavHistoryStore();
    focus(s, e('A'), e('A'), e('A'), e('B'));
    // Only A→B should be a real transition.
    expect(s.back(alive)).toEqual(e('A'));
    s.record(e('A'));
    expect(s.canBack()).toBe(false);
  });

  it('suppresses the focus change that a back/forward itself triggers', () => {
    const s = new NavHistoryStore();
    focus(s, e('A'), e('B'));
    const target = s.back(alive); // → A, arms suppression on A's nodeId
    expect(target).toEqual(e('A'));
    // Intermediate render during a cross-workspace transition (not the target):
    s.record(e('X', 'p2', 't2'));
    expect(s.canBack()).toBe(false); // ignored, suppression still armed
    // The real landing on A clears suppression without re-pushing B.
    s.record(e('A'));
    expect(s.canBack()).toBe(false);
    expect(s.canForward()).toBe(true); // B is still ahead
  });

  it('skips dead entries on the way back like a closed tab', () => {
    const s = new NavHistoryStore();
    focus(s, e('A'), e('B'), e('C'), e('D'));
    // B and C are dead; back from D should land on A.
    const deadIds = new Set(['B', 'C']);
    const isLive = (x: NavEntry) => !deadIds.has(x.nodeId);
    expect(s.back(isLive)).toEqual(e('A'));
  });

  it('returns null and stays put when there is nowhere live to go', () => {
    const s = new NavHistoryStore();
    focus(s, e('A'), e('B'));
    const isLive = (x: NavEntry) => x.nodeId !== 'A';
    expect(s.back(isLive)).toBeNull(); // only A behind, and A is dead
    expect(s.canForward()).toBe(false); // current B was never pushed forward
  });

  it('prune drops dead entries from both stacks', () => {
    const s = new NavHistoryStore();
    focus(s, e('A'), e('B'), e('C'));
    s.back(alive); s.record(e('B')); // back=[A], forward=[C]
    const isLive = (x: NavEntry) => x.nodeId !== 'A' && x.nodeId !== 'C';
    expect(s.prune(isLive)).toBe(true);
    expect(s.canBack()).toBe(false);
    expect(s.canForward()).toBe(false);
    expect(s.prune(isLive)).toBe(false); // idempotent
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
