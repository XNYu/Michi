import { vi } from 'vitest';

vi.mock('../services/api', () => ({
  __esModule: true,
  listAgentModes: () => Promise.resolve([]),
  fetchAgentStatus: () => Promise.resolve(null),
  listModels: () => Promise.resolve({ models: [], defaultModel: null }),
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
import React, { useContext } from 'react';
import {
  ChatProvider,
  useChatActions,
  useStructureVersion,
  useStructuralSelector,
  ChatNodeStoreContext,
  type ChatNodeState,
} from './chatStore';
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

describe('subscribeStructure fires only on version-advancing commits', () => {
  it('skips firing during streamed-token commits and fires on done', async () => {
    const TestProbe: React.FC<{
      onDispatchReady: (d: (a: any) => void) => void;
      onSubscribe: (subscribe: (l: () => void) => () => void) => void;
    }> = ({ onDispatchReady, onSubscribe }) => {
      const dispatch = useChatActions().dispatch;
      const ctx = useContext(ChatNodeStoreContext);
      React.useEffect(() => {
        if (dispatch) onDispatchReady(dispatch);
        if (ctx) onSubscribe(ctx.subscribeStructure);
      }, [dispatch, ctx, onDispatchReady, onSubscribe]);
      return null;
    };

    let dispatch: ((a: any) => void) | null = null;
    let subscribeStructure: ((l: () => void) => () => void) | null = null;
    let calls = 0;

    const { rerender } = renderHook(
      () => null,
      {
        wrapper: ({ children }) => (
          <PrefsProvider>
            <ChatProvider>
              <TestProbe
                onDispatchReady={(d) => { dispatch = d; }}
                onSubscribe={(s) => { subscribeStructure = s; }}
              />
              {children}
            </ChatProvider>
          </PrefsProvider>
        ),
      },
    );

    // Wait for the probe's effect to run.
    await act(async () => {});
    expect(dispatch).toBeTruthy();
    expect(subscribeStructure).toBeTruthy();

    let unsubscribe: () => void = () => {};
    act(() => {
      unsubscribe = subscribeStructure!(() => { calls += 1; });
    });

    // Establish a node, then a structural action (user-send) — fires.
    act(() => dispatch!({ type: 'create', nodeId: 'n1', projectId: 'p1' }));
    act(() => dispatch!({ type: 'user-send', nodeId: 'n1', assistantId: 'n1-a0', userText: 'hi' }));
    await act(async () => {});
    const callsAfterStructural = calls;
    expect(callsAfterStructural).toBeGreaterThan(0);

    // Streamed tokens — must not increase the call count.
    for (let i = 0; i < 5; i += 1) {
      act(() => dispatch!({ type: 'chunk', nodeId: 'n1', assistantId: 'n1-a0', text: 'x' }));
    }
    await act(async () => {});
    expect(calls).toBe(callsAfterStructural);

    // 'done' is non-high-freq → fires.
    act(() => dispatch!({ type: 'done', nodeId: 'n1', assistantId: 'n1-a0' }));
    await act(async () => {});
    expect(calls).toBeGreaterThan(callsAfterStructural);

    unsubscribe();
  });
});

describe('useStructuralSelector', () => {
  it('selector body does not run on streamed-token commits when selector has stable identity', async () => {
    let runs = 0;
    let latestDispatch: ((a: any) => void) | null = null;

    const Probe: React.FC<{ onTotal: (n: number) => void }> = ({ onTotal }) => {
      latestDispatch = useChatActions().dispatch;
      const stableSelector = React.useCallback((nodes: Record<string, ChatNodeState>) => {
        runs += 1;
        return Object.keys(nodes).length;
      }, []);
      const total = useStructuralSelector(stableSelector);
      React.useEffect(() => { onTotal(total); }, [total, onTotal]);
      return null;
    };

    let lastTotal = 0;
    const setTotal = (n: number) => { lastTotal = n; };

    renderHook(() => null, {
      wrapper: ({ children }) => (
        <PrefsProvider>
          <ChatProvider>
            <Probe onTotal={setTotal} />
            {children}
          </ChatProvider>
        </PrefsProvider>
      ),
    });

    await act(async () => {});
    expect(latestDispatch).toBeTruthy();

    // Establish a node, take baseline.
    act(() => latestDispatch!({ type: 'create', nodeId: 'n1', projectId: 'p1' }));
    await act(async () => {});
    const baseline = runs;

    expect(lastTotal).toBe(1);

    // Stream a structural action (user-send) — version advances, runs once more.
    act(() => latestDispatch!({ type: 'user-send', nodeId: 'n1', assistantId: 'n1-a0', userText: 'hi' }));
    await act(async () => {});
    const baselineAfterStructural = runs;
    expect(baselineAfterStructural).toBeGreaterThan(baseline);

    // Stream 10 tokens — structural selector body must not run again.
    for (let i = 0; i < 10; i += 1) {
      act(() => latestDispatch!({ type: 'chunk', nodeId: 'n1', assistantId: 'n1-a0', text: 't' }));
    }
    await act(async () => {});
    expect(runs).toBe(baselineAfterStructural);

    // A real structural change re-runs it.
    act(() => latestDispatch!({ type: 'create', nodeId: 'n2', projectId: 'p1' }));
    await act(async () => {});
    expect(runs).toBeGreaterThan(baselineAfterStructural);
    expect(lastTotal).toBe(2);
  });
});
