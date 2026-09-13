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
  it('shows waiting activity before the runtime emits any thoughts', () => {
    render(<DigestGenerationStatus digest={digest} />);
    expect(screen.getByRole('status').textContent).toBe('Generating digest...');
    expect(screen.queryByRole('region', { name: 'Digest thinking' })).toBeNull();
  });

  it('updates elapsed time and removes progress when generation completes', () => {
    vi.useFakeTimers();
    const running: DigestState = {
      ...digest, generation: { startedAt: Date.now() - 61_000, thought: 'Reviewing notes', activity: 'Thinking...' },
    };
    const view = render(<DigestGenerationStatus digest={running} />);
    expect(screen.getByText('1m 1s')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText('1m 2s')).toBeTruthy();
    view.rerender(<DigestGenerationStatus digest={{ ...running, status: 'idle' }} />);
    expect(screen.queryByRole('region', { name: 'Digest generation' })).toBeNull();
    expect(screen.queryByText('Reviewing notes')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
