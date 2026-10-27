import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledRunTarget } from '../../../lib/electronBridge';
import { useScheduledRunOpening } from './useScheduledRunOpening';

type Notice = { title: string; subtitle: string; body: string; target: ScheduledRunTarget };

const state = vi.hoisted(() => ({
  bridge: null as null | {
    initialScheduledRun: ScheduledRunTarget | null;
    onScheduledRunOpen: (handler: (target: ScheduledRunTarget) => void) => () => void;
    onScheduledNotice: (handler: (notice: Notice) => void) => () => void;
  },
  openHandler: null as null | ((target: ScheduledRunTarget) => void),
  noticeHandler: null as null | ((notice: Notice) => void),
  reveal: vi.fn(),
  notify: vi.fn(),
  toastError: vi.fn(),
  requestDetail: vi.fn(),
  closeMetaAgent: vi.fn(),
}));

vi.mock('../../../lib/electronBridge', () => ({ getElectron: () => state.bridge }));
vi.mock('../../../state/chatStore', () => ({
  useChatActions: () => ({ revealBackendNode: (...args: unknown[]) => state.reveal(...args) }),
}));
vi.mock('../../../services/notifications', () => ({ notify: (...args: unknown[]) => state.notify(...args) }));
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => state.toastError(...args) } }));
vi.mock('./scheduledNav', () => ({ requestScheduledJobDetail: (...args: unknown[]) => state.requestDetail(...args) }));
// A notification opens its job even over the Meta agent page.
vi.mock('./metaAgent/metaAgentNav', () => ({ closeMetaAgentDetail: () => state.closeMetaAgent() }));

const target: ScheduledRunTarget = { runId: 'run-1', jobId: 'job-1', workspaceId: 'ws-1', nodeId: 'n-1' };

function installBridge(initial: ScheduledRunTarget | null = null): void {
  state.bridge = {
    initialScheduledRun: initial,
    onScheduledRunOpen: (handler) => { state.openHandler = handler; return () => { state.openHandler = null; }; },
    onScheduledNotice: (handler) => { state.noticeHandler = handler; return () => { state.noticeHandler = null; }; },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.bridge = null;
  state.openHandler = null;
  state.noticeHandler = null;
  state.reveal.mockResolvedValue(true);
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('useScheduledRunOpening', () => {
  it('opens the run a notification launched once the workspace hydrates, then clears the URL', async () => {
    window.history.replaceState(null, '', '/?michiWindowId=w1&michiOpenRun=run-1&michiOpenJob=job-1&michiOpenWorkspace=ws-1&michiOpenNode=n-1');
    installBridge(target);
    const onNav = vi.fn();
    const { rerender } = renderHook(({ hydrated }) => useScheduledRunOpening({ hydrated, onNav }), { initialProps: { hydrated: false } });
    expect(state.reveal).not.toHaveBeenCalled();

    rerender({ hydrated: true });
    await waitFor(() => expect(state.reveal).toHaveBeenCalledWith('ws-1', 'n-1'));
    expect(onNav).not.toHaveBeenCalled();
    expect(window.location.search).toBe('?michiWindowId=w1');

    // A later re-render does not reopen it.
    rerender({ hydrated: true });
    expect(state.reveal).toHaveBeenCalledTimes(1);
  });

  it('falls back to the job detail when the thread is gone', async () => {
    installBridge();
    state.reveal.mockResolvedValue(false);
    const onNav = vi.fn();
    renderHook(() => useScheduledRunOpening({ hydrated: true, onNav }));

    await act(async () => { state.openHandler?.(target); });
    await waitFor(() => expect(onNav).toHaveBeenCalledWith('scheduled'));
    expect(state.toastError).toHaveBeenCalledWith('That thread is no longer available');
    expect(state.closeMetaAgent).toHaveBeenCalledTimes(1);
    expect(state.requestDetail).toHaveBeenCalledWith('job-1');
  });

  it('shows the job without an error when the run never created a thread', async () => {
    installBridge();
    const onNav = vi.fn();
    renderHook(() => useScheduledRunOpening({ hydrated: true, onNav }));

    await act(async () => { state.openHandler?.({ ...target, nodeId: null }); });
    await waitFor(() => expect(onNav).toHaveBeenCalledWith('scheduled'));
    expect(state.reveal).not.toHaveBeenCalled();
    expect(state.toastError).not.toHaveBeenCalled();
  });

  it('queues a click that arrives before hydration', async () => {
    installBridge();
    const onNav = vi.fn();
    const { rerender } = renderHook(({ hydrated }) => useScheduledRunOpening({ hydrated, onNav }), { initialProps: { hydrated: false } });

    act(() => { state.openHandler?.(target); });
    expect(state.reveal).not.toHaveBeenCalled();
    rerender({ hydrated: true });
    await waitFor(() => expect(state.reveal).toHaveBeenCalledWith('ws-1', 'n-1'));
  });

  it('turns a focused-window notice into an in-app notification that opens the run', async () => {
    installBridge();
    renderHook(() => useScheduledRunOpening({ hydrated: true, onNav: vi.fn() }));

    act(() => { state.noticeHandler?.({ title: 'Ping check', subtitle: 'Succeeded', body: 'PONG', target }); });
    expect(state.notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Ping check · Succeeded', body: 'PONG' }));
    const { onClick } = state.notify.mock.calls[0][0] as { onClick: () => void };
    await act(async () => { onClick(); });
    expect(state.reveal).toHaveBeenCalledWith('ws-1', 'n-1');
  });

  it('detaches its bridge listeners on unmount', () => {
    installBridge();
    const { unmount } = renderHook(() => useScheduledRunOpening({ hydrated: true, onNav: vi.fn() }));
    expect(state.openHandler).not.toBeNull();
    unmount();
    expect(state.openHandler).toBeNull();
    expect(state.noticeHandler).toBeNull();
  });

  it('does nothing in a browser without the Electron bridge', () => {
    const onNav = vi.fn();
    renderHook(() => useScheduledRunOpening({ hydrated: true, onNav }));
    expect(state.reveal).not.toHaveBeenCalled();
    expect(onNav).not.toHaveBeenCalled();
  });
});
