import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageBlock } from 'michi-shared';
import { notifyPageChanged } from '../../../../state/pages/pageEvents';
import { readPageComponent } from '../../../../services/api/pageComponents';
import { useComponentCapability } from './useComponentCapability';
import { CustomBlock } from './CustomBlock';

const mockCapability = vi.hoisted(() => ({ call: vi.fn(), pause: vi.fn() }));
const mountCount = vi.hoisted(() => ({ value: 0 }));
vi.mock('../../../../services/api/pageComponents', () => ({ readPageComponent: vi.fn() }));
vi.mock('./useComponentCapability', () => ({ useComponentCapability: vi.fn(() => ({ state: { capability: 'cap-1' }, call: mockCapability.call, pause: mockCapability.pause })) }));
vi.mock('./SandboxFrame', () => ({ SandboxFrame: (props: { data: unknown; versionKey?: number; stable?: boolean; candidateReady?: boolean; capability?: { call: (method: string, args: unknown[]) => Promise<unknown> } }) => {
  const [mountId] = useState(() => ++mountCount.value);
  const [count, setCount] = React.useState(0);
  return <div data-testid="sandbox" data-mounts={mountId} data-version={props.versionKey} data-stable={props.stable} data-ready={props.candidateReady}>{JSON.stringify(props.data)}<button type="button" onClick={() => void props.capability?.call('write.rows', []).then(() => setCount(value => value + 1))}>Write {count}</button></div>;
} }));

const block: Extract<PageBlock, { type: 'component' }> = {
  id: 'block-1', type: 'component', componentId: 'component-1', rev: 1,
  props: { databaseId: 'database-1', databaseIds: ['database-2'] },
};

afterEach(() => { vi.useRealTimers(); });

