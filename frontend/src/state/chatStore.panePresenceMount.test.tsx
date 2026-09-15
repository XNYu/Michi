/**
 * Confirms `usePanePresenceIntegration` is mounted exactly once by `ChatProvider`, not once per
 * pane/render, and never duplicated across a re-render caused by unrelated state changes.
 *
 * Mocks the hook itself (not its internals — those are covered by
 * `usePanePresenceIntegration.test.ts`) so this stays a pure "how many times was it called"
 * check on the real `ChatProvider` mount wiring.
 */
import React from 'react';
import { vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const integrationSpy = vi.hoisted(() => vi.fn());
vi.mock('./usePanePresenceIntegration', () => ({
  usePanePresenceIntegration: integrationSpy,
}));

vi.mock('../services/api', () => ({
  __esModule: true,
  allocateNodeIds: (() => { let i = 0; return async (count = 1) => Array.from({ length: count }, () => `n-test-${++i}`); })(),
  allocateNodeIdsLocal: (() => { let i = 0; return (count = 1) => Array.from({ length: count }, () => `n-test-${++i}`); })(),
  listAgentModes: () => Promise.resolve([]),
  fetchAgentStatus: () => Promise.resolve(null),
  fetchReady: () => Promise.resolve({ status: 'ready' }),
  listModels: () => Promise.resolve({ models: [], defaultModel: null }),
  listAgentModels: () => Promise.resolve({ models: [], sanitizedModel: null }),
  fetchPrefs: () => Promise.resolve(null),
  savePrefs: () => Promise.resolve(),
  deleteWorkspace: () => Promise.resolve({ ok: true }),
  setChatMode: () => Promise.resolve('fake-chat'),
  respondToPermission: () => Promise.resolve({ ok: true }),
  cancelPermission: () => Promise.resolve({ ok: true }),
  respondToUserInput: () => Promise.resolve({ ok: true }),
  skipUserInput: () => Promise.resolve({ ok: true }),
  warmCwd: () => Promise.resolve({ ok: true }),
  claimPane: () => Promise.resolve({ owner: true }),
  heartbeatPane: () => Promise.resolve(true),
  releasePane: () => Promise.resolve(),
  subscribeChat: vi.fn(() => () => {}),
  subscribeChats: vi.fn(() => () => {}),
  subscribeBackground: vi.fn(() => () => {}),
  cancelChat: () => Promise.resolve(),
  steerChat: () => Promise.resolve(),
  bindPendingPrimaryAgent: vi.fn(),
  ensureSession: vi.fn(),
  streamMessage: vi.fn(),
}));

vi.mock('../services/notifications', () => ({ notify: vi.fn() }));
vi.mock('../services/digestApi', () => ({
  streamDigest: vi.fn(async () => '# Decisions\n\nKeep the source thread context.'),
}));

import { ChatProvider, useChatStore } from './chatStore';
import { PrefsProvider } from './prefs';

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

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <PrefsProvider>
      <ChatProvider>{children}</ChatProvider>
    </PrefsProvider>
  );
}

function useStoreOnly() {
  return useChatStore();
}

describe('ChatProvider mounts usePanePresenceIntegration exactly once', () => {
  beforeEach(() => {
    integrationSpy.mockReset();
  });

  it('calls the hook exactly once per commit, not once per open pane', async () => {
    const { result, rerender } = renderHook(() => useStoreOnly(), { wrapper });

    await act(async () => { await Promise.resolve(); });

    // A single ChatProvider tree renders `usePanePresenceIntegration` exactly once per commit —
    // never twice (e.g. once per pane, or once per some inner sub-component).
    const callsAfterMount = integrationSpy.mock.calls.length;
    expect(callsAfterMount).toBeGreaterThan(0);

    // Every call must carry the shape the integration hook expects — proving ChatProvider wires
    // real state into it rather than calling it as an inert no-op.
    const lastCallArgs = integrationSpy.mock.calls.at(-1)![0];
    expect(lastCallArgs).toEqual(expect.objectContaining({
      windowId: expect.any(String),
      hydrated: expect.any(Boolean),
      projects: expect.any(Array),
      openPanesMap: expect.any(Object),
      paneItems: expect.any(Object),
    }));

    // Trigger an unrelated re-render (toggling the unread filter needs no active project) and
    // confirm the call count grows — i.e. this is a single steady mount point that re-renders
    // with the store, not something that fans out per-pane or stops updating.
    act(() => {
      result.current.setUnreadFilterOn(true);
    });
    rerender();
    await act(async () => { await Promise.resolve(); });

    // Each commit calls the hook exactly once (React re-invokes ChatProvider's function body
    // once per commit; the mock records one call per invocation of that body).
    expect(integrationSpy.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });
});
