import { act, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  usePanePresenceReporter,
  type PanePresenceBackendSlots,
  type PanePresenceIdResolver,
  type PanePresenceTransport,
  type RemovePresenceRequest,
  type SubmitPresenceRequest,
} from './usePanePresenceReporter';

const CONN = 'local';
const WORKSPACE = 'ws-1';
const WINDOW_ID = 'window-1';

function makeTransport(): PanePresenceTransport & {
  submitCalls: Array<{ connectionId: string; workspaceId: string; req: SubmitPresenceRequest }>;
  removeCalls: Array<{ connectionId: string; workspaceId: string; req: RemovePresenceRequest }>;
  keepaliveCalls: Array<{ connectionId: string; workspaceId: string; rendererLeaseId: string }>;
} {
  let leaseCounter = 0;
  const submitCalls: Array<{ connectionId: string; workspaceId: string; req: SubmitPresenceRequest }> = [];
  const removeCalls: Array<{ connectionId: string; workspaceId: string; req: RemovePresenceRequest }> = [];
  const keepaliveCalls: Array<{ connectionId: string; workspaceId: string; rendererLeaseId: string }> = [];

  return {
    submitCalls,
    removeCalls,
    keepaliveCalls,
    async submit(connectionId, workspaceId, req) {
      submitCalls.push({ connectionId, workspaceId, req });
      if (req.views.length === 0 && req.rendererLeaseId) {
        return { ok: false, code: 'EMPTY_SNAPSHOT_IGNORED', rendererLeaseId: req.rendererLeaseId };
      }
      const rendererLeaseId = req.rendererLeaseId ?? `lease-${connectionId}-${++leaseCounter}`;
      return { ok: true, rendererLeaseId, accepted: req.views.length, rejectedTargets: [] };
    },
    async remove(connectionId, workspaceId, req) {
      removeCalls.push({ connectionId, workspaceId, req });
      return { ok: true, removed: req.paneIds?.length ?? 1 };
    },
    async keepalive(connectionId, workspaceId, req) {
      keepaliveCalls.push({ connectionId, workspaceId, rendererLeaseId: req.rendererLeaseId });
      return { ok: true, renewedViews: 1 };
    },
  };
}

const resolveViewSource: PanePresenceIdResolver = (uiPaneId) => {
  if (uiPaneId.startsWith('pane:')) return undefined; // unresolvable surface kinds in these tests
  return { target: { kind: 'node', nodeId: uiPaneId } };
};

function backendSlot(overrides: Partial<PanePresenceBackendSlots> = {}): PanePresenceBackendSlots {
  return {
    backendConnectionId: CONN,
    workspaceId: WORKSPACE,
    openPanesMap: {},
    activeSlotKey: null,
    ...overrides,
  };
}

