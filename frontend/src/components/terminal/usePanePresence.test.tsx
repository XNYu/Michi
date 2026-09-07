import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePanePresence } from './usePanePresence';
import type { PaneItem } from '../../state/paneItems';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function harness(initialIds = ['a', 'b']) {
  const item = { id: 'b', kind: 'launcher', title: 'New pane', projectId: 'p', treeId: 'tree', createdAt: 1 } as PaneItem;
  return renderHook(({ ids, items, scope }) => usePanePresence(ids, items, scope), {
    initialProps: { ids: initialIds, items: { b: item } as Record<string, PaneItem>, scope: 'tree' },
  });
}

describe('pane presence', () => {
  it('lets a held animation own removal even after the fallback deadline', () => {
    const { result, rerender } = harness();
    rerender({ ids: ['a'], items: {}, scope: 'tree' });
    act(() => result.current.holdExits(['b']));
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.paneIds).toEqual(['a', 'b']);
    act(() => result.current.finishExit('b'));
    expect(result.current.paneIds).toEqual(['a']);
  });

  it('does not hold a reopened pane or an unrelated exit', () => {
    const { result, rerender } = harness(['a', 'b', 'c']);
    rerender({ ids: ['a', 'c'], items: {}, scope: 'tree' });
    act(() => result.current.holdExits(['b']));
    rerender({ ids: ['a', 'b'], items: {}, scope: 'tree' });
    act(() => result.current.holdExits(['b']));
    act(() => vi.advanceTimersByTime(192));
    expect(result.current.paneIds).toEqual(['a', 'b']);
  });
  it('releases a finished exit immediately but ignores an old completion after reopen', () => {
    const { result, rerender } = harness();
    rerender({ ids: ['a'], items: {}, scope: 'tree' });
    act(() => result.current.finishExit('b'));
    expect(result.current.paneIds).toEqual(['a']);
    rerender({ ids: ['a', 'b'], items: {}, scope: 'tree' });
    act(() => result.current.finishExit('b'));
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.paneIds).toEqual(['a', 'b']);
  });
  it('retains a soft fade through its fade and subsequent layout phase', () => {
    const { result, rerender } = renderHook(({ ids }) => usePanePresence(ids, {}, 'tree', true, 290), {
      initialProps: { ids: ['a', 'b'] },
    });
    rerender({ ids: ['a'] });
    act(() => vi.advanceTimersByTime(192));
    expect(result.current.paneIds).toEqual(['a', 'b']);
    act(() => vi.advanceTimersByTime(130));
    expect(result.current.paneIds).toEqual(['a']);
  });
  it('retains the closing slot and its item props only until the exit completes', () => {
    const { result, rerender } = harness();
    rerender({ ids: ['a'], items: {}, scope: 'tree' });
    expect(result.current.paneIds).toEqual(['a', 'b']);
    expect(result.current.exitingIds).toEqual(new Set(['b']));
    expect(result.current.paneItems.b.kind).toBe('launcher');
    act(() => vi.advanceTimersByTime(192));
    expect(result.current.paneIds).toEqual(['a']);
    expect(result.current.paneItems.b).toBeUndefined();
  });

  it('cancels exit if the same branch reopens before the deadline', () => {
    const { result, rerender } = harness();
    rerender({ ids: ['a'], items: {}, scope: 'tree' });
    act(() => vi.advanceTimersByTime(80));
    rerender({ ids: ['a', 'b'], items: {}, scope: 'tree' });
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.paneIds).toEqual(['a', 'b']);
    expect(result.current.exitingIds.size).toBe(0);
  });

  it('preserves the positions of multiple closing slots without extending earlier deadlines', () => {
    const { result, rerender } = harness(['a', 'b', 'c', 'd']);
    rerender({ ids: ['a', 'c', 'd'], items: {}, scope: 'tree' });
    act(() => vi.advanceTimersByTime(80));
    rerender({ ids: ['a', 'd'], items: {}, scope: 'tree' });
    expect(result.current.paneIds).toEqual(['a', 'b', 'c', 'd']);
    act(() => vi.advanceTimersByTime(112));
    expect(result.current.paneIds).toEqual(['a', 'c', 'd']);
    act(() => vi.advanceTimersByTime(80));
    expect(result.current.paneIds).toEqual(['a', 'd']);
  });

  it('does not carry exiting panes into another tree', () => {
    const { result, rerender } = harness();
    rerender({ ids: ['a'], items: {}, scope: 'tree' });
    rerender({ ids: ['other'], items: {}, scope: 'other-tree' });
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.paneIds).toEqual(['other']);
    expect(result.current.exitingIds.size).toBe(0);
  });

  it('skips retained exits with reduced motion', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    const { result, rerender } = harness();
    rerender({ ids: [], items: {}, scope: 'tree' });
    expect(result.current.paneIds).toEqual([]);
    expect(result.current.exitingIds.size).toBe(0);
  });
});
