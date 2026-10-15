import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CrewMemorySettings, useCrewMemory } from './CrewMemoryControl';

function Composer({ bound = false, nodeId = 'draft' }: { bound?: boolean; nodeId?: string }) {
  const memory = useCrewMemory('/api', true, nodeId, bound);
  return <div>
    <output data-testid="mode">{memory.mode ?? 'unknown'}</output>
    <output data-testid="override">{memory.override ?? 'server default'}</output>
    <button onClick={() => memory.setMode('incognito')}>Choose read only</button>
  </div>;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Crew memory preferences', () => {
  it('refreshes a mounted composer after settings change without overriding the server default', async () => {
    let defaultMode = 'persistent';
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      if (options?.method === 'POST') defaultMode = JSON.parse(options.body).defaultMode;
      return { ok: true, json: async () => ({ defaultMode }) };
    }));
    render(<><Composer /><CrewMemorySettings apiBase="/api" /></>);
    await waitFor(() => expect(screen.getByTestId('mode').textContent).toBe('persistent'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Crew memory' }), { target: { value: 'temporary' } });
    await waitFor(() => expect(screen.getByTestId('mode').textContent).toBe('temporary'));
    expect(screen.getByTestId('override').textContent).toBe('server default');
  });

  it('keeps an explicit new-chat choice local, but never applies it to a bound session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ defaultMode: 'temporary', mode: 'persistent' }) })));
    const { rerender } = render(<Composer />);
    await waitFor(() => expect(screen.getByTestId('mode').textContent).toBe('temporary'));
    fireEvent.click(screen.getByText('Choose read only'));
    expect(screen.getByTestId('override').textContent).toBe('incognito');
    rerender(<Composer nodeId="existing" bound />);
    await waitFor(() => expect(screen.getByTestId('mode').textContent).toBe('persistent'));
    expect(screen.getByTestId('override').textContent).toBe('server default');
  });

  it('ignores a stale node response and leaves an unknown native mode unknown', async () => {
    let finish!: (value: unknown) => void;
    vi.stubGlobal('fetch', vi.fn((url) => String(url).includes('first')
      ? new Promise((resolve) => { finish = resolve; })
      : Promise.resolve({ ok: true, json: async () => ({ defaultMode: 'persistent', mode: null }) })));
    const { rerender } = render(<Composer nodeId="first" bound />);
    rerender(<Composer nodeId="second" bound />);
    await act(async () => finish({ ok: true, json: async () => ({ defaultMode: 'persistent', mode: 'temporary' }) }));
    expect(screen.getByTestId('mode').textContent).toBe('unknown');
  });
});
