import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import AllThreads from './AllThreads';
import { openAllThreadsFiltered, resetAllThreadsViewForTests } from '../../../state/content/allThreadsFilter';

vi.mock('./MichiThreads', () => ({ MichiThreads: ({ state }: { state: string | null }) => <div data-testid="native-threads">{state ?? 'all'}</div> }));
afterEach(() => resetAllThreadsViewForTests());

it('direct navigation always opens native Michi conversations', () => {
  render(<AllThreads />);
  expect(screen.getByTestId('native-threads').textContent).toBe('all');
});

it('a Home section filter narrows native conversations and clears on leaving', async () => {
  act(() => openAllThreadsFiltered('waiting'));
  const view = render(<AllThreads />);
  expect(screen.getByTestId('native-threads').textContent).toBe('waiting');
  view.unmount();
  await act(async () => { await Promise.resolve(); });
  render(<AllThreads />);
  expect(screen.getByTestId('native-threads').textContent).toBe('all');
});