describe('usePanePresenceReporter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries rejected targets after node persistence catches up without a rerender', async () => {
    const transport = makeTransport();
    const submit = vi.spyOn(transport, 'submit');
    submit.mockResolvedValueOnce({ ok: true, rendererLeaseId: 'lease-retry', accepted: 0,
      rejectedTargets: [{ paneId: 'node:n1', reason: 'NOT_FOUND' }] });
    const backends = [backendSlot({ openPanesMap: { 'proj::tree-1': ['n1'] } })];
    const hook = renderHook(() => usePanePresenceReporter({ hydrated: true, windowId: WINDOW_ID, backends, resolveViewSource, transport }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(submit).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1][2].rendererLeaseId).toBe('lease-retry');
    await act(async () => { await vi.advanceTimersByTimeAsync(80_000); });
    expect(submit).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it('retries failed last-pane deletion and never keeps the ghost alive', async () => {
    const transport = makeTransport();
    const remove = vi.spyOn(transport, 'remove').mockRejectedValueOnce(new Error('offline'));
    const backends = [backendSlot({ openPanesMap: { 'proj::tree-1': ['n1'] } })];
    const hook = renderHook(({ slots }) => usePanePresenceReporter({ hydrated: true, windowId: WINDOW_ID, backends: slots, resolveViewSource, transport }), { initialProps: { slots: backends } });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    hook.rerender({ slots: [backendSlot()] });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(remove).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(80_000); });
    expect(remove).toHaveBeenCalledTimes(2);
    expect(transport.keepaliveCalls).toHaveLength(0);
    hook.unmount();
  });

  it('a delayed DELETE finishes before a reopened pane is registered again', async () => {
    const transport = makeTransport();
    let finishDelete!: (result: { ok: true; removed: number }) => void;
    vi.spyOn(transport, 'remove').mockImplementationOnce(() => new Promise((resolve) => { finishDelete = resolve; }));
    const backends = [backendSlot({ openPanesMap: { 'proj::tree-1': ['n1'] } })];
    const hook = renderHook(({ slots }) => usePanePresenceReporter({ hydrated: true, windowId: WINDOW_ID, backends: slots, resolveViewSource, transport }), { initialProps: { slots: backends } });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    hook.rerender({ slots: [backendSlot()] });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    hook.rerender({ slots: backends });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(transport.submitCalls).toHaveLength(1);
    finishDelete({ ok: true, removed: 1 });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(transport.submitCalls).toHaveLength(2);
    expect(transport.submitCalls[1].req.views[0].paneId).toBe('node:n1');
    hook.unmount();
  });

  it('registers the surviving StrictMode mount and removes only the retired mount lease', async () => {
    const transport = makeTransport();
    let finishRetiredSubmit!: (result: { ok: true; rendererLeaseId: string; accepted: number; rejectedTargets: [] }) => void;
    const submit = vi.spyOn(transport, 'submit').mockImplementationOnce(() => new Promise((resolve) => { finishRetiredSubmit = resolve; }));
    const backends = [backendSlot({ openPanesMap: { 'proj::tree-1': ['n1'] } })];
    const hook = renderHook(() => usePanePresenceReporter({ hydrated: true, windowId: WINDOW_ID, backends, resolveViewSource, transport }), { wrapper: StrictMode });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(submit).toHaveBeenCalledTimes(2);
    finishRetiredSubmit({ ok: true, rendererLeaseId: 'retired-lease', accepted: 1, rejectedTargets: [] });
    await act(async () => { await vi.advanceTimersByTimeAsync(80_000); });
    expect(transport.removeCalls.map((call) => call.req.rendererLeaseId)).toEqual(['retired-lease']);
    expect(transport.keepaliveCalls.length).toBeGreaterThan(0);
    expect(transport.keepaliveCalls.every((call) => call.rendererLeaseId === 'lease-local-1')).toBe(true);
    hook.unmount();
    expect(transport.removeCalls.map((call) => call.req.rendererLeaseId)).toEqual(['retired-lease', 'lease-local-1']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses independent leases for two workspaces on the same backend', async () => {
    const transport = makeTransport();
    const backends = [
      backendSlot({ workspaceId: 'ws-a', openPanesMap: { 'ws-a::workspace': ['n1'] } }),
      backendSlot({ workspaceId: 'ws-b', openPanesMap: { 'ws-b::workspace': ['n2'] } }),
    ];
    const hook = renderHook(() => usePanePresenceReporter({ hydrated: true, windowId: WINDOW_ID, backends, resolveViewSource, transport }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(transport.submitCalls.map((call) => call.workspaceId)).toEqual(['ws-a', 'ws-b']);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(transport.keepaliveCalls.map((call) => call.workspaceId)).toEqual(['ws-a', 'ws-b']);
    expect(new Set(transport.keepaliveCalls.map((call) => call.rendererLeaseId)).size).toBe(2);
    hook.unmount();
  });

  it('submits nothing if hydration failed (never observably different from not-yet-hydrated)', async () => {
    const transport = makeTransport();
    const backends = [backendSlot({
      openPanesMap: { 'proj::tree-1': ['n1'] },
      activeSlotKey: 'proj::tree-1',
    })];

    const { rerender } = renderHook(
      ({ hydrated }: { hydrated: boolean }) => usePanePresenceReporter({
        hydrated,
        windowId: WINDOW_ID,
        backends,
        resolveViewSource,
        transport,
      }),
      { initialProps: { hydrated: false } },
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    // Simulate several failed hydration attempts (retried forever, per R5 §7) — hydrated stays
    // false throughout.
    rerender({ hydrated: false });
    rerender({ hydrated: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(transport.submitCalls).toHaveLength(0);
  });

  it('first submission after hydration carries every open pane across all slots, visible true only for the active slot', async () => {
    const transport = makeTransport();
    const backends = [backendSlot({
      openPanesMap: {
        'proj::tree-1': ['n1', 'n2'],
        'proj::tree-2': ['n3'],
      },
      activeSlotKey: 'proj::tree-1',
    })];

    renderHook(() => usePanePresenceReporter({
      hydrated: true,
      windowId: WINDOW_ID,
      backends,
      resolveViewSource,
      transport,
    }));

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(transport.submitCalls).toHaveLength(1);
    const { req } = transport.submitCalls[0];
    expect(req.windowId).toBe(WINDOW_ID);
    expect(req.rendererLeaseId).toBeUndefined();
    expect(req.views).toHaveLength(3);

    const byPaneId = new Map(req.views.map((v) => [v.paneId, v]));
    expect(byPaneId.get('node:n1')?.visible).toBe(true);
    expect(byPaneId.get('node:n2')?.visible).toBe(true);
    expect(byPaneId.get('node:n3')?.visible).toBe(false);
    expect(byPaneId.get('node:n3')?.treeId).toBe('tree-2');
  });

  it('switching tree changes visible and sends no DELETE', async () => {
    const transport = makeTransport();
    const backends: PanePresenceBackendSlots[] = [backendSlot({
      openPanesMap: {
        'proj::tree-1': ['n1'],
        'proj::tree-2': ['n2'],
      },
      activeSlotKey: 'proj::tree-1',
    })];

    const { rerender } = renderHook(
      ({ backends: b }: { backends: PanePresenceBackendSlots[] }) => usePanePresenceReporter({
        hydrated: true,
        windowId: WINDOW_ID,
        backends: b,
        resolveViewSource,
        transport,
      }),
      { initialProps: { backends } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(transport.submitCalls).toHaveLength(1);

    // Switch active slot to tree-2; both panes remain open, only visibility flips.
    const switched: PanePresenceBackendSlots[] = [backendSlot({
      openPanesMap: {
        'proj::tree-1': ['n1'],
        'proj::tree-2': ['n2'],
      },
      activeSlotKey: 'proj::tree-2',
    })];
    rerender({ backends: switched });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(transport.submitCalls).toHaveLength(2);
    expect(transport.removeCalls).toHaveLength(0);
    const secondReq = transport.submitCalls[1].req;
    const byPaneId = new Map(secondReq.views.map((v) => [v.paneId, v]));
    expect(byPaneId.get('node:n1')?.visible).toBe(false);
    expect(byPaneId.get('node:n2')?.visible).toBe(true);
    // The second submission reuses the lease id the first submission's response allocated.
    expect(secondReq.rendererLeaseId).toBeTruthy();
  });

  it('closing one pane of several sends a DELETE naming it', async () => {
    const transport = makeTransport();
    const backends: PanePresenceBackendSlots[] = [backendSlot({
      openPanesMap: { 'proj::tree-1': ['n1', 'n2'] },
      activeSlotKey: 'proj::tree-1',
    })];

    const { rerender } = renderHook(
      ({ backends: b }: { backends: PanePresenceBackendSlots[] }) => usePanePresenceReporter({
        hydrated: true,
        windowId: WINDOW_ID,
        backends: b,
        resolveViewSource,
        transport,
      }),
      { initialProps: { backends } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(transport.submitCalls).toHaveLength(1);

    rerender({ backends: [backendSlot({
      openPanesMap: { 'proj::tree-1': ['n1'] },
      activeSlotKey: 'proj::tree-1',
    })] });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(transport.removeCalls).toHaveLength(1);
    expect(transport.removeCalls[0].req.paneIds).toEqual(['node:n2']);
    expect(transport.removeCalls[0].req.rendererLeaseId).toBeTruthy();
  });

  it('two backends get two independent leases, each renewed on its own connection', async () => {
    const transport = makeTransport();
    const backends: PanePresenceBackendSlots[] = [
      backendSlot({ backendConnectionId: 'local', openPanesMap: { 'proj::tree-1': ['n1'] }, activeSlotKey: 'proj::tree-1' }),
      backendSlot({ backendConnectionId: 'remote-1', workspaceId: 'ws-2', openPanesMap: { 'proj2::tree-1': ['n2'] }, activeSlotKey: 'proj2::tree-1' }),
    ];

    renderHook(() => usePanePresenceReporter({
      hydrated: true,
      windowId: WINDOW_ID,
      backends,
      resolveViewSource,
      transport,
    }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(transport.submitCalls).toHaveLength(2);
    expect(new Set(transport.submitCalls.map((c) => c.connectionId))).toEqual(new Set(['local', 'remote-1']));

    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(transport.keepaliveCalls).toHaveLength(2);
    const byConnection = new Map(transport.keepaliveCalls.map((c) => [c.connectionId, c.rendererLeaseId]));
    expect(byConnection.get('local')).toBeTruthy();
    expect(byConnection.get('remote-1')).toBeTruthy();
    expect(byConnection.get('local')).not.toBe(byConnection.get('remote-1'));
  });

  it('serializes initial submissions and reuses the allocated lease for the newest snapshot', async () => {
    // Models a rapid pane-state change dispatching a second submit while the first is still
    // in flight — no reacquire, no keepalive failure, just two ordinary render-driven PUTs. The
    // FIRST dispatched request resolves SECOND (out of order). Without a per-dispatch
    // generation bump, the first response's rendererLeaseId/viewRevision would still apply
    // after the second, more recent response already installed the fresher lease.
    const transport = makeTransport();
    let resolveFirst: ((result: Awaited<ReturnType<PanePresenceTransport['submit']>>) => void) | undefined;
    let resolveSecond: ((result: Awaited<ReturnType<PanePresenceTransport['submit']>>) => void) | undefined;
    let callCount = 0;
    transport.submit = async (connectionId, workspaceId, req) => {
      transport.submitCalls.push({ connectionId, workspaceId, req });
      callCount += 1;
      if (callCount === 1) {
        return new Promise((resolve) => { resolveFirst = resolve; });
      }
      return new Promise((resolve) => { resolveSecond = resolve; });
    };

    const backends: PanePresenceBackendSlots[] = [backendSlot({
      openPanesMap: { 'proj::tree-1': ['n1'] },
      activeSlotKey: 'proj::tree-1',
    })];

    const { rerender } = renderHook(
      ({ backends: b }: { backends: PanePresenceBackendSlots[] }) => usePanePresenceReporter({
        hydrated: true,
        windowId: WINDOW_ID,
        backends: b,
        resolveViewSource,
        transport,
      }),
      { initialProps: { backends } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(transport.submitCalls).toHaveLength(1);

    // Trigger a second, normal submit dispatch (a pane opened) while the first is still hanging.
    rerender({ backends: [backendSlot({
      openPanesMap: { 'proj::tree-1': ['n1', 'n2'] },
      activeSlotKey: 'proj::tree-1',
    })] });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(transport.submitCalls).toHaveLength(1);
    expect(resolveFirst).toBeTruthy();
    expect(resolveSecond).toBeUndefined();

    resolveFirst?.({ ok: true, rendererLeaseId: 'lease-only', accepted: 1, rejectedTargets: [] });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(transport.submitCalls).toHaveLength(2);
    expect(transport.submitCalls[1].req.rendererLeaseId).toBe('lease-only');
    expect(transport.submitCalls[1].req.views.map((v) => v.paneId)).toEqual(['node:n1', 'node:n2']);
    resolveSecond?.({ ok: true, rendererLeaseId: 'lease-only', accepted: 2, rejectedTargets: [] });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // Confirm the newest response's lease is what the next keepalive actually uses.
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(transport.keepaliveCalls).toHaveLength(1);
    expect(transport.keepaliveCalls[0].rendererLeaseId).toBe('lease-only');
  });

  describe('keepalive NOT_FOUND recovery', () => {
    it('drops the dead lease without a forced empty PUT when nothing is open at reacquire time', async () => {
      const transport = makeTransport();
      let openPanesMap: Record<string, string[]> = { 'proj::tree-1': ['n1'] };
      const backends: PanePresenceBackendSlots[] = [{
        backendConnectionId: CONN,
        workspaceId: WORKSPACE,
        get openPanesMap() { return openPanesMap; },
        get activeSlotKey() { return Object.keys(openPanesMap).length > 0 ? 'proj::tree-1' : null; },
      } as unknown as PanePresenceBackendSlots];

      renderHook(() => usePanePresenceReporter({
        hydrated: true,
        windowId: WINDOW_ID,
        backends,
        resolveViewSource,
        transport,
      }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(transport.submitCalls).toHaveLength(1);

      // The pane closed since the last render-driven submission (e.g. the tab was hidden and
      // pane state changed without a matching rerender reaching this hook yet).
      openPanesMap = {};

      transport.keepalive = async (connectionId, workspaceId, req) => {
        transport.keepaliveCalls.push({ connectionId, workspaceId, rendererLeaseId: req.rendererLeaseId });
        return { ok: false, code: 'NOT_FOUND' };
      };

      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });

      // No PUT was sent for the (now legitimately empty) reacquire attempt.
      expect(transport.submitCalls).toHaveLength(1);
    });

    it('defers keepalive recovery until the pending lease mutation has settled', async () => {
      const transport = makeTransport();
      const backends: PanePresenceBackendSlots[] = [backendSlot({
        openPanesMap: { 'proj::tree-1': ['n1'] },
        activeSlotKey: 'proj::tree-1',
      })];

      // A submit that never resolves until released manually, to model a slow/in-flight request
      // that outlives a reacquire triggered by a concurrent keepalive failure. Only the SECOND
      // dispatched submit hangs — the first (initial registration) and third (the reacquire)
      // resolve normally, so the race is isolated to exactly the in-flight call under test.
      let releaseSlowSubmit: (() => void) | undefined;
      let slowSubmitCallCount = 0;
      const originalSubmit = transport.submit.bind(transport);
      transport.submit = async (connectionId, workspaceId, req) => {
        slowSubmitCallCount += 1;
        if (slowSubmitCallCount === 2) {
          // Hang until explicitly released, but still record the call immediately so later
          // assertions can see it was dispatched.
          transport.submitCalls.push({ connectionId, workspaceId, req });
          await new Promise<void>((resolve) => { releaseSlowSubmit = resolve; });
          if (req.views.length === 0 && req.rendererLeaseId) {
            return { ok: false, code: 'EMPTY_SNAPSHOT_IGNORED', rendererLeaseId: req.rendererLeaseId };
          }
          const rendererLeaseId = req.rendererLeaseId ?? 'lease-stale-response';
          return { ok: true, rendererLeaseId, accepted: req.views.length, rejectedTargets: [] };
        }
        return originalSubmit(connectionId, workspaceId, req);
      };

      const { rerender } = renderHook(
        ({ backends: b }: { backends: PanePresenceBackendSlots[] }) => usePanePresenceReporter({
          hydrated: true,
          windowId: WINDOW_ID,
          backends: b,
          resolveViewSource,
          transport,
        }),
        { initialProps: { backends } },
      );
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(transport.submitCalls).toHaveLength(1);
      const originalLeaseId = transport.submitCalls[0].req.rendererLeaseId; // undefined on the first call

      // Trigger a second submit that will hang (in-flight, pre-dating the reacquire below).
      rerender({ backends: [backendSlot({
        openPanesMap: { 'proj::tree-1': ['n1', 'n2'] },
        activeSlotKey: 'proj::tree-1',
      })] });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(slowSubmitCallCount).toBe(2);

      // While that second submit is still hanging, a keepalive NOT_FOUND fires and reacquires a
      // brand-new lease.
      transport.keepalive = async (connectionId, workspaceId, req) => {
        transport.keepaliveCalls.push({ connectionId, workspaceId, rendererLeaseId: req.rendererLeaseId });
        return { ok: false, code: 'NOT_FOUND' };
      };
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });

      expect(transport.keepaliveCalls).toHaveLength(0);
      expect(transport.submitCalls).toHaveLength(2);

      // Now release the stale in-flight submit's response. Its resolution must not overwrite
      // the freshly-reacquired lease.
      expect(releaseSlowSubmit).toBeTruthy();
      releaseSlowSubmit?.();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      const reacquireSubmit = transport.submitCalls.find((c, i) => i > 1 && c.req.rendererLeaseId === undefined);
      expect(reacquireSubmit).toBeTruthy();

      // A subsequent keepalive tick still uses the NEW lease id (from the reacquire), not the
      // ORIGINAL lease id the stale in-flight submit's response would have reinstated had the
      // generation guard not been in place.
      transport.keepalive = async (connectionId, workspaceId, req) => {
        transport.keepaliveCalls.push({ connectionId, workspaceId, rendererLeaseId: req.rendererLeaseId });
        return { ok: true, renewedViews: 1 };
      };
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      const lastKeepalive = transport.keepaliveCalls[transport.keepaliveCalls.length - 1];
      // The stale call's own returned leaseId ('lease-local-1', from the FIRST successful
      // submission it echoed back) must never win over whatever the reacquire actually
      // installed — assert both the negative (not the stale/original id) and the positive
      // (the keepalive is using SOME lease at all, i.e. recovery genuinely completed).
      expect(lastKeepalive.rendererLeaseId).toBeTruthy();
      expect(lastKeepalive.rendererLeaseId).not.toBe(originalLeaseId);
      expect(lastKeepalive.rendererLeaseId).not.toBe('lease-local-1');
    });
  });

  describe('onLeaseInvalidated callback', () => {
    it('is invoked synchronously before the forced reacquire recomputes, with connectionId and workspaceId', async () => {
      const transport = makeTransport();
      const backends: PanePresenceBackendSlots[] = [backendSlot({
        openPanesMap: { 'proj::tree-1': ['n1'] },
        activeSlotKey: 'proj::tree-1',
      })];

      const callOrder: string[] = [];
      const onLeaseInvalidated = vi.fn((connectionId: string, workspaceId: string) => {
        callOrder.push('onLeaseInvalidated');
        expect(connectionId).toBe(CONN);
        expect(workspaceId).toBe(WORKSPACE);
      });

      renderHook(() => usePanePresenceReporter({
        hydrated: true,
        windowId: WINDOW_ID,
        backends,
        resolveViewSource,
        transport,
        onLeaseInvalidated,
      }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(transport.submitCalls).toHaveLength(1);

      transport.keepalive = async (connectionId, workspaceId, req) => {
        transport.keepaliveCalls.push({ connectionId, workspaceId, rendererLeaseId: req.rendererLeaseId });
        callOrder.push('keepaliveResolved');
        return { ok: false, code: 'NOT_FOUND' };
      };

      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });

      expect(onLeaseInvalidated).toHaveBeenCalledTimes(1);
      expect(onLeaseInvalidated).toHaveBeenCalledWith(CONN, WORKSPACE);
      // A reacquire submit was dispatched — proving the callback ran BEFORE (not instead of)
      // the recovery path continued.
      expect(transport.submitCalls).toHaveLength(2);
      expect(transport.submitCalls[1].req.rendererLeaseId).toBeUndefined();
      // The callback fired as part of handling the keepalive's own resolved response, strictly
      // after that response arrived.
      expect(callOrder).toEqual(['keepaliveResolved', 'onLeaseInvalidated']);
    });

    it('callback ordering: a synchronous side effect inside the callback is visible before the reacquire submit reads it', async () => {
      // Verifies the callback runs BEFORE this hook recomputes/dispatches its forced reacquire
      // by having the callback itself synchronously mutate state that the resolver reads —
      // if the callback ran after (or concurrently with, via a missed microtask) the reacquire's
      // view computation, the mutation would not be visible to that computation.
      const transport = makeTransport();
      const registeredSurfaces = new Set<string>(['pane:terminal:abc']);
      const resolverWithSurfaces: PanePresenceIdResolver = (uiPaneId) => {
        if (uiPaneId.startsWith('pane:')) {
          if (!registeredSurfaces.has(uiPaneId)) return undefined; // cleared -> unresolvable
          return { target: { kind: 'surface', registrationId: 'reg-abc' } };
        }
        return { target: { kind: 'node', nodeId: uiPaneId } };
      };

      const backends: PanePresenceBackendSlots[] = [backendSlot({
        openPanesMap: { 'proj::tree-1': ['n1', 'pane:terminal:abc'] },
        activeSlotKey: 'proj::tree-1',
      })];

      const onLeaseInvalidated = vi.fn(() => {
        // Synchronously invalidate the stale surface registration, exactly as production
        // mounting code would after a backend restart drops server-side allocations.
        registeredSurfaces.delete('pane:terminal:abc');
      });

      renderHook(() => usePanePresenceReporter({
        hydrated: true,
        windowId: WINDOW_ID,
        backends,
        resolveViewSource: resolverWithSurfaces,
        transport,
        onLeaseInvalidated,
      }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(transport.submitCalls).toHaveLength(1);
      expect(transport.submitCalls[0].req.views).toHaveLength(2);

      transport.keepalive = async (connectionId, workspaceId, req) => {
        transport.keepaliveCalls.push({ connectionId, workspaceId, rendererLeaseId: req.rendererLeaseId });
        return { ok: false, code: 'NOT_FOUND' };
      };
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });

      expect(onLeaseInvalidated).toHaveBeenCalledTimes(1);
      expect(transport.submitCalls).toHaveLength(2);
      const reacquireReq = transport.submitCalls[1].req;
      // The surface pane is no longer resolvable because the callback's synchronous mutation
      // was already visible when this reacquire's view computation ran — proving the callback
      // executed strictly before that computation, not after or interleaved with it.
      expect(reacquireReq.views).toHaveLength(1);
      expect(reacquireReq.views.some((v) => v.uiPaneId === 'pane:terminal:abc')).toBe(false);
    });

    it('continues lease reacquisition when the optional invalidation callback throws', async () => {
      const transport = makeTransport();
      const backends: PanePresenceBackendSlots[] = [backendSlot({
        openPanesMap: { 'proj::tree-1': ['n1'] },
        activeSlotKey: 'proj::tree-1',
      })];
      transport.keepalive = async (connectionId, workspaceId, req) => {
        transport.keepaliveCalls.push({ connectionId, workspaceId, rendererLeaseId: req.rendererLeaseId });
        return { ok: false, code: 'NOT_FOUND' };
      };

      renderHook(() => usePanePresenceReporter({
        hydrated: true,
        windowId: WINDOW_ID,
        backends,
        resolveViewSource,
        transport,
        onLeaseInvalidated: () => { throw new Error('cache cleanup failed'); },
      }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(transport.submitCalls).toHaveLength(1);

      await expect(act(async () => { await vi.advanceTimersByTimeAsync(20_000); })).resolves.not.toThrow();
      expect(transport.submitCalls).toHaveLength(2);
      expect(transport.submitCalls[1].req.rendererLeaseId).toBeUndefined();
    });
  });
});
