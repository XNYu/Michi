import React, { useEffect, useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageDatabase, PageDatabaseView } from 'michi-shared';
import { readPageComponent, type PageComponentDetail } from '../../../../services/api/pageComponents';
import { notifyPageChanged, type PageEventIdentity } from '../../../../state/pages/pageEvents';
import { CustomDatabaseView } from './CustomDatabaseView';
import { useComponentCapability } from './useComponentCapability';

const frameLifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));
const capability = vi.hoisted(() => ({ call: vi.fn(), pause: vi.fn() }));
vi.mock('../../../../services/api/pageComponents', () => ({ readPageComponent: vi.fn() }));
vi.mock('./useComponentCapability', () => ({ useComponentCapability: vi.fn((input: { enabled: boolean; version: number }) => ({
  state: input.enabled ? { capability: `cap-${input.version}`, capabilityId: `cap-id-${input.version}` } : null,
  call: capability.call, pause: capability.pause,
})) }));
vi.mock('./SandboxFrame', () => ({ SandboxFrame: (props: {
  code: string; versionKey: number; data: unknown; stable?: boolean; candidateReady?: boolean;
  capability?: { token: string };
}) => {
  const [mountId] = useState(() => ++frameLifecycle.mounts);
  useEffect(() => () => { frameLifecycle.unmounts += 1; }, []);
  return <div data-testid="sandbox" data-mount={mountId} data-code={props.code} data-version={props.versionKey}
    data-stable={props.stable} data-ready={props.candidateReady} data-capability={props.capability?.token}>
    <output>{JSON.stringify(props.data)}</output>
    <input aria-label="Widget draft" defaultValue="" />
  </div>;
} }));

const view: PageDatabaseView = {
  id: 'view-1', name: 'Release view', type: 'custom', position: 0,
  config: { componentId: 'component-1', props: { compact: true }, filters: [], match: 'all', sorts: [] },
};
const database: PageDatabase = {
  id: 'database-1', workspaceId: 'workspace-1', title: 'Release work', revision: 1, updatedAt: 10,
  columns: [{ id: 'title', name: 'Title', type: 'text' }], views: [view],
  rows: [{ id: 'row-1', values: { title: 'Review release' }, position: 0, updatedAt: 10, rev: 1, edited: {}, bodyEditedAt: null }],
};
const identity = { backendConnectionId: 'backend-1', workspaceId: 'workspace-1' };
const hostProps = { database, view, workspaceId: 'workspace-1', connectionId: 'backend-1' };

