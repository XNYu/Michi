import React, { Component, type ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { deferredComponent } from './deferredComponent';

it('imports only when mounted, shares pending work and immediately reveals the latest props', async () => {
  let resolve!: (module: { default: React.ComponentType<{ label: string }> }) => void;
  const importer = vi.fn(() => new Promise<{ default: React.ComponentType<{ label: string }> }>(done => { resolve = done; }));
  const View = deferredComponent(importer, <p>Loading module</p>);
  expect(importer).not.toHaveBeenCalled();
  const first = render(<View label="old" />);
  const second = render(<View label="second" />);
  await act(async () => {});
  expect(importer).toHaveBeenCalledTimes(1);
  first.rerender(<View label="new" />);
  await act(async () => { resolve({ default: ({ label }) => <p>{label}</p> }); });
  expect(screen.getByText('new')).toBeTruthy();
  expect(screen.getByText('second')).toBeTruthy();
  first.unmount(); second.unmount();
  render(<View label="reopened" />);
  expect(screen.getByText('reopened')).toBeTruthy();
  expect(importer).toHaveBeenCalledTimes(1);
});

it('keeps a completed module after all subscribers unmount during loading', async () => {
  let resolve!: (module: { default: React.ComponentType<object> }) => void;
  const View = deferredComponent<object>(() => new Promise<{ default: React.ComponentType<object> }>(done => { resolve = done; }), 'Waiting');
  const view = render(<View />);
  await act(async () => {});
  view.unmount();
  await act(async () => { resolve({ default: () => <p>Cached module</p> }); });
  render(<View />);
  expect(screen.getByText('Cached module')).toBeTruthy();
});

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p>Module failed</p> : this.props.children; }
}
it('sends import failures to the existing error boundary', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const View = deferredComponent<object>(() => Promise.reject(new Error('offline')), 'Waiting');
    render(<Boundary><View /></Boundary>);
    expect(await screen.findByText('Module failed')).toBeTruthy();
  } finally { error.mockRestore(); }
});
