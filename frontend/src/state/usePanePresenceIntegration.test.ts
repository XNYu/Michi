/**
 * Focused tests for `usePanePresenceIntegration` — capability gate, node/agent-run mapping,
 * all-slot visibility (every tree of the active project, not just the visible slot), and
 * server-side surface allocation for one non-persistent PaneItem kind.
 *
 * Uses `@testing-library/react`'s `renderHook` directly against the hook (not through
 * `ChatProvider`) so these stay fast, isolated unit tests of the integration wiring itself —
 * matching this file's sibling `usePanePresenceReporter.test.ts`'s own approach of exercising the
 * hook via a fake transport rather than the full store.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePanePresenceIntegration } from './usePanePresenceIntegration';
import type { Project } from './chatTypes';
import type { PaneItem } from './paneItems';
import * as persistenceApi from '../services/api/persistence';
import * as panePresenceApi from '../services/api/panePresence';
import { setPanePresenceDashboardVisible } from './panePresenceVisibility';

const WINDOW_ID = 'window-1';
const CONN = 'local';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Project 1',
    backendConnectionId: CONN,
    chatIds: ['root-1'],
    edges: [],
    createdAt: 0,
    trees: [{ id: 'tree-1', rootNodeId: 'root-1', createdAt: 0, lastActiveAt: 0 }],
    activeTreeId: 'tree-1',
    ...overrides,
  };
}

function capabilities(paneInspection: unknown) {
  return {
    protocolVersion: 1,
    authoritativeTurnPersistence: true,
    durableNodePrerequisite: true,
    explicitCommands: true,
    backgroundWorkspaceSync: true,
    legacySyncAccepted: true,
    paneInspection,
  };
}

describe('usePanePresenceIntegration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setPanePresenceDashboardVisible(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('capability gate: keeps backends empty (no submit) until the probe resolves paneInspection: v1', async () => {
    const probe = vi.spyOn(persistenceApi, 'fetchPersistenceCapabilities')
      .mockResolvedValue(capabilities('v1'));
    const submitSpy = vi.spyOn(panePresenceApi.panePresenceTransport, 'submit')
      .mockResolvedValue({ ok: true, rendererLeaseId: 'lease-1', accepted: 1, rejectedTargets: [] });

    const project = makeProject();
    renderHook(() => usePanePresenceIntegration({
      windowId: WINDOW_ID,
      hydrated: true,
      projects: [project],
      activeProjectId: project.id,
      activeBackendConnectionId: CONN,
      openPanesMap: { [`${project.id}::tree-1`]: ['root-1'] },
      paneItems: {},
    }));

    // Before the probe resolves, nothing is submitted.
    expect(submitSpy).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(probe).toHaveBeenCalledWith(CONN);
    expect(submitSpy).toHaveBeenCalledTimes(1);
    const [, , req] = submitSpy.mock.calls[0];
    expect(req.views).toEqual([expect.objectContaining({ paneId: 'node:root-1' })]);
  });

  it('navigation away from Dashboard keeps panes open but reports them invisible', async () => {
    vi.spyOn(persistenceApi, 'fetchPersistenceCapabilities').mockResolvedValue(capabilities('v1'));
    const submit = vi.spyOn(panePresenceApi.panePresenceTransport, 'submit')
      .mockResolvedValue({ ok: true, rendererLeaseId: 'lease-visible', accepted: 1, rejectedTargets: [] });
    const project = makeProject();
    const projects = [project];
    const openPanesMap = { [`${project.id}::tree-1`]: ['root-1'] };
    const paneItems = {};
    const hook = renderHook(() => usePanePresenceIntegration({ windowId: WINDOW_ID, hydrated: true, projects,
      activeProjectId: project.id, activeBackendConnectionId: CONN, openPanesMap, paneItems }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(submit.mock.calls.at(-1)![2].views[0].visible).toBe(true);
    await act(async () => { setPanePresenceDashboardVisible(false); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(submit.mock.calls.at(-1)![2].views).toEqual([expect.objectContaining({ paneId: 'node:root-1', visible: false })]);
    hook.unmount();
  });

  it('reallocates a surface when its kind changes without changing its UI pane id', async () => {
    vi.spyOn(persistenceApi, 'fetchPersistenceCapabilities').mockResolvedValue(capabilities('v1'));
    const allocate = vi.spyOn(panePresenceApi, 'allocateSurfaceRegistration')
      .mockResolvedValueOnce({ registrationId: 'launcher-registration', paneId: 'surface:launcher-registration' })
      .mockResolvedValueOnce({ registrationId: 'terminal-registration', paneId: 'surface:terminal-registration' });
    const submit = vi.spyOn(panePresenceApi.panePresenceTransport, 'submit')
      .mockResolvedValue({ ok: true, rendererLeaseId: 'surface-lease', accepted: 1, rejectedTargets: [] });
    vi.spyOn(panePresenceApi.panePresenceTransport, 'remove').mockResolvedValue({ ok: true, removed: 1 });
    const project = makeProject();
    const projects = [project];
    const id = 'pane:launcher:same-id';
    const openPanesMap = { [`${project.id}::tree-1`]: [id] };
    const launcher: PaneItem = { id, projectId: project.id, treeId: 'tree-1', kind: 'launcher', title: 'New pane', createdAt: 1 };
    const hook = renderHook<void, { item: PaneItem }>(({ item }) => usePanePresenceIntegration({ windowId: WINDOW_ID, hydrated: true, projects,
      activeProjectId: project.id, activeBackendConnectionId: CONN, openPanesMap, paneItems: { [id]: item } }), { initialProps: { item: launcher } });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(allocate).toHaveBeenCalledTimes(1);
    hook.rerender({ item: { ...launcher, kind: 'terminal', surfaceId: 'pty', cwd: '/tmp' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(allocate).toHaveBeenLastCalledWith(CONN, project.id, 'terminal');
    expect(submit.mock.calls.at(-1)![2].views[0].paneId).toBe('surface:terminal-registration');
    hook.unmount();
  });

  it('capability gate: a probe failure never submits (never claims an empty pane list)', async () => {
    vi.spyOn(persistenceApi, 'fetchPersistenceCapabilities').mockRejectedValue(new Error('old gateway'));
    const submitSpy = vi.spyOn(panePresenceApi.panePresenceTransport, 'submit');

    const project = makeProject();
    renderHook(() => usePanePresenceIntegration({
      windowId: WINDOW_ID,
      hydrated: true,
      projects: [project],
      activeProjectId: project.id,
      activeBackendConnectionId: CONN,
      openPanesMap: { [`${project.id}::tree-1`]: ['root-1'] },
      paneItems: {},
    }));

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('capability gate: paneInspection omitted (old gateway) never submits', async () => {
    vi.spyOn(persistenceApi, 'fetchPersistenceCapabilities').mockResolvedValue(capabilities(undefined));
    const submitSpy = vi.spyOn(panePresenceApi.panePresenceTransport, 'submit');

    const project = makeProject();
    renderHook(() => usePanePresenceIntegration({
      windowId: WINDOW_ID,
      hydrated: true,
      projects: [project],
      activeProjectId: project.id,
      activeBackendConnectionId: CONN,
      openPanesMap: { [`${project.id}::tree-1`]: ['root-1'] },
      paneItems: {},
    }));

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('resolves a bare chat id to node:{nodeId} and an agent-run PaneItem to run:{runId}', async () => {
    vi.spyOn(persistenceApi, 'fetchPersistenceCapabilities').mockResolvedValue(capabilities('v1'));
    const submitSpy = vi.spyOn(panePresenceApi.panePresenceTransport, 'submit')
      .mockResolvedValue({ ok: true, rendererLeaseId: 'lease-1', accepted: 2, rejectedTargets: [] });

    const project = makeProject();
    const runPaneId = 'pane:agent-run:local:run-42';
    const paneItems: Record<string, PaneItem> = {
      [runPaneId]: {
        id: runPaneId,
        kind: 'agent-run',
        projectId: project.id,
        treeId: null,
        title: 'Agent Run',
        createdAt: 0,
        backendConnectionId: CONN,
        runId: 'run-42',
      },
    };

    renderHook(() => usePanePresenceIntegration({
      windowId: WINDOW_ID,
      hydrated: true,
      projects: [project],
      activeProjectId: project.id,
      activeBackendConnectionId: CONN,
      openPanesMap: { [`${project.id}::tree-1`]: ['root-1', runPaneId] },
      paneItems,
    }));

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(submitSpy).toHaveBeenCalledTimes(1);
    const [, , req] = submitSpy.mock.calls[0];
    const paneIds = req.views.map((v) => v.paneId).sort();
    expect(paneIds).toEqual(['node:root-1', 'run:run-42']);
  });

  it('reports every open pane slot of the active project across every tree, not just the visible one', async () => {
    vi.spyOn(persistenceApi, 'fetchPersistenceCapabilities').mockResolvedValue(capabilities('v1'));
    const submitSpy = vi.spyOn(panePresenceApi.panePresenceTransport, 'submit')
      .mockResolvedValue({ ok: true, rendererLeaseId: 'lease-1', accepted: 2, rejectedTargets: [] });

    const project = makeProject({
      trees: [
        { id: 'tree-1', rootNodeId: 'root-1', createdAt: 0, lastActiveAt: 0 },
        { id: 'tree-2', rootNodeId: 'root-2', createdAt: 0, lastActiveAt: 0 },
      ],
      activeTreeId: 'tree-1', // tree-1 is visible; tree-2 is a background tab.
    });

    renderHook(() => usePanePresenceIntegration({
      windowId: WINDOW_ID,
      hydrated: true,
      projects: [project],
      activeProjectId: project.id,
      activeBackendConnectionId: CONN,
      openPanesMap: {
        [`${project.id}::tree-1`]: ['root-1'],
        [`${project.id}::tree-2`]: ['root-2'],
      },
      paneItems: {},
    }));

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(submitSpy).toHaveBeenCalledTimes(1);
    const [, , req] = submitSpy.mock.calls[0];
    const byPaneId = new Map(req.views.map((v) => [v.paneId, v]));
    expect(byPaneId.get('node:root-1')?.visible).toBe(true); // active/visible slot
    expect(byPaneId.get('node:root-2')?.visible).toBe(false); // background tree — still reported
    expect(byPaneId.size).toBe(2);
  });

  it('reports panes from a project that is NOT active as absent (single active-workspace scope)', async () => {
    vi.spyOn(persistenceApi, 'fetchPersistenceCapabilities').mockResolvedValue(capabilities('v1'));
    const submitSpy = vi.spyOn(panePresenceApi.panePresenceTransport, 'submit')
      .mockResolvedValue({ ok: true, rendererLeaseId: 'lease-1', accepted: 1, rejectedTargets: [] });

    const activeProject = makeProject({ id: 'proj-active' });
    const otherProject = makeProject({ id: 'proj-other', trees: [{ id: 'tree-x', rootNodeId: 'root-x', createdAt: 0, lastActiveAt: 0 }], activeTreeId: 'tree-x' });

    renderHook(() => usePanePresenceIntegration({
      windowId: WINDOW_ID,
      hydrated: true,
      projects: [activeProject, otherProject],
      activeProjectId: activeProject.id,
      activeBackendConnectionId: CONN,
      openPanesMap: {
        [`${activeProject.id}::tree-1`]: ['root-1'],
        [`${otherProject.id}::tree-x`]: ['root-x'],
      },
      paneItems: {},
    }));

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(submitSpy).toHaveBeenCalledTimes(1);
    const [, , req] = submitSpy.mock.calls[0];
    expect(req.views.map((v) => v.paneId)).toEqual(['node:root-1']);
  });

  it('allocates a server-side surface registration for a non-persistent PaneItem kind and reports surface:{registrationId}', async () => {
    vi.spyOn(persistenceApi, 'fetchPersistenceCapabilities').mockResolvedValue(capabilities('v1'));
    const allocateSpy = vi.spyOn(panePresenceApi, 'allocateSurfaceRegistration')
      .mockResolvedValue({ registrationId: 'reg-1', paneId: 'surface:reg-1' });
    const submitSpy = vi.spyOn(panePresenceApi.panePresenceTransport, 'submit')
      .mockResolvedValue({ ok: true, rendererLeaseId: 'lease-1', accepted: 1, rejectedTargets: [] });

    const project = makeProject();
    const terminalPaneId = 'pane:terminal:abc';
    const paneItems: Record<string, PaneItem> = {
      [terminalPaneId]: {
        id: terminalPaneId,
        kind: 'terminal',
        projectId: project.id,
        treeId: 'tree-1',
        title: 'Terminal',
        createdAt: 0,
        surfaceId: 'surf-1',
        cwd: '/tmp',
      },
    };

    renderHook(() => usePanePresenceIntegration({
      windowId: WINDOW_ID,
      hydrated: true,
      projects: [project],
      activeProjectId: project.id,
      activeBackendConnectionId: CONN,
      openPanesMap: { [`${project.id}::tree-1`]: [terminalPaneId] },
      paneItems,
    }));

    // Allocation happens in its own effect; give it a tick before the submission effect runs.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(allocateSpy).toHaveBeenCalledTimes(1);
    expect(allocateSpy).toHaveBeenCalledWith(CONN, project.id, 'terminal');
    // The reporter may submit once before allocation resolves (empty view set — the surface pane
    // has no id yet) and again once the registration lands; only the LAST submission matters here.
    expect(submitSpy).toHaveBeenCalled();
    const [, , req] = submitSpy.mock.calls.at(-1)!;
    expect(req.views).toEqual([expect.objectContaining({ paneId: 'surface:reg-1' })]);
  });

  it('dedupes concurrent allocation attempts for the same {connection, workspace, uiPaneId}', async () => {
    vi.spyOn(persistenceApi, 'fetchPersistenceCapabilities').mockResolvedValue(capabilities('v1'));
    let resolveAllocate: ((value: { registrationId: string; paneId: string }) => void) | null = null;
    const allocateSpy = vi.spyOn(panePresenceApi, 'allocateSurfaceRegistration')
      .mockImplementation(() => new Promise((resolve) => { resolveAllocate = resolve; }));
    vi.spyOn(panePresenceApi.panePresenceTransport, 'submit')
      .mockResolvedValue({ ok: true, rendererLeaseId: 'lease-1', accepted: 1, rejectedTargets: [] });

    const project = makeProject();
    const terminalPaneId = 'pane:terminal:abc';
    const paneItems: Record<string, PaneItem> = {
      [terminalPaneId]: {
        id: terminalPaneId, kind: 'terminal', projectId: project.id, treeId: 'tree-1',
        title: 'Terminal', createdAt: 0, surfaceId: 'surf-1', cwd: '/tmp',
      },
    };

    const { rerender } = renderHook(
      (openPanesMap: Record<string, string[]>) => usePanePresenceIntegration({
        windowId: WINDOW_ID,
        hydrated: true,
        projects: [project],
        activeProjectId: project.id,
        activeBackendConnectionId: CONN,
        openPanesMap,
        paneItems,
      }),
      { initialProps: { [`${project.id}::tree-1`]: [terminalPaneId] } },
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    expect(allocateSpy).toHaveBeenCalledTimes(1);

    // Re-render several times while the first allocation is still in flight — same uiPaneId,
    // same connection/workspace. Must not fire a second allocate call.
    rerender({ [`${project.id}::tree-1`]: [terminalPaneId] });
    rerender({ [`${project.id}::tree-1`]: [terminalPaneId] });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    expect(allocateSpy).toHaveBeenCalledTimes(1);

    act(() => { resolveAllocate?.({ registrationId: 'reg-1', paneId: 'surface:reg-1' }); });
    await act(async () => { await Promise.resolve(); });
  });

  it('removes a surface mapping once its pane is no longer open anywhere in the active project', async () => {
    vi.spyOn(persistenceApi, 'fetchPersistenceCapabilities').mockResolvedValue(capabilities('v1'));
    vi.spyOn(panePresenceApi, 'allocateSurfaceRegistration')
      .mockResolvedValue({ registrationId: 'reg-1', paneId: 'surface:reg-1' });
    const submitSpy = vi.spyOn(panePresenceApi.panePresenceTransport, 'submit')
      .mockResolvedValue({ ok: true, rendererLeaseId: 'lease-1', accepted: 1, rejectedTargets: [] });

    const project = makeProject();
    const terminalPaneId = 'pane:terminal:abc';
    const paneItems: Record<string, PaneItem> = {
      [terminalPaneId]: {
        id: terminalPaneId, kind: 'terminal', projectId: project.id, treeId: 'tree-1',
        title: 'Terminal', createdAt: 0, surfaceId: 'surf-1', cwd: '/tmp',
      },
    };

    const { rerender } = renderHook(
      (openPanesMap: Record<string, string[]>) => usePanePresenceIntegration({
        windowId: WINDOW_ID,
        hydrated: true,
        projects: [project],
        activeProjectId: project.id,
        activeBackendConnectionId: CONN,
        openPanesMap,
        paneItems,
      }),
      { initialProps: { [`${project.id}::tree-1`]: [terminalPaneId] } },
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    let lastReq = submitSpy.mock.calls.at(-1)![2];
    expect(lastReq.views).toEqual([expect.objectContaining({ paneId: 'surface:reg-1' })]);

    // Close the terminal pane (no longer present in any slot of the active project).
    rerender({ [`${project.id}::tree-1`]: [] });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });

    // Re-open the SAME uiPaneId — since the mapping was removed on close, this must re-allocate
    // rather than resurrecting the stale registration.
    const allocateSpy = vi.mocked(panePresenceApi.allocateSurfaceRegistration);
    allocateSpy.mockClear();
    rerender({ [`${project.id}::tree-1`]: [terminalPaneId] });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    expect(allocateSpy).toHaveBeenCalledTimes(1);
  });

  it('onLeaseInvalidated clears stale surface mappings before the reporter reacquires, and a subsequent render reallocates', async () => {
    vi.spyOn(persistenceApi, 'fetchPersistenceCapabilities').mockResolvedValue(capabilities('v1'));
    const allocateSpy = vi.spyOn(panePresenceApi, 'allocateSurfaceRegistration')
      .mockResolvedValueOnce({ registrationId: 'reg-1', paneId: 'surface:reg-1' })
      .mockResolvedValueOnce({ registrationId: 'reg-2', paneId: 'surface:reg-2' });

    let leaseCounter = 0;
    const submitSpy = vi.spyOn(panePresenceApi.panePresenceTransport, 'submit')
      .mockImplementation(async (_conn, _ws, req) => ({
        ok: true, rendererLeaseId: req.rendererLeaseId ?? `lease-${++leaseCounter}`, accepted: req.views.length, rejectedTargets: [],
      }));
    const keepaliveSpy = vi.spyOn(panePresenceApi.panePresenceTransport, 'keepalive')
      .mockResolvedValueOnce({ ok: false, code: 'NOT_FOUND' });

    const project = makeProject();
    const terminalPaneId = 'pane:terminal:abc';
    const paneItems: Record<string, PaneItem> = {
      [terminalPaneId]: {
        id: terminalPaneId, kind: 'terminal', projectId: project.id, treeId: 'tree-1',
        title: 'Terminal', createdAt: 0, surfaceId: 'surf-1', cwd: '/tmp',
      },
    };

    renderHook(() => usePanePresenceIntegration({
      windowId: WINDOW_ID,
      hydrated: true,
      projects: [project],
      activeProjectId: project.id,
      activeBackendConnectionId: CONN,
      openPanesMap: { [`${project.id}::tree-1`]: [terminalPaneId] },
      paneItems,
    }));

    // Initial allocation + submission with reg-1.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    expect(allocateSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy.mock.calls.at(-1)![2].views).toEqual([expect.objectContaining({ paneId: 'surface:reg-1' })]);

    // Fire the keepalive interval — it returns NOT_FOUND once, which must invoke
    // onLeaseInvalidated (clearing the reg-1 mapping) BEFORE the reporter's own reacquire
    // dispatch fires with a fresh (initially empty) view set.
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    await act(async () => { await Promise.resolve(); });
    expect(keepaliveSpy).toHaveBeenCalledTimes(1);

    // The stale reg-1 mapping is gone; a subsequent render must reallocate a fresh registration
    // (reg-2) rather than resubmitting the invalidated reg-1 id.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });

    expect(allocateSpy).toHaveBeenCalledTimes(2);
    const finalViews = submitSpy.mock.calls.at(-1)![2].views;
    expect(finalViews).toEqual([expect.objectContaining({ paneId: 'surface:reg-2' })]);
    // reg-1 must never appear again after invalidation.
    expect(submitSpy.mock.calls.every((call) => !call[2].views.some((v) => v.paneId === 'surface:reg-1'))).toBe(false);
  });

  it('switching the active project removes the previous project lease via the reporter empty-backends cleanup', async () => {
    vi.spyOn(persistenceApi, 'fetchPersistenceCapabilities').mockResolvedValue(capabilities('v1'));
    const submitSpy = vi.spyOn(panePresenceApi.panePresenceTransport, 'submit')
      .mockResolvedValue({ ok: true, rendererLeaseId: 'lease-A', accepted: 1, rejectedTargets: [] });
    const removeSpy = vi.spyOn(panePresenceApi.panePresenceTransport, 'remove')
      .mockResolvedValue({ ok: true, removed: 1 });

    const projectA = makeProject({ id: 'proj-a' });
    const projectB = makeProject({ id: 'proj-b', trees: [{ id: 'tree-b', rootNodeId: 'root-b', createdAt: 0, lastActiveAt: 0 }], activeTreeId: 'tree-b' });

    const { rerender } = renderHook(
      (args: { activeProjectId: string; openPanesMap: Record<string, string[]> }) => usePanePresenceIntegration({
        windowId: WINDOW_ID,
        hydrated: true,
        projects: [projectA, projectB],
        activeProjectId: args.activeProjectId,
        activeBackendConnectionId: CONN,
        openPanesMap: args.openPanesMap,
        paneItems: {},
      }),
      {
        initialProps: {
          activeProjectId: projectA.id,
          openPanesMap: { [`${projectA.id}::tree-1`]: ['root-1'] },
        },
      },
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy.mock.calls[0][1]).toBe(projectA.id); // workspaceId

    // Switch active project to B. A no longer appears in `backends` at all, so the reporter's
    // own "backend dropped entirely" cleanup path must DELETE the lease it held for A.
    rerender({
      activeProjectId: projectB.id,
      openPanesMap: {
        [`${projectA.id}::tree-1`]: ['root-1'], // still open in the background, but not active
        [`${projectB.id}::tree-b`]: ['root-b'],
      },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });

    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy.mock.calls[0][0]).toBe(CONN);
    expect(removeSpy.mock.calls[0][1]).toBe(projectA.id);
    expect(removeSpy.mock.calls[0][2]).toEqual(expect.objectContaining({ rendererLeaseId: 'lease-A' }));

    // And B's own slot is now reported.
    const bCall = submitSpy.mock.calls.find((call) => call[1] === projectB.id);
    expect(bCall?.[2].views).toEqual([expect.objectContaining({ paneId: 'node:root-b' })]);
  });

  it('capability state is keyed by the exact scope: a new workspace never inherits the previous scope\'s enabled=true before its own probe resolves', async () => {
    // Project A's probe resolves immediately (supported). Project B's probe is held open — it
    // must NOT be able to piggyback on A's already-resolved `enabled=true` for even one render.
    let resolveB: ((value: ReturnType<typeof capabilities>) => void) | null = null;
    const probe = vi.spyOn(persistenceApi, 'fetchPersistenceCapabilities').mockImplementation((connectionId) => {
      if (connectionId === 'conn-a') return Promise.resolve(capabilities('v1'));
      return new Promise((resolve) => { resolveB = resolve; });
    });
    const submitSpy = vi.spyOn(panePresenceApi.panePresenceTransport, 'submit')
      .mockResolvedValue({ ok: true, rendererLeaseId: 'lease-1', accepted: 1, rejectedTargets: [] });

    const projectA = makeProject({ id: 'proj-a', backendConnectionId: 'conn-a' });
    const projectB = makeProject({
      id: 'proj-b',
      backendConnectionId: 'conn-b',
      trees: [{ id: 'tree-b', rootNodeId: 'root-b', createdAt: 0, lastActiveAt: 0 }],
      activeTreeId: 'tree-b',
    });

    const { rerender } = renderHook(
      (args: { activeProjectId: string; activeBackendConnectionId: string; openPanesMap: Record<string, string[]> }) =>
        usePanePresenceIntegration({
          windowId: WINDOW_ID,
          hydrated: true,
          projects: [projectA, projectB],
          activeProjectId: args.activeProjectId,
          activeBackendConnectionId: args.activeBackendConnectionId,
          openPanesMap: args.openPanesMap,
          paneItems: {},
        }),
      {
        initialProps: {
          activeProjectId: projectA.id,
          activeBackendConnectionId: 'conn-a',
          openPanesMap: { [`${projectA.id}::tree-1`]: ['root-1'] },
        },
      },
    );

    // A's probe resolves and A gets reported.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy.mock.calls[0][1]).toBe(projectA.id);
    submitSpy.mockClear();

    // Switch to project B — a DIFFERENT connection/workspace whose probe has NOT resolved yet.
    // Even though `enabled` was true for A a moment ago, B's scope must render as disabled until
    // its OWN probe answers — no submission may go out for B yet.
    rerender({
      activeProjectId: projectB.id,
      activeBackendConnectionId: 'conn-b',
      openPanesMap: { [`${projectB.id}::tree-b`]: ['root-b'] },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });

    expect(probe).toHaveBeenCalledWith('conn-b');
    // No submission for B's workspace while its probe is still pending.
    expect(submitSpy.mock.calls.some((call) => call[1] === projectB.id)).toBe(false);

    // Now B's probe resolves (also supported) — only THEN may B be reported.
    act(() => { resolveB?.(capabilities('v1')); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });

    expect(submitSpy.mock.calls.some((call) => call[1] === projectB.id)).toBe(true);
  });

  it('does not probe while not hydrated, and probes exactly once on the hydrated false -> true transition', async () => {
    const probe = vi.spyOn(persistenceApi, 'fetchPersistenceCapabilities').mockResolvedValue(capabilities('v1'));
    vi.spyOn(panePresenceApi.panePresenceTransport, 'submit')
      .mockResolvedValue({ ok: true, rendererLeaseId: 'lease-1', accepted: 1, rejectedTargets: [] });

    const project = makeProject();
    const { rerender } = renderHook(
      (hydrated: boolean) => usePanePresenceIntegration({
        windowId: WINDOW_ID,
        hydrated,
        projects: [project],
        activeProjectId: project.id,
        activeBackendConnectionId: CONN,
        openPanesMap: { [`${project.id}::tree-1`]: ['root-1'] },
        paneItems: {},
      }),
      { initialProps: false },
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    expect(probe).not.toHaveBeenCalled();

    rerender(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    expect(probe).toHaveBeenCalledTimes(1);

    // Re-rendering with hydrated still true and nothing else changed must not re-probe.
    rerender(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('an ordinary immutable update to the SAME project object (new reference, same id/connection) does not re-probe or tear down presence', async () => {
    const probe = vi.spyOn(persistenceApi, 'fetchPersistenceCapabilities').mockResolvedValue(capabilities('v1'));
    const submitSpy = vi.spyOn(panePresenceApi.panePresenceTransport, 'submit')
      .mockResolvedValue({ ok: true, rendererLeaseId: 'lease-1', accepted: 1, rejectedTargets: [] });
    const removeSpy = vi.spyOn(panePresenceApi.panePresenceTransport, 'remove')
      .mockResolvedValue({ ok: true, removed: 1 });

    const project = makeProject();
    const { rerender } = renderHook(
      (proj: Project) => usePanePresenceIntegration({
        windowId: WINDOW_ID,
        hydrated: true,
        projects: [proj],
        activeProjectId: proj.id,
        activeBackendConnectionId: CONN,
        openPanesMap: { [`${proj.id}::tree-1`]: ['root-1'] },
        paneItems: {},
      }),
      { initialProps: project },
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(submitSpy).toHaveBeenCalledTimes(1);

    // A new Project object with the SAME id/backendConnectionId (e.g. a rename, or an unrelated
    // field bump) — immutable-update pattern used throughout this codebase's reducers.
    const renamedProject: Project = { ...project, name: 'Renamed' };
    rerender(renamedProject);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });

    expect(probe).toHaveBeenCalledTimes(1); // no re-probe
    expect(removeSpy).not.toHaveBeenCalled(); // no teardown of the still-active lease
  });

  it('the surface resolver omits a mapping recorded for a different workspace/connection until reallocated for the current scope', async () => {
    vi.spyOn(persistenceApi, 'fetchPersistenceCapabilities').mockResolvedValue(capabilities('v1'));
    const allocateSpy = vi.spyOn(panePresenceApi, 'allocateSurfaceRegistration')
      .mockResolvedValueOnce({ registrationId: 'reg-a', paneId: 'surface:reg-a' })
      .mockResolvedValueOnce({ registrationId: 'reg-b', paneId: 'surface:reg-b' });
    const submitSpy = vi.spyOn(panePresenceApi.panePresenceTransport, 'submit')
      .mockResolvedValue({ ok: true, rendererLeaseId: 'lease-1', accepted: 1, rejectedTargets: [] });

    const terminalPaneId = 'pane:terminal:shared';
    const projectA = makeProject({ id: 'proj-a', backendConnectionId: 'conn-a' });
    const projectB = makeProject({
      id: 'proj-b',
      backendConnectionId: 'conn-b',
      trees: [{ id: 'tree-b', rootNodeId: 'root-b', createdAt: 0, lastActiveAt: 0 }],
      activeTreeId: 'tree-b',
    });
    // The SAME uiPaneId string is (implausibly, but per the brief's concern) open in both
    // projects' pane maps — proving the resolver keys mappings by scope, not just uiPaneId.
    const paneItems: Record<string, PaneItem> = {
      [terminalPaneId]: {
        id: terminalPaneId, kind: 'terminal', projectId: projectA.id, treeId: 'tree-1',
        title: 'Terminal', createdAt: 0, surfaceId: 'surf-1', cwd: '/tmp',
      },
    };

    const { rerender } = renderHook(
      (args: { activeProjectId: string; activeBackendConnectionId: string; openPanesMap: Record<string, string[]> }) =>
        usePanePresenceIntegration({
          windowId: WINDOW_ID,
          hydrated: true,
          projects: [projectA, projectB],
          activeProjectId: args.activeProjectId,
          activeBackendConnectionId: args.activeBackendConnectionId,
          openPanesMap: args.openPanesMap,
          paneItems,
        }),
      {
        initialProps: {
          activeProjectId: projectA.id,
          activeBackendConnectionId: 'conn-a',
          openPanesMap: { [`${projectA.id}::tree-1`]: [terminalPaneId] },
        },
      },
    );

    // Allocated + reported for project A / conn-a.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    expect(allocateSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy.mock.calls.at(-1)![2].views).toEqual([expect.objectContaining({ paneId: 'surface:reg-a' })]);

    // Switch to project B / conn-b, with the SAME uiPaneId now open there too. The stale
    // mapping (recorded for conn-a/proj-a) must be OMITTED for the new scope — never resurrected
    // — until a fresh allocation lands for conn-b/proj-b.
    submitSpy.mockClear();
    rerender({
      activeProjectId: projectB.id,
      activeBackendConnectionId: 'conn-b',
      openPanesMap: { [`${projectB.id}::tree-b`]: [terminalPaneId] },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });

    // Before the new allocation resolves, the pane must be OMITTED (never the stale surface:reg-a).
    const preAllocationSubmit = submitSpy.mock.calls.find((call) => call[1] === projectB.id);
    if (preAllocationSubmit) {
      expect(preAllocationSubmit[2].views.some((v: { paneId: string }) => v.paneId === 'surface:reg-a')).toBe(false);
    }

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });

    expect(allocateSpy).toHaveBeenCalledTimes(2);
    expect(allocateSpy.mock.calls[1]).toEqual(['conn-b', projectB.id, 'terminal']);
    const finalSubmit = submitSpy.mock.calls.at(-1)!;
    expect(finalSubmit[1]).toBe(projectB.id);
    expect(finalSubmit[2].views).toEqual([expect.objectContaining({ paneId: 'surface:reg-b' })]);
  });

  it('generation tokens: an in-flight allocation invalidated by a lease reset is ignored even if it resolves after a newer attempt for the same key starts, and the newer attempt wins', async () => {
    vi.spyOn(persistenceApi, 'fetchPersistenceCapabilities').mockResolvedValue(capabilities('v1'));

    let resolveA: ((value: { registrationId: string; paneId: string }) => void) | null = null;
    let resolveB: ((value: { registrationId: string; paneId: string }) => void) | null = null;
    let call = 0;
    const allocateSpy = vi.spyOn(panePresenceApi, 'allocateSurfaceRegistration').mockImplementation(() => {
      call += 1;
      if (call === 1) return new Promise((resolve) => { resolveA = resolve; });
      return new Promise((resolve) => { resolveB = resolve; });
    });

    let leaseCounter = 0;
    const submitSpy = vi.spyOn(panePresenceApi.panePresenceTransport, 'submit')
      .mockImplementation(async (_conn, _ws, req) => ({
        ok: true, rendererLeaseId: req.rendererLeaseId ?? `lease-${++leaseCounter}`, accepted: req.views.length, rejectedTargets: [],
      }));
    // First keepalive tick invalidates the lease, forcing onLeaseInvalidated to clear in-flight
    // allocation A. Subsequent keepalives succeed.
    vi.spyOn(panePresenceApi.panePresenceTransport, 'keepalive')
      .mockResolvedValueOnce({ ok: false, code: 'NOT_FOUND' })
      .mockResolvedValue({ ok: true, renewedViews: 1 });

    const project = makeProject();
    const terminalPaneId = 'pane:terminal:abc';
    const paneItems: Record<string, PaneItem> = {
      [terminalPaneId]: {
        id: terminalPaneId, kind: 'terminal', projectId: project.id, treeId: 'tree-1',
        title: 'Terminal', createdAt: 0, surfaceId: 'surf-1', cwd: '/tmp',
      },
    };

    renderHook(() => usePanePresenceIntegration({
      windowId: WINDOW_ID,
      hydrated: true,
      projects: [project],
      activeProjectId: project.id,
      activeBackendConnectionId: CONN,
      openPanesMap: { [`${project.id}::tree-1`]: [terminalPaneId] },
      paneItems,
    }));

    // Allocation A starts (in flight, unresolved).
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    expect(allocateSpy).toHaveBeenCalledTimes(1);

    // Keepalive fires NOT_FOUND -> onLeaseInvalidated clears the in-flight allocation A's
    // identity (invalidating it) and the reporter reacquires with an initially-empty view set.
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    await act(async () => { await Promise.resolve(); });

    // A subsequent render (still nothing mapped) starts allocation B for the SAME key.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    expect(allocateSpy).toHaveBeenCalledTimes(2);

    // A resolves FIRST (after being invalidated) — its result must be discarded, never installed
    // as the mapping and never removed as some later state either.
    act(() => { resolveA?.({ registrationId: 'reg-a-stale', paneId: 'surface:reg-a-stale' }); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });

    let submittedPaneIds = submitSpy.mock.calls.at(-1)![2].views.map((v: { paneId: string }) => v.paneId);
    expect(submittedPaneIds).not.toContain('surface:reg-a-stale');

    // B resolves and wins — it is the mapping that ends up reported.
    act(() => { resolveB?.({ registrationId: 'reg-b-fresh', paneId: 'surface:reg-b-fresh' }); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });

    submittedPaneIds = submitSpy.mock.calls.at(-1)![2].views.map((v: { paneId: string }) => v.paneId);
    expect(submittedPaneIds).toContain('surface:reg-b-fresh');
    expect(submittedPaneIds).not.toContain('surface:reg-a-stale');
  });

  it('generation tokens (invalidation-time invariant): allocation A resolves BEFORE the retry effect starts B — A must already be invalid at invalidation time, not merely superseded later', async () => {
    vi.spyOn(persistenceApi, 'fetchPersistenceCapabilities').mockResolvedValue(capabilities('v1'));

    let resolveA: ((value: { registrationId: string; paneId: string }) => void) | null = null;
    const allocateSpy = vi.spyOn(panePresenceApi, 'allocateSurfaceRegistration')
      .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
      .mockResolvedValueOnce({ registrationId: 'reg-b-fresh', paneId: 'surface:reg-b-fresh' });

    let leaseCounter = 0;
    const submitSpy = vi.spyOn(panePresenceApi.panePresenceTransport, 'submit')
      .mockImplementation(async (_conn, _ws, req) => ({
        ok: true, rendererLeaseId: req.rendererLeaseId ?? `lease-${++leaseCounter}`, accepted: req.views.length, rejectedTargets: [],
      }));
    vi.spyOn(panePresenceApi.panePresenceTransport, 'keepalive')
      .mockResolvedValueOnce({ ok: false, code: 'NOT_FOUND' })
      .mockResolvedValue({ ok: true, renewedViews: 1 });

    const project = makeProject();
    const terminalPaneId = 'pane:terminal:abc';
    const paneItems: Record<string, PaneItem> = {
      [terminalPaneId]: {
        id: terminalPaneId, kind: 'terminal', projectId: project.id, treeId: 'tree-1',
        title: 'Terminal', createdAt: 0, surfaceId: 'surf-1', cwd: '/tmp',
      },
    };

    renderHook(() => usePanePresenceIntegration({
      windowId: WINDOW_ID,
      hydrated: true,
      projects: [project],
      activeProjectId: project.id,
      activeBackendConnectionId: CONN,
      openPanesMap: { [`${project.id}::tree-1`]: [terminalPaneId] },
      paneItems,
    }));

    // Allocation A starts (in flight, unresolved).
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    expect(allocateSpy).toHaveBeenCalledTimes(1);

    // Keepalive fires NOT_FOUND -> onLeaseInvalidated clears A's in-flight marker AND — per the
    // fix under test — advances A's key's generation counter right here, synchronously, before
    // any retry effect has had a chance to run. A's captured token must be stale THE INSTANT
    // invalidation happens, not merely "eventually" once some later attempt B increments the
    // counter again.
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    await act(async () => { await Promise.resolve(); });

    // A resolves NOW — deliberately BEFORE the retry effect has started attempt B for the same
    // key (no extra tick advances the allocation effect here). If invalidation only cleared the
    // in-flight marker without bumping the generation, A's token would still read as current and
    // this resolution would install stale data.
    act(() => { resolveA?.({ registrationId: 'reg-a-stale', paneId: 'surface:reg-a-stale' }); });
    await act(async () => { await Promise.resolve(); });

    const preRetrySubmittedPaneIds = submitSpy.mock.calls.length > 0
      ? submitSpy.mock.calls.at(-1)![2].views.map((v: { paneId: string }) => v.paneId)
      : [];
    expect(preRetrySubmittedPaneIds).not.toContain('surface:reg-a-stale');

    // Only now does a subsequent render start the retry attempt B for the same key, which must
    // win cleanly (no interference from A's already-discarded result).
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    expect(allocateSpy).toHaveBeenCalledTimes(2);

    const finalSubmittedPaneIds = submitSpy.mock.calls.at(-1)![2].views.map((v: { paneId: string }) => v.paneId);
    expect(finalSubmittedPaneIds).toContain('surface:reg-b-fresh');
    expect(finalSubmittedPaneIds).not.toContain('surface:reg-a-stale');
  });

  it('generation tokens (close mid-flight): closing a surface pane while its allocation is in flight discards the old completion; reopening starts a fresh allocation and uses only its result', async () => {
    vi.spyOn(persistenceApi, 'fetchPersistenceCapabilities').mockResolvedValue(capabilities('v1'));

    let resolveA: ((value: { registrationId: string; paneId: string }) => void) | null = null;
    const allocateSpy = vi.spyOn(panePresenceApi, 'allocateSurfaceRegistration')
      .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
      .mockResolvedValueOnce({ registrationId: 'reg-fresh', paneId: 'surface:reg-fresh' });
    const submitSpy = vi.spyOn(panePresenceApi.panePresenceTransport, 'submit')
      .mockResolvedValue({ ok: true, rendererLeaseId: 'lease-1', accepted: 1, rejectedTargets: [] });

    const project = makeProject();
    const terminalPaneId = 'pane:terminal:abc';
    const paneItems: Record<string, PaneItem> = {
      [terminalPaneId]: {
        id: terminalPaneId, kind: 'terminal', projectId: project.id, treeId: 'tree-1',
        title: 'Terminal', createdAt: 0, surfaceId: 'surf-1', cwd: '/tmp',
      },
    };

    const { rerender } = renderHook(
      (openPanesMap: Record<string, string[]>) => usePanePresenceIntegration({
        windowId: WINDOW_ID,
        hydrated: true,
        projects: [project],
        activeProjectId: project.id,
        activeBackendConnectionId: CONN,
        openPanesMap,
        paneItems,
      }),
      { initialProps: { [`${project.id}::tree-1`]: [terminalPaneId] } },
    );

    // Allocation A starts (in flight, unresolved).
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    expect(allocateSpy).toHaveBeenCalledTimes(1);

    // Close the pane while A is still in flight.
    rerender({ [`${project.id}::tree-1`]: [] });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });

    // A resolves AFTER the close. Its result must not install a mapping for a pane that is no
    // longer open — even transiently.
    act(() => { resolveA?.({ registrationId: 'reg-a-stale', paneId: 'surface:reg-a-stale' }); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });

    const afterCloseSubmittedPaneIds = submitSpy.mock.calls.length > 0
      ? submitSpy.mock.calls.at(-1)![2].views.map((v: { paneId: string }) => v.paneId)
      : [];
    expect(afterCloseSubmittedPaneIds).not.toContain('surface:reg-a-stale');

    // Reopen the SAME uiPaneId — must start a FRESH allocation (attempt count grows) and use
    // only its own result, never resurrecting A's stale registration.
    rerender({ [`${project.id}::tree-1`]: [terminalPaneId] });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });

    expect(allocateSpy).toHaveBeenCalledTimes(2);
    const finalSubmittedPaneIds = submitSpy.mock.calls.at(-1)![2].views.map((v: { paneId: string }) => v.paneId);
    expect(finalSubmittedPaneIds).toContain('surface:reg-fresh');
    expect(finalSubmittedPaneIds).not.toContain('surface:reg-a-stale');
  });

  it('generation tokens (workspace switch mid-flight): allocation A for the old scope resolving after new-scope allocation B must never overwrite B, even with the same uiPaneId string', async () => {
    vi.spyOn(persistenceApi, 'fetchPersistenceCapabilities').mockResolvedValue(capabilities('v1'));

    let resolveA: ((value: { registrationId: string; paneId: string }) => void) | null = null;
    const allocateSpy = vi.spyOn(panePresenceApi, 'allocateSurfaceRegistration')
      .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
      .mockResolvedValueOnce({ registrationId: 'reg-b', paneId: 'surface:reg-b' });
    const submitSpy = vi.spyOn(panePresenceApi.panePresenceTransport, 'submit')
      .mockResolvedValue({ ok: true, rendererLeaseId: 'lease-1', accepted: 1, rejectedTargets: [] });

    const terminalPaneId = 'pane:terminal:shared';
    const projectA = makeProject({ id: 'proj-a', backendConnectionId: 'conn-a' });
    const projectB = makeProject({
      id: 'proj-b',
      backendConnectionId: 'conn-b',
      trees: [{ id: 'tree-b', rootNodeId: 'root-b', createdAt: 0, lastActiveAt: 0 }],
      activeTreeId: 'tree-b',
    });
    // Same uiPaneId string open in both scopes' pane maps.
    const paneItems: Record<string, PaneItem> = {
      [terminalPaneId]: {
        id: terminalPaneId, kind: 'terminal', projectId: projectA.id, treeId: 'tree-1',
        title: 'Terminal', createdAt: 0, surfaceId: 'surf-1', cwd: '/tmp',
      },
    };

    const { rerender } = renderHook(
      (args: { activeProjectId: string; activeBackendConnectionId: string; openPanesMap: Record<string, string[]> }) =>
        usePanePresenceIntegration({
          windowId: WINDOW_ID,
          hydrated: true,
          projects: [projectA, projectB],
          activeProjectId: args.activeProjectId,
          activeBackendConnectionId: args.activeBackendConnectionId,
          openPanesMap: args.openPanesMap,
          paneItems,
        }),
      {
        initialProps: {
          activeProjectId: projectA.id,
          activeBackendConnectionId: 'conn-a',
          openPanesMap: { [`${projectA.id}::tree-1`]: [terminalPaneId] },
        },
      },
    );

    // Allocation A starts for proj-a/conn-a (in flight, unresolved).
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    expect(allocateSpy).toHaveBeenCalledTimes(1);

    // Switch to project B / conn-b while A is still unresolved. The new scope's allocation
    // effect starts B for the SAME uiPaneId string, scoped to conn-b/proj-b.
    rerender({
      activeProjectId: projectB.id,
      activeBackendConnectionId: 'conn-b',
      openPanesMap: { [`${projectB.id}::tree-b`]: [terminalPaneId] },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });
    expect(allocateSpy).toHaveBeenCalledTimes(2);

    // A resolves AFTER B has already started — must never install its stale (wrong-scope)
    // mapping over whatever B installs, and must never be reported for the NEW scope.
    act(() => { resolveA?.({ registrationId: 'reg-a-stale', paneId: 'surface:reg-a-stale' }); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });

    const afterASubmittedPaneIds = submitSpy.mock.calls.length > 0
      ? submitSpy.mock.calls
        .filter((call) => call[1] === projectB.id)
        .at(-1)?.[2].views.map((v: { paneId: string }) => v.paneId) ?? []
      : [];
    expect(afterASubmittedPaneIds).not.toContain('surface:reg-a-stale');

    // B resolves and is the only one ever reported for the new scope.
    const resolveBFn = vi.mocked(panePresenceApi.allocateSurfaceRegistration).mock.results[1]?.value as
      Promise<{ registrationId: string; paneId: string }> | undefined;
    await resolveBFn;
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await Promise.resolve(); });

    const finalCall = submitSpy.mock.calls.filter((call) => call[1] === projectB.id).at(-1)!;
    const finalPaneIds = finalCall[2].views.map((v: { paneId: string }) => v.paneId);
    expect(finalPaneIds).toContain('surface:reg-b');
    expect(finalPaneIds).not.toContain('surface:reg-a-stale');
  });
});