describe('CustomBlock live database data', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mountCount.value = 0;
    vi.mocked(readPageComponent).mockResolvedValue({
      component: { id: 'component-1', enabled: true, name: 'Table widget' } as never,
      version: { code: 'root.textContent = "table"', version: 1, source: { kind: 'user' } } as never,
    });
  });

  it('refreshes authorized linked database snapshots in place and keeps actions available', async () => {
    let revision = 1;
    mockCapability.call.mockImplementation(async (method: string, args: unknown[]) => {
      if (method === 'read.host') return { page: { id: 'page-1', revision }, block };
      if (method === 'read.database') return { id: args[0], revision, rows: [{ id: 'row-1', title: `revision ${revision}` }] };
      return { applied: [{ id: 'row-1' }], proposed: [], rejected: [] };
    });
    render(<CustomBlock block={block} pageId="page-1" workspaceId="workspace-1" connectionId="backend-1" />);
    expect(await screen.findByText(/revision 1/)).toBeTruthy();
    expect(screen.getByText('Saved by you')).toBeTruthy();
    const frame = screen.getByTestId('sandbox');
    expect(frame.getAttribute('data-mounts')).toBe('1');
    expect(mockCapability.call).toHaveBeenCalledWith('read.database', ['database-1']);
    expect(mockCapability.call).toHaveBeenCalledWith('read.database', ['database-2']);

    revision = 2;
    act(() => notifyPageChanged({ backendConnectionId: 'backend-1', workspaceId: 'workspace-1', databaseId: 'database-2' }));
    await waitFor(() => expect(screen.getByTestId('sandbox').textContent).toContain('revision 2'));
    expect(screen.getByTestId('sandbox').getAttribute('data-mounts')).toBe('1');
    const writes = mockCapability.call.mock.calls.filter(([method]) => method === 'write.rows').length;
    fireEvent.click(screen.getByRole('button', { name: 'Write 0' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Write 1' })).toBeTruthy());
    expect(mockCapability.call.mock.calls.filter(([method]) => method === 'write.rows')).toHaveLength(writes + 1);
    expect(screen.getByTestId('sandbox').getAttribute('data-mounts')).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Write 1' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Write 2' })).toBeTruthy());
    expect(mockCapability.call.mock.calls.filter(([method]) => method === 'write.rows')).toHaveLength(writes + 2);
    expect(screen.getByTestId('sandbox').getAttribute('data-mounts')).toBe('1');
  });

  it('shows generated component provenance and opens the saved source message', async () => {
    vi.mocked(readPageComponent).mockResolvedValue({
      component: { id: 'component-1', enabled: true, name: 'Table widget' } as never,
      version: { code: 'root.textContent = "table"', version: 1, source: { kind: 'helper', nodeId: 'node-1', turnId: 'turn-1', assistantId: 'answer-1' } } as never,
    });
    mockCapability.call.mockImplementation(async (method: string) => method === 'read.host' ? { page: { id: 'page-1' }, block } : { rows: [] });
    const onOpenSource = vi.fn();
    render(<CustomBlock block={block} pageId="page-1" workspaceId="workspace-1" connectionId="backend-1" onOpenSource={onOpenSource} />);
    expect(await screen.findByText('Created with page helper')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open source message' }));
    expect(onOpenSource).toHaveBeenCalledWith({ kind: 'helper', nodeId: 'node-1', turnId: 'turn-1', assistantId: 'answer-1' });
  });

  it('clears a mounted source when the component version is confirmed missing', async () => {
    vi.useFakeTimers();
    render(<CustomBlock block={block} pageId="page-1" workspaceId="workspace-1" connectionId="backend-1" />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByTestId('sandbox')).toBeTruthy();
    vi.mocked(readPageComponent).mockRejectedValueOnce(Object.assign(new Error('Component not found'), { status: 404, code: 'not_found' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.queryByTestId('sandbox')).toBeNull();
    expect(mockCapability.pause).toHaveBeenCalledTimes(1);
    expect(vi.mocked(useComponentCapability)).toHaveBeenLastCalledWith(expect.objectContaining({ componentId: 'component-1', enabled: false }));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(readPageComponent).toHaveBeenCalledTimes(2);
  });

  it('queues a component refresh received during a source read and keeps the mounted frame through a transient failure', async () => {
    mockCapability.call.mockImplementation(async (method: string) => method === 'read.host' ? { page: { id: 'page-1' }, block } : { rows: [] });
    render(<CustomBlock block={block} pageId="page-1" workspaceId="workspace-1" connectionId="backend-1" />);
    const frame = await screen.findByTestId('sandbox');
    expect(frame.getAttribute('data-stable')).toBe('true');
    expect(frame.getAttribute('data-ready')).toBe('true');
    let finishRead!: (value: Awaited<ReturnType<typeof readPageComponent>>) => void;
    vi.mocked(readPageComponent).mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    const event = { backendConnectionId: 'backend-1', workspaceId: 'workspace-1', componentId: 'component-1' };
    act(() => notifyPageChanged(event));
    expect(readPageComponent).toHaveBeenCalledTimes(2);
    vi.mocked(readPageComponent).mockResolvedValueOnce({ component: { id: 'component-1', enabled: true, name: 'Table widget' } as never, version: { code: 'version two', version: 2, source: { kind: 'user' } } as never });
    act(() => notifyPageChanged(event));
    expect(readPageComponent).toHaveBeenCalledTimes(2);
    await act(async () => finishRead({ component: { id: 'component-1', enabled: true, name: 'Table widget' } as never, version: { code: 'root.textContent = "table"', version: 1, source: { kind: 'user' } } as never }));
    await waitFor(() => expect(frame.getAttribute('data-version')).toBe('2'));
    expect(readPageComponent).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('sandbox')).toBe(frame);
    vi.mocked(readPageComponent).mockRejectedValueOnce(new Error('Temporary connection failure'));
    act(() => notifyPageChanged(event));
    expect(await screen.findByText(/Temporary connection failure/)).toBeTruthy();
    expect(screen.getByTestId('sandbox')).toBe(frame);
    expect(mockCapability.pause).not.toHaveBeenCalled();
    act(() => notifyPageChanged({ ...event, componentId: 'other-component' }));
    expect(readPageComponent).toHaveBeenCalledTimes(4);
  });

  it.each(['disabled', 'forbidden'] as const)('clears the previous view when its source becomes %s', async (reason) => {
    mockCapability.call.mockImplementation(async (method: string) => method === 'read.host' ? { page: { id: 'page-1' }, block } : { rows: [] });
    render(<CustomBlock block={block} pageId="page-1" workspaceId="workspace-1" connectionId="backend-1" />);
    await screen.findByTestId('sandbox');
    if (reason === 'disabled') vi.mocked(readPageComponent).mockResolvedValueOnce({ component: { enabled: false } as never, version: {} as never });
    else vi.mocked(readPageComponent).mockRejectedValueOnce(Object.assign(new Error('Access denied'), { status: 403 }));
    act(() => notifyPageChanged({ backendConnectionId: 'backend-1', workspaceId: 'workspace-1', componentId: 'component-1' }));
    await waitFor(() => expect(screen.queryByTestId('sandbox')).toBeNull());
    expect(vi.mocked(useComponentCapability)).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('keeps the unavailable fallback when an older host read finishes after the source 404', async () => {
    vi.useFakeTimers();
    let resolveHost!: (value: unknown) => void;
    const hostRead = new Promise(resolve => { resolveHost = resolve; });
    mockCapability.call.mockImplementation((method: string) => method === 'read.host' ? hostRead : Promise.resolve({ rows: [] }));
    render(<CustomBlock block={block} pageId="page-1" workspaceId="workspace-1" connectionId="backend-1" />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(mockCapability.call).toHaveBeenCalledWith('read.host', []);

    vi.mocked(readPageComponent).mockRejectedValueOnce(Object.assign(new Error('Component not found'), { status: 404, code: 'not_found' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByText('Component not found')).toBeTruthy();

    await act(async () => {
      resolveHost({ page: { id: 'page-1' }, block });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole('status').textContent).toContain('Component not found');
    expect(screen.queryByText('Loading component…')).toBeNull();
  });
});
