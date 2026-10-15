import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BrowserLauncher from './BrowserLauncher';

const state = vi.hoisted(() => ({
  openBrowserPane: vi.fn(() => 'web'), setPaneWidth: vi.fn(), focusPane: vi.fn(),
  panes: { openPanes: ['chat'], focusedPane: 'chat', paneItems: {} as Record<string, { kind: string }> },
}));
vi.mock('../../state/chatStore', () => ({ useChatPanes: () => state.panes, useChatActions: () => state }));
vi.mock('../../state/prefs', () => ({ usePrefs: () => ({ prefs: { defaultPaneWidth: 600 } }) }));

beforeEach(() => {
  vi.clearAllMocks();
  state.panes.openPanes = ['chat'];
  state.panes.paneItems = {};
});

function setup(width: number) {
  const result = render(<div className="terminal-shell"><BrowserLauncher /><div className="terminal-dashboard"><div data-node-id="chat" /></div></div>);
  const strip = result.container.querySelector('.terminal-dashboard')!;
  vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue({ width: 1000 } as DOMRect);
  vi.spyOn(strip.firstElementChild!, 'getBoundingClientRect').mockReturnValue({ width } as DOMRect);
  return result;
}

describe('BrowserLauncher', () => {
  it('renders an icon-only button that keeps its accessible name and tooltip', () => {
    setup(1000);
    const button = screen.getByRole('button', { name: 'Browser' });
    expect(button.textContent?.trim()).toBe('');
    expect(button.getAttribute('title')).toBe('Browser');
  });

  it('splits a lone full-width pane into two equal panes', () => {
    setup(1000);
    fireEvent.click(screen.getByRole('button', { name: 'Browser' }));
    expect(state.setPaneWidth.mock.calls).toEqual([['web', 500]]);
  });

  it('copies a custom pane width instead of using a fixed browser width', () => {
    const { container } = setup(340);
    container.querySelector('.terminal-dashboard')!.appendChild(document.createElement('div')).setAttribute('data-node-id', 'another');
    fireEvent.click(screen.getByRole('button', { name: 'Browser' }));
    expect(state.setPaneWidth.mock.calls).toEqual([['chat', 340], ['web', 340]]);
  });

  it('focuses an existing browser without creating another pane or changing widths', () => {
    state.panes.openPanes = ['chat', 'web'];
    state.panes.paneItems = { web: { kind: 'browser' } };
    setup(340);
    fireEvent.click(screen.getByRole('button', { name: 'Browser' }));
    expect(state.focusPane).toHaveBeenCalledWith('web');
    expect(state.openBrowserPane).not.toHaveBeenCalled();
    expect(state.setPaneWidth).not.toHaveBeenCalled();
  });
});
