import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TreePrefetchContext, TREE_PREFETCH_INTENT_MS, useTreePrefetchIntent } from './treePrefetch';

function Target({ nodeId }: { nodeId: string }) {
  const intent = useTreePrefetchIntent(nodeId);
  return <button {...intent}>Thread</button>;
}

afterEach(() => vi.useRealTimers());

describe('tree prefetch intent', () => {
  it('waits for pointer intent, cancels flyovers, and immediately handles focus', () => {
    vi.useFakeTimers();
    const prefetch = vi.fn();
    const view = render(<TreePrefetchContext.Provider value={prefetch}><Target nodeId="n1" /></TreePrefetchContext.Provider>);
    const target = screen.getByRole('button');
    fireEvent.pointerEnter(target);
    act(() => { vi.advanceTimersByTime(TREE_PREFETCH_INTENT_MS - 1); });
    expect(prefetch).not.toHaveBeenCalled();
    fireEvent.pointerLeave(target);
    act(() => { vi.advanceTimersByTime(TREE_PREFETCH_INTENT_MS); });
    expect(prefetch).not.toHaveBeenCalled();
    fireEvent.pointerEnter(target);
    act(() => { vi.advanceTimersByTime(TREE_PREFETCH_INTENT_MS); });
    expect(prefetch).toHaveBeenCalledExactlyOnceWith('n1');
    fireEvent.focus(target);
    expect(prefetch).toHaveBeenCalledTimes(2);
    fireEvent.pointerEnter(target);
    view.unmount();
    act(() => { vi.advanceTimersByTime(TREE_PREFETCH_INTENT_MS); });
    expect(prefetch).toHaveBeenCalledTimes(2);
  });
});
