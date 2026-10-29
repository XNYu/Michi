import { vi } from 'vitest';

vi.mock('../services/api', () => ({
  __esModule: true,
  listAgentModes: () => Promise.resolve({ availableModes: [], defaultModeId: null }),
  fetchAgentStatus: () => Promise.resolve(null),
  fetchPrefs: () => Promise.resolve(null),
  savePrefs: () => Promise.resolve(),
  deleteWorkspace: () => Promise.resolve({ ok: true }),
  setChatMode: () => Promise.resolve('fake-chat'),
  respondToPermission: () => Promise.resolve({ ok: true }),
  cancelPermission: () => Promise.resolve({ ok: true }),
  warmCwd: () => Promise.resolve({ ok: true }),
  subscribeChat: vi.fn(() => () => {}),
  subscribeChats: vi.fn(() => () => {}),
  subscribeBackground: vi.fn(() => () => {}),
  cancelChat: () => Promise.resolve(),
  ensureSession: vi.fn(),
  streamMessage: vi.fn(),
}));

vi.mock('../services/notifications', () => ({ notify: vi.fn() }));

// jsdom lacks matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { ChatProvider, useChatActions, useStructureVersion } from './chatStore';
import { PrefsProvider } from './prefs';

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <PrefsProvider>
      <ChatProvider>{children}</ChatProvider>
    </PrefsProvider>
  );
}

describe('structureVersionRef bumps in dispatch', () => {
  it('does not advance the version for HIGH_FREQ_ACTIONS', () => {
    const { result } = renderHook(
      () => {
        const dispatch = useChatActions().dispatch;
        const version = useStructureVersion();
        return { dispatch, version };
      },
      { wrapper },
    );

    // Establish a node so chunk has somewhere to apply.
    act(() => result.current.dispatch({
      type: 'create',
      nodeId: 'n1',
      projectId: 'p1',
    } as any));
    const v0 = result.current.version;

    act(() => result.current.dispatch({
      type: 'user-send',
      nodeId: 'n1',
      assistantId: 'n1-a0',
      userText: 'hi',
    } as any));
    const v1 = result.current.version;
    expect(v1).toBeGreaterThan(v0);

    // High-freq stream of tokens — version must not advance.
    for (let i = 0; i < 5; i += 1) {
      act(() => result.current.dispatch({
        type: 'chunk',
        nodeId: 'n1',
        assistantId: 'n1-a0',
        text: 'x',
      } as any));
    }
    expect(result.current.version).toBe(v1);

    // A non-high-freq action advances it again.
    act(() => result.current.dispatch({
      type: 'done',
      nodeId: 'n1',
      assistantId: 'n1-a0',
    } as any));
    expect(result.current.version).toBeGreaterThan(v1);
  });
});
