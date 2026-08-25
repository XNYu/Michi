import React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserSurfaceState } from '../../lib/electronBridge';
import BrowserPane from './BrowserPane';

const closePane = vi.fn();
const focusPane = vi.fn();
const setFocusedNodeId = vi.fn();
const updatePaneItem = vi.fn();
const browserCreate = vi.fn();
const browserSetBounds = vi.fn();
let closeRequest: ((surfaceId: string) => void) | undefined;
let resolveBrowserCreate: ((state: BrowserSurfaceState) => void) | undefined;

const createdState: BrowserSurfaceState = {
  surfaceId: 'surface-browser-1',
  url: 'https://www.google.com/',
  title: 'Google',
  loading: false,
  canGoBack: false,
  canGoForward: false,
};

const electronBridge = {
  browserCreate,
  browserSetBounds,
  onBrowserState: vi.fn(() => vi.fn()),
  onBrowserFocus: vi.fn(() => vi.fn()),
  onBrowserCloseRequest: vi.fn((handler: (surfaceId: string) => void) => {
    closeRequest = handler;
    return vi.fn();
  }),
};

vi.mock('../../state/chatStore', () => ({
  useChatActions: () => ({
    closePane,
    focusPane,
    setFocusedNodeId,
    updatePaneItem,
  }),
}));

vi.mock('../../hooks/usePaneShellStyle', () => ({ usePaneShellStyle: () => ({}) }));

vi.mock('../../lib/electronBridge', () => ({
  getElectron: () => electronBridge,
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

describe('BrowserPane native bridge', () => {
  beforeEach(() => {
    closePane.mockReset();
    browserSetBounds.mockReset();
    browserCreate.mockReset();
    browserCreate.mockImplementation(() => new Promise<BrowserSurfaceState>((resolve) => {
      resolveBrowserCreate = resolve;
    }));
    closeRequest = undefined;
    resolveBrowserCreate = undefined;
  });

  afterEach(() => vi.unstubAllGlobals());

  it('closes only the pane that owns the requested native surface', () => {
    render(<BrowserPane item={item} />);
    expect(closeRequest).toBeTypeOf('function');

    act(() => closeRequest?.('another-surface'));
    expect(closePane).not.toHaveBeenCalled();

    act(() => closeRequest?.('surface-browser-1'));
    expect(closePane).toHaveBeenCalledOnce();
    expect(closePane).toHaveBeenCalledWith('pane-browser-1');
  });

  it('republishes the current viewport bounds after native surface creation', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const { container } = render(<BrowserPane item={item} />);
    const viewport = container.querySelector('[data-pane-kind="browser"] > div:last-child');
    expect(viewport).toBeInstanceOf(HTMLElement);
    vi.spyOn(viewport as HTMLElement, 'getBoundingClientRect').mockReturnValue({
      x: 420,
      y: 160,
      top: 160,
      left: 420,
      right: 1020,
      bottom: 660,
      width: 600,
      height: 500,
      toJSON: () => ({}),
    });

    act(() => frames.shift()?.(0));
    browserSetBounds.mockClear();

    await act(async () => {
      resolveBrowserCreate?.(createdState);
      await Promise.resolve();
    });
    expect(browserSetBounds).not.toHaveBeenCalled();

    act(() => frames.shift()?.(16));
    expect(browserSetBounds).toHaveBeenCalledOnce();
    expect(browserSetBounds).toHaveBeenCalledWith('surface-browser-1', {
      x: 420,
      y: 160,
      width: 600,
      height: 500,
    }, true);
  });
});