function componentDetail(version = 1, enabled = true): PageComponentDetail {
  return {
    component: {
      id: 'component-1', ownerUserId: 'owner-1', workspaceId: 'workspace-1', name: 'Release widget', description: '',
      enabled, activeVersion: version, libraryRevision: version, revocationEpoch: 0, deletedAt: null,
      versions: version, createdAt: 1, updatedAt: version,
    },
    version: { componentId: 'component-1', version, code: `root.textContent = "version ${version}"`, propsSchema: null, source: { kind: 'user' }, createdAt: version },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const changed = (event: Partial<PageEventIdentity>) => act(() => notifyPageChanged({ ...identity, ...event }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readPageComponent).mockReset().mockResolvedValue(componentDetail());
  frameLifecycle.mounts = 0;
  frameLifecycle.unmounts = 0;
});
afterEach(() => { vi.useRealTimers(); });

describe('CustomDatabaseView live component source', () => {
  it('refreshes the source for matching database and component events while preserving the mounted view', async () => {
    const { rerender } = render(<CustomDatabaseView {...hostProps} />);
    const frame = await screen.findByTestId('sandbox');
    expect(readPageComponent).toHaveBeenCalledWith('component-1', 'workspace-1', 'backend-1', undefined);
    expect(frame.getAttribute('data-stable')).toBe('true');
    expect(frame.getAttribute('data-ready')).toBe('true');
    fireEvent.change(screen.getByRole('textbox', { name: 'Widget draft' }), { target: { value: 'Keep this filter' } });

    for (const event of [
      { backendConnectionId: 'other-backend', componentId: 'component-1' },
      { workspaceId: 'other-workspace', componentId: 'component-1' },
      { componentId: 'other-component' },
      { databaseId: 'other-database' },
      { pageId: 'unrelated-page' },
    ]) changed(event);
    expect(readPageComponent).toHaveBeenCalledTimes(1);

    vi.mocked(readPageComponent).mockResolvedValueOnce(componentDetail(2));
    changed({ componentId: 'component-1' });
    await waitFor(() => expect(frame.getAttribute('data-version')).toBe('2'));
    vi.mocked(readPageComponent).mockResolvedValueOnce(componentDetail(3));
    changed({ databaseId: 'database-1' });
    await waitFor(() => expect(frame.getAttribute('data-version')).toBe('3'));
    expect(readPageComponent).toHaveBeenCalledTimes(3);

    const updated: PageDatabase = { ...database, revision: 2, rows: [{ ...database.rows[0], values: { title: 'Release approved' }, rev: 2 }] };
    rerender(<CustomDatabaseView {...hostProps} database={updated} />);
    expect(frame.textContent).toContain('Release approved');
    expect(frame.textContent).toContain('"revision":2');
    expect(screen.getByTestId('sandbox')).toBe(frame);
    expect((screen.getByRole('textbox', { name: 'Widget draft' }) as HTMLInputElement).value).toBe('Keep this filter');
    expect(frameLifecycle).toEqual({ mounts: 1, unmounts: 0 });
  });

  it('coalesces events received during a source read into a trailing read', async () => {
    render(<CustomDatabaseView {...hostProps} />);
    const frame = await screen.findByTestId('sandbox');
    const pending = deferred<PageComponentDetail>();
    vi.mocked(readPageComponent).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(componentDetail(3));
    changed({ componentId: 'component-1' });
    expect(readPageComponent).toHaveBeenCalledTimes(2);
    changed({ componentId: 'component-1' });
    changed({ databaseId: 'database-1' });
    expect(readPageComponent).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('sandbox')).toBe(frame);
    expect(frame.getAttribute('data-version')).toBe('1');

    await act(async () => { pending.resolve(componentDetail(2)); });
    await waitFor(() => expect(frame.getAttribute('data-version')).toBe('3'));
    expect(readPageComponent).toHaveBeenCalledTimes(3);
    expect(frameLifecycle).toEqual({ mounts: 1, unmounts: 0 });
  });

  it('keeps the loaded source capability while a newly pinned version is still being read', async () => {
    const pinned = (version: number): PageDatabaseView => ({ ...view, config: { ...view.config, pinnedVersion: version } });
    const { rerender } = render(<CustomDatabaseView {...hostProps} view={pinned(1)} />);
    const frame = await screen.findByTestId('sandbox');
    expect(frame.getAttribute('data-version')).toBe('1');
    expect(frame.getAttribute('data-capability')).toBe('cap-1');
    fireEvent.change(screen.getByRole('textbox', { name: 'Widget draft' }), { target: { value: 'Keep version-one state' } });

    const nextSource = deferred<PageComponentDetail>();
    vi.mocked(readPageComponent).mockReturnValueOnce(nextSource.promise);
    rerender(<CustomDatabaseView {...hostProps} view={pinned(2)} />);
    expect(readPageComponent).toHaveBeenLastCalledWith('component-1', 'workspace-1', 'backend-1', 2);
    expect(vi.mocked(useComponentCapability)).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true, version: 1 }));
    expect(vi.mocked(useComponentCapability).mock.calls.some(([input]) => input.enabled && input.version === 2)).toBe(false);
    expect(screen.getByTestId('sandbox')).toBe(frame);
    expect(frame.getAttribute('data-code')).toBe(componentDetail(1).version.code);
    expect(frame.getAttribute('data-version')).toBe('1');
    // The capability mock is immediately ready; even then old code must never
    // receive the requested version's token until that source has loaded.
    expect(frame.getAttribute('data-ready')).toBe('true');
    expect(frame.getAttribute('data-capability')).toBe('cap-1');

    await act(async () => { nextSource.resolve(componentDetail(2)); });
    await waitFor(() => expect(frame.getAttribute('data-version')).toBe('2'));
    expect(vi.mocked(useComponentCapability)).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true, version: 2 }));
    expect(frame.getAttribute('data-code')).toBe(componentDetail(2).version.code);
    expect(frame.getAttribute('data-ready')).toBe('true');
    expect(frame.getAttribute('data-capability')).toBe('cap-2');
    expect(screen.getByTestId('sandbox')).toBe(frame);
    expect((screen.getByRole('textbox', { name: 'Widget draft' }) as HTMLInputElement).value).toBe('Keep version-one state');
    expect(frameLifecycle).toEqual({ mounts: 1, unmounts: 0 });
  });

  it('keeps the previous frame and its draft after a temporary source failure, then recovers in place', async () => {
    render(<CustomDatabaseView {...hostProps} />);
    const frame = await screen.findByTestId('sandbox');
    fireEvent.change(screen.getByRole('textbox', { name: 'Widget draft' }), { target: { value: 'Unsaved filter' } });
    vi.mocked(readPageComponent).mockRejectedValueOnce(Object.assign(new Error('Temporary connection failure'), { status: 503 }));
    changed({ componentId: 'component-1' });
    expect(await screen.findByText('The update is unavailable. Temporary connection failure')).toBeTruthy();
    expect(screen.getByTestId('sandbox')).toBe(frame);
    expect(frame.getAttribute('data-version')).toBe('1');
    expect(vi.mocked(useComponentCapability)).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true, version: 1 }));

    vi.mocked(readPageComponent).mockResolvedValueOnce(componentDetail(2));
    changed({ componentId: 'component-1' });
    await waitFor(() => expect(frame.getAttribute('data-version')).toBe('2'));
    expect(screen.queryByText(/The update is unavailable/)).toBeNull();
    expect(screen.getByTestId('sandbox')).toBe(frame);
    expect((screen.getByRole('textbox', { name: 'Widget draft' }) as HTMLInputElement).value).toBe('Unsaved filter');
    expect(frameLifecycle).toEqual({ mounts: 1, unmounts: 0 });
  });

  it('removes the frame and disables its capability when the component is disabled', async () => {
    render(<CustomDatabaseView {...hostProps} />);
    await screen.findByTestId('sandbox');
    vi.mocked(readPageComponent).mockResolvedValueOnce(componentDetail(1, false));
    changed({ componentId: 'component-1' });
    expect(await screen.findByText('This component is disabled or unavailable.')).toBeTruthy();
    expect(screen.queryByTestId('sandbox')).toBeNull();
    expect(frameLifecycle).toEqual({ mounts: 1, unmounts: 1 });
    expect(vi.mocked(useComponentCapability)).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('removes forbidden content and suppresses queued reads and polling after a 403', async () => {
    vi.useFakeTimers();
    render(<CustomDatabaseView {...hostProps} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('sandbox')).toBeTruthy();
    const pending = deferred<PageComponentDetail>();
    vi.mocked(readPageComponent).mockReturnValueOnce(pending.promise);
    changed({ componentId: 'component-1' });
    changed({ databaseId: 'database-1' });
    expect(readPageComponent).toHaveBeenCalledTimes(2);
    await act(async () => { pending.reject(Object.assign(new Error('Access denied'), { status: 403 })); });
    expect(screen.getByText('Access denied')).toBeTruthy();
    expect(screen.queryByTestId('sandbox')).toBeNull();
    expect(frameLifecycle).toEqual({ mounts: 1, unmounts: 1 });
    expect(vi.mocked(useComponentCapability)).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(readPageComponent).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('sandbox')).toBeNull();
  });

  it('removes an already mounted frame immediately when its database becomes read-only', async () => {
    const { rerender } = render(<CustomDatabaseView {...hostProps} />);
    await screen.findByTestId('sandbox');
    rerender(<CustomDatabaseView {...hostProps} readOnly />);
    expect(screen.getByText('This database is read-only, so the component is paused.')).toBeTruthy();
    expect(screen.queryByTestId('sandbox')).toBeNull();
    expect(frameLifecycle).toEqual({ mounts: 1, unmounts: 1 });
    expect(vi.mocked(useComponentCapability)).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
  });
});
