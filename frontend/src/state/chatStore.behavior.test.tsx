/**
 * Feature 5: Auto-branch on streaming — real behavior test (Task 5.4).
 *
 * Renders ChatProvider and invokes sendMessage / createChildChat on nodes in
 * different statuses, verifying that the services/api mock's streamMessage is
 * (or is not) called. Stronger than the pure-function contract tests in
 * chatStore.test.ts because it exercises the real reducer + useCallback
 * wiring inside the provider.
 *
 * Mock note: Jest 27 + CRA babel-jest had a quirk where `jest.fn(impl)` called
 * inside a `jest.mock` factory silently dropped the implementation. The verbose
 * pattern below (non-spied fns as plain arrows, spied fns as vi.fn()) is a
 * historical workaround preserved during the vitest migration; it can be
 * simplified in a follow-up commit since vitest has no equivalent quirk.
 */
import React from 'react';
import { vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('../services/api', () => ({
  __esModule: true,
  // Non-spied: plain arrow that returns what the provider expects.
  listAgentModes: () => Promise.resolve([]),
  fetchAgentStatus: () => Promise.resolve(null),
  listModels: () => Promise.resolve({ models: [], defaultModel: null }),
  fetchPrefs: () => Promise.resolve(null),
  savePrefs: () => Promise.resolve(),
  deleteWorkspace: () => Promise.resolve({ ok: true }),
  setChatMode: () => Promise.resolve('fake-chat'),
  respondToPermission: () => Promise.resolve({ ok: true }),
  cancelPermission: () => Promise.resolve({ ok: true }),
  warmCwd: () => Promise.resolve({ ok: true }),
  claimPane: () => Promise.resolve({ owner: true }),
  heartbeatPane: () => Promise.resolve(true),
  releasePane: () => Promise.resolve(),
  subscribeChat: vi.fn(() => () => {}),
  cancelChat: () => Promise.resolve(),
  // Spied: implementation set in beforeEach.
  ensureSession: vi.fn(),
  streamMessage: vi.fn(),
}));

vi.mock('../services/notifications', () => ({ notify: vi.fn() }));

import * as api from '../services/api';
import { notify } from '../services/notifications';
import { ChatProvider, useChatStore, useChatNodesSnapshot } from './chatStore';
import { PrefsProvider } from './prefs';
import type { ChatNodeState } from './chatTypes';

function useStoreAndNodes() {
  const store = useChatStore();
  const nodes = useChatNodesSnapshot();
  return { store, nodes };
}

const mockEnsureSession = api.ensureSession as ReturnType<typeof vi.fn>;
const mockStreamMessage = api.streamMessage as ReturnType<typeof vi.fn>;
const mockNotify = notify as ReturnType<typeof vi.fn>;

// Stub matchMedia — jsdom lacks it and some hooks probe for it.
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

function assistantAnswerRaw(node: ChatNodeState | undefined): string {
  const assistant = node?.messages.find((m) => m.role === 'assistant');
  return (assistant?.blocks ?? [])
    .filter((b) => b.kind === 'answer')
    .map((b) => b.rawText)
    .join('');
}

describe('auto-branch behavior (real provider)', () => {
  beforeEach(() => {
    mockEnsureSession.mockReset();
    mockStreamMessage.mockReset();
    mockNotify.mockReset();
    mockEnsureSession.mockImplementation(() => Promise.resolve({ chatId: 'fake-chat', currentModeId: null, resumeStrategy: 'fresh' }));
    // Real streamMessage returns a cancel fn AND starts an async stream. For
    // our guard test we only need it to be callable and return a no-op cancel.
    mockStreamMessage.mockImplementation(() => () => {});
    localStorage.clear();
  });

  it('sendMessage on a streaming node does NOT call streamMessage (guard fires)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });

    await act(async () => {
      await result.current.store.createProject('test', undefined);
    });
    await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());
    // Workspaces start empty; create the first thread explicitly so we have
    // a node to send messages to. Mirrors what Home composer's submit does.
    let rootId: string = '';
    act(() => {
      rootId = result.current.store.createThread() ?? '';
    });

    // First send: idle → streaming. streamMessage is called once.
    await act(async () => {
      result.current.store.sendMessage(rootId, 'hello');
    });
    await waitFor(() => expect(result.current.nodes[rootId].status).toBe('streaming'));
    expect(mockStreamMessage).toHaveBeenCalledTimes(1);
    mockStreamMessage.mockClear();

    // Second send to the still-streaming node: guard fires, no call.
    await act(async () => {
      result.current.store.sendMessage(rootId, 'second message');
    });
    expect(mockStreamMessage).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('sendMessage called on streaming node'),
    );

    warnSpy.mockRestore();
  });

  it('sendMessage on an idle node calls streamMessage (normal in-place reply)', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });

    await act(async () => {
      await result.current.store.createProject('test', undefined);
    });
    await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());
    // Workspaces start empty; create the first thread explicitly so we have
    // a node to send messages to. Mirrors what Home composer's submit does.
    let rootId: string = '';
    act(() => {
      rootId = result.current.store.createThread() ?? '';
    });
    expect(result.current.nodes[rootId].status).toBe('idle');

    await act(async () => {
      result.current.store.sendMessage(rootId, 'hello');
    });

    expect(mockStreamMessage).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.nodes[rootId].status).toBe('streaming'));
  });

  it('createChildChat from a streaming parent starts an independent new stream', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });

    await act(async () => {
      await result.current.store.createProject('test', undefined);
    });
    await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());
    // Workspaces start empty; create the first thread explicitly so we have
    // a node to send messages to. Mirrors what Home composer's submit does.
    let rootId: string = '';
    act(() => {
      rootId = result.current.store.createThread() ?? '';
    });

    await act(async () => {
      result.current.store.sendMessage(rootId, 'parent turn');
    });
    await waitFor(() => expect(result.current.nodes[rootId].status).toBe('streaming'));
    mockStreamMessage.mockClear();
    mockEnsureSession.mockClear();

    let childId: string | undefined;
    await act(async () => {
      childId = await result.current.store.createChildChat(rootId, 'branch off');
    });

    expect(childId).toBeDefined();
    expect(result.current.nodes[childId!]).toBeDefined();
    expect(result.current.nodes[childId!].parentNodeId).toBe(rootId);
    expect(mockEnsureSession).toHaveBeenCalled();
    expect(mockStreamMessage).toHaveBeenCalledTimes(1);
    // Parent node remains streaming; child gets its own turn.
    expect(result.current.nodes[rootId].status).toBe('streaming');
  });

  it('does not notify when the focused pane finishes streaming while the window is focused', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });

    await act(async () => {
      await result.current.store.createProject('test', undefined);
    });
    await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());
    let rootId = '';
    act(() => {
      rootId = result.current.store.createThread() ?? '';
    });
    await waitFor(() => expect(result.current.store.focusedPane).toBe(rootId));

    await act(async () => {
      result.current.store.sendMessage(rootId, 'hello');
    });
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));

    const handlers = mockStreamMessage.mock.calls[0][2] as { onDone?: () => void };
    act(() => {
      handlers.onDone?.();
    });

    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('still notifies when an unfocused pane finishes while the window is focused', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });

    await act(async () => {
      await result.current.store.createProject('test', undefined);
    });
    await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());
    let firstRootId = '';
    let secondRootId = '';
    act(() => {
      firstRootId = result.current.store.createThread() ?? '';
    });
    act(() => {
      secondRootId = result.current.store.createThread() ?? '';
    });
    await waitFor(() => expect(result.current.store.focusedPane).toBe(secondRootId));

    await act(async () => {
      result.current.store.sendMessage(firstRootId, 'background work');
    });
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));

    const handlers = mockStreamMessage.mock.calls[0][2] as { onDone?: () => void };
    act(() => {
      handlers.onDone?.();
    });

    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Branch complete',
      body: 'Streaming finished',
    }));
  });

  it('does not let a stale RAF commit roll streaming text backward', async () => {
    const originalWindowRaf = window.requestAnimationFrame;
    const originalGlobalRaf = globalThis.requestAnimationFrame;
    const rafCallbacks: FrameRequestCallback[] = [];
    const fakeRaf = ((cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    }) as typeof requestAnimationFrame;
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: fakeRaf,
    });
    (globalThis as any).requestAnimationFrame = fakeRaf;

    try {
      const { result, rerender } = renderHook(() => useStoreAndNodes(), { wrapper });

      await act(async () => {
        await result.current.store.createProject('test', undefined);
      });
      await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());

      let rootId = '';
      act(() => {
        rootId = result.current.store.createThread() ?? '';
      });

      await act(async () => {
        result.current.store.sendMessage(rootId, 'hello');
      });
      await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));

      const handlers = mockStreamMessage.mock.calls[0][2] as {
        onChunk?: (text: string) => void;
      };

      await act(async () => {
        handlers.onChunk?.('a');
        expect(rafCallbacks).toHaveLength(1);
        rafCallbacks.shift()?.(performance.now());
        handlers.onChunk?.('b');
      });

      // Let the React commit from the first RAF run its effect. The committed
      // state only contains "a"; nodesRef has already advanced to "ab".
      await act(async () => {});

      act(() => {
        handlers.onChunk?.('c');
      });

      await act(async () => {
        while (rafCallbacks.length > 0) {
          rafCallbacks.shift()?.(performance.now());
        }
      });

      rerender();
      expect(assistantAnswerRaw(result.current.nodes[rootId])).toBe('abc');
    } finally {
      Object.defineProperty(window, 'requestAnimationFrame', {
        configurable: true,
        writable: true,
        value: originalWindowRaf,
      });
      (globalThis as any).requestAnimationFrame = originalGlobalRaf;
    }
  });

  it('updates the absolute folder bound to an existing workspace', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });

    await act(async () => {
      await result.current.store.createProject('test', '/tmp/original');
    });
    await waitFor(() => expect(result.current.store.activeProject?.cwd).toBe('/tmp/original'));

    act(() => {
      result.current.store.setProjectCwd(result.current.store.activeProject!.id, '/tmp/relinked');
    });

    expect(result.current.store.activeProject?.cwd).toBe('/tmp/relinked');
  });
});
