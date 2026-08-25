import React from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BrowserPane from './BrowserPane';

const closePane = vi.fn();
let closeRequest: ((surfaceId: string) => void) | undefined;

vi.mock('../../state/chatStore', () => ({
  useChatActions: () => ({
    closePane,
    focusPane: vi.fn(),
    setFocusedNodeId: vi.fn(),
    updatePaneItem: vi.fn(),
  }),
}));

vi.mock('../../hooks/usePaneShellStyle', () => ({ usePaneShellStyle: () => ({}) }));

vi.mock('../../lib/electronBridge', () => ({
  getElectron: () => ({
    browserCreate: vi.fn().mockResolvedValue({
      surfaceId: 'surface-browser-1',
      url: 'https://www.google.com/',
      title: 'Google',
      loading: false,
      canGoBack: false,
      canGoForward: false,
    }),
    browserSetBounds: vi.fn(),
    onBrowserState: vi.fn(() => vi.fn()),
    onBrowserFocus: vi.fn(() => vi.fn()),
    onBrowserCloseRequest: vi.fn((handler: (surfaceId: string) => void) => {
      closeRequest = handler;
      return vi.fn();
    }),
  }),
}));

const item = {
  id: 'pane-browser-1',
  kind: 'browser' as const,
  projectId: 'project-1',
  treeId: 'tree-1',
  createdAt: 1,
  surfaceId: 'surface-browser-1',
  url: 'https://www.google.com/',
  title: 'Browser',
};

describe('BrowserPane native shortcuts', () => {
  beforeEach(() => {
    closePane.mockReset();
    closeRequest = undefined;
  });

  it('closes only the pane that owns the requested native surface', () => {
    render(<BrowserPane item={item} />);
    expect(closeRequest).toBeTypeOf('function');

    act(() => closeRequest?.('another-surface'));
    expect(closePane).not.toHaveBeenCalled();

    act(() => closeRequest?.('surface-browser-1'));
    expect(closePane).toHaveBeenCalledOnce();
    expect(closePane).toHaveBeenCalledWith('pane-browser-1');
  });
});
