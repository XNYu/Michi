import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DigestGenerationStatus from './DigestGenerationStatus';
import type { DigestState } from '../../state/digest';

const digest: DigestState = {
  sources: [], sourceFingerprints: {}, content: '', generatedAt: 0, viewedAt: 0, status: 'streaming',
};

afterEach(() => { vi.useRealTimers(); });

describe('DigestGenerationStatus', () => {
  it('updates elapsed time and removes progress when generation completes', async () => {
    vi.useFakeTimers();
    const running: DigestState = {
      ...digest, generation: { startedAt: Date.now() - 61_000, thought: 'Reviewing notes', activity: 'Thinking...' },
    };
    const view = render(<DigestGenerationStatus digest={running} />);
    expect(screen.getByText('1m 1s')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText('1m 2s')).toBeTruthy();
    view.rerender(<DigestGenerationStatus digest={{ ...running, status: 'idle' }} />);
    // Folding away it is already out of reach, then gone.
    expect(screen.queryByRole('region', { name: 'Digest generation' })).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(screen.queryByText('Reviewing notes')).toBeNull();
    // The clock stopped with the generation (motion's last frame aside).
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(vi.getTimerCount()).toBe(0);
  });
});
