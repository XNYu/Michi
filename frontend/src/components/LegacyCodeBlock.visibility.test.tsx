import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LegacyCodeBlock from './LegacyCodeBlock';

vi.mock('./LegacyHighlightedCode', () => ({ default: ({ source }: { source: string }) => <span data-testid="highlighted">{source}</span> }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('code highlight visibility', () => {
  it('keeps offscreen code readable without mounting tokens, then highlights near the viewport', async () => {
    let intersect!: IntersectionObserverCallback;
    const disconnect = vi.fn();
    const observe = vi.fn();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { intersect = callback; }
      disconnect = disconnect;
      observe = observe;
    });
    const { container, unmount } = render(<LegacyCodeBlock text={'const answer = 42;\n'} language="ts" lineNumbers />);
    expect(container.querySelector('code')?.textContent).toBe('const answer = 42;');
    expect(screen.queryByTestId('highlighted')).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy();
    expect(observe).toHaveBeenCalledWith(container.firstElementChild);
    await act(async () => intersect([{ isIntersecting: false }] as IntersectionObserverEntry[], {} as IntersectionObserver));
    expect(screen.queryByTestId('highlighted')).toBeNull();
    await act(async () => intersect([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver));
    expect((await screen.findByTestId('highlighted')).textContent).toBe('const answer = 42;');
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it('does not schedule highlighting during an unfinished streaming code block', () => {
    const createObserver = vi.fn();
    vi.stubGlobal('IntersectionObserver', createObserver);
    render(<LegacyCodeBlock text="const answer =" language="ts" deferHighlight />);
    expect(createObserver).not.toHaveBeenCalled();
    expect(screen.queryByTestId('highlighted')).toBeNull();
  });
});
