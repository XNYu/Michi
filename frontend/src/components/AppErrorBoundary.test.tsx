import React, { useState } from 'react';
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppErrorBoundary from './AppErrorBoundary';

afterEach(cleanup);

/** A component that throws on command. */
function Crasher({ shouldThrow, message = 'boom' }: { shouldThrow: boolean; message?: string }) {
  if (shouldThrow) throw new Error(message);
  return <div data-testid="content">ok</div>;
}

describe('AppErrorBoundary', () => {
  it('auto-retries transient crashes then recovers', async () => {
    // Use a ref-like variable that survives across React mounts.
    let hasThrown = false;
    function TransientCrasher() {
      // Throw exactly once — subsequent mounts succeed.
      if (!hasThrown) {
        hasThrown = true;
        throw new Error('transient');
      }
      return <div data-testid="content">recovered</div>;
    }

    vi.useFakeTimers();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <AppErrorBoundary>
        <TransientCrasher />
      </AppErrorBoundary>,
    );

    // After the retry delay, the boundary should re-mount children and succeed.
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(screen.getByTestId('content').textContent).toBe('recovered');

    spy.mockRestore();
    vi.useRealTimers();
  });

  it('shows fallback after exceeding max auto-retries', async () => {
    function AlwaysCrash(): React.ReactNode {
      throw new Error('persistent crash');
    }

    vi.useFakeTimers();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <AppErrorBoundary>
        <AlwaysCrash />
      </AppErrorBoundary>,
    );

    // Exhaust auto-retries.
    for (let i = 0; i < 3; i++) {
      await act(async () => { vi.advanceTimersByTime(200); });
    }

    // Fallback UI should be visible now.
    expect(screen.getByText('Michi ran into a problem')).toBeTruthy();
    expect(screen.getByText('persistent crash')).toBeTruthy();
    expect(screen.getByText('reload')).toBeTruthy();

    spy.mockRestore();
    vi.useRealTimers();
  });

  it('clears error when resetKeys change', async () => {
    function Outer() {
      const [key, setKey] = useState(0);
      return (
        <>
          <button data-testid="switch" onClick={() => setKey((k) => k + 1)}>
            switch
          </button>
          <AppErrorBoundary resetKeys={[key]}>
            {key === 0 ? <Crasher shouldThrow={true} /> : <Crasher shouldThrow={false} />}
          </AppErrorBoundary>
        </>
      );
    }

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();

    render(<Outer />);

    // Crash on key=0, exhaust retries so it shows fallback.
    for (let i = 0; i < 3; i++) {
      await act(async () => { vi.advanceTimersByTime(200); });
    }
    expect(screen.getByText('Michi ran into a problem')).toBeTruthy();

    // Simulate a navigation that changes the resetKey.
    await act(async () => {
      fireEvent.click(screen.getByTestId('switch'));
    });

    // The boundary should have cleared and re-rendered children.
    expect(screen.getByTestId('content').textContent).toBe('ok');

    spy.mockRestore();
    vi.useRealTimers();
  });
});
