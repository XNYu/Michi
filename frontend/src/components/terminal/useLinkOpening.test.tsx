import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLinkOpening } from './useLinkOpening';
import { openPreferredUrl, openExternalUrl } from '../../services/openUrl';

const mocks = vi.hoisted(() => ({
  openBrowserPane: vi.fn(), openExternal: vi.fn(), browserCreate: vi.fn(),
  onOpenUrl: vi.fn((_handler: (url: string) => void) => vi.fn()),
  prefs: { linkOpenTarget: 'internal' },
  project: { id: 'p', activeTreeId: 'tree', backendConnectionId: 'local' },
}));
vi.mock('../../state/chatStore', () => ({
  useChatProjects: () => ({ activeProject: mocks.project }),
  useChatActions: () => ({ openBrowserPane: mocks.openBrowserPane }),
}));
vi.mock('../../state/prefs', () => ({ usePrefs: () => ({ prefs: mocks.prefs }) }));
vi.mock('../../lib/electronBridge', () => ({ getElectron: () => mocks }));
function Harness() { useLinkOpening(); return <><a href="https://example.com/a">Link</a><a href="#section">Anchor</a></>; }

beforeEach(() => {
  vi.clearAllMocks(); mocks.prefs.linkOpenTarget = 'internal';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ request: null }) }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('preferred link opening', () => {
  it('routes anchors, programmatic links and native window opens to internal Browser by default', () => {
    const { getByText } = render(<Harness />);
    fireEvent.click(getByText('Link'));
    act(() => openPreferredUrl('https://example.com/b'));
    const handler = mocks.onOpenUrl.mock.calls[0]?.[0] as unknown as (url: string) => void;
    act(() => handler('http://localhost:8080/'));
    expect(mocks.openBrowserPane.mock.calls).toEqual([['https://example.com/a'], ['https://example.com/b'], ['http://localhost:8080/']]);
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });
  it('uses changed preferences immediately, but always honors explicit external opening', () => {
    const { rerender, getByText } = render(<Harness />);
    act(() => openExternalUrl('https://example.com'));
    expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com/');
    mocks.prefs.linkOpenTarget = 'external';
    rerender(<Harness />);
    fireEvent.click(getByText('Link'));
    expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com/a');
    expect(mocks.openBrowserPane).not.toHaveBeenCalled();
  });
  it('ignores non-web requests and fragment navigation', () => {
    const { getByText } = render(<Harness />);
    fireEvent.click(getByText('Anchor'));
    act(() => openPreferredUrl('javascript:alert(1)'));
    expect(mocks.openBrowserPane).not.toHaveBeenCalled();
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });
  it('delivers an agent URL through the same preference', async () => {
    mocks.prefs.linkOpenTarget = 'external';
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ request: { id: 'request', url: 'https://example.com/agent' } }) } as Response);
    await act(async () => { render(<Harness />); });
    expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com/agent');
    expect(mocks.openBrowserPane).not.toHaveBeenCalled();
  });
});
