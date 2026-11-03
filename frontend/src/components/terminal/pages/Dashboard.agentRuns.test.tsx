import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRunStatus } from 'michi-shared';
import type { AgentRunPaneProps } from '../agentRuns/AgentRunPane';
import type { AgentDomainState } from '../../../state/agentDomain';
import { agentRunPaneId } from '../../../state/paneItems';

const mocks = vi.hoisted(() => ({
  customAgentsEnabled: true as boolean | undefined,
  closePane: vi.fn(),
  loadRuns: vi.fn(async () => undefined),
  subscribeWorkspace: vi.fn(() => vi.fn()),
  getAgentRunDetail: vi.fn<(...args: unknown[]) => Promise<unknown>>(() => new Promise(() => undefined)),
  respondAgentRunInteraction: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => undefined),
  dispatch: vi.fn(), sendInput: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined),
  state: { runs: {}, eventsByRun: {}, interactionsByRun: {} } as Pick<AgentDomainState, 'runs' | 'eventsByRun' | 'interactionsByRun'>,
}));

const run = {
  id: 'run-1', workspaceId: 'workspace-1', parentNodeId: 'node-1', activeAttemptId: null,
  effectiveDefinition: { name: 'Reviewer' }, status: AgentRunStatus.Running,
};
const paneId = agentRunPaneId('backend-a', 'run-1');
const item = {
  id: paneId, kind: 'agent-run' as const, projectId: 'workspace-1', treeId: null,
  title: 'Reviewer', createdAt: 1, backendConnectionId: 'backend-a', runId: 'run-1',
};

vi.mock('../../../state/chatStore', () => ({
  useChatProjects: () => ({
    activeProject: { id: 'workspace-1', activeTreeId: 'tree-1' },
    agentStatus: { customAgentsEnabled: mocks.customAgentsEnabled },
  }),
  useChatPanes: () => ({
    openPanes: [paneId], focusedPane: paneId, paneItems: { [paneId]: item },
  }),
  useChatActions: () => ({ closePane: mocks.closePane, setPaneWidth: vi.fn(), openAgentRunPane: vi.fn() }),
  useStructuralSelector: (selector: (nodes: Record<string, never>) => unknown) => selector({}),
  shallowArrayEqual: vi.fn(),
}));
vi.mock('../../../state/agentDomain', () => ({
  useAgentDomain: () => ({
    state: mocks.state,
    loadRuns: mocks.loadRuns, subscribeWorkspace: mocks.subscribeWorkspace,
    dispatch: mocks.dispatch, sendInput: mocks.sendInput, cancel: mocks.cancel,
  }),
}));
vi.mock('../../../state/prefs', () => ({ usePrefs: () => ({ prefs: { singlePaneContentWidth: null, defaultPaneWidth: 480 } }) }));
vi.mock('../../../services/api', () => ({
  getAgentRunDetail: mocks.getAgentRunDetail,
  getWebUploadCwd: vi.fn(), importWorkspaceFileUpload: vi.fn(), respondAgentRunInteraction: mocks.respondAgentRunInteraction,
}));
vi.mock('../../../services/notifications', () => ({ notify: vi.fn() }));
vi.mock('../../../lib/electronBridge', () => ({ getElectron: () => null }));
vi.mock('../agentRuns/AgentRunPane', () => ({
  AgentRunPane: ({ onClose, onRespondInteraction, run, attempts }: AgentRunPaneProps) => <div>
    <span>{run.value.id}</span><span>attempts: {attempts?.length ?? 0}</span>
    <button onClick={() => onClose({ backendConnectionId: run.backendConnectionId, id: run.value.id })}>Run pane</button>
    <button disabled={!onRespondInteraction} onClick={() => onRespondInteraction?.(
      { backendConnectionId: run.backendConnectionId, id: run.value.id },
      { id: 'interaction-1' } as Parameters<NonNullable<AgentRunPaneProps['onRespondInteraction']>>[1],
      { decision: 'allow' },
    )}>Respond</button>
  </div>,
}));
vi.mock('../../ResizeHandle', () => ({ default: () => null }));

import TerminalDashboard from './Dashboard';
import AgentRunPaneSurface from '../agentRuns/AgentRunPaneSurface';

function detail(id = 'run-1') {
  return { backendConnectionId: 'backend-a', value: { run: { ...run, id }, attempts: [{ id: `attempt-${id}` }], events: [], interactions: [] } };
}

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('Dashboard Agent Run panes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.customAgentsEnabled = true;
    mocks.getAgentRunDetail.mockReset().mockImplementation(() => new Promise(() => undefined));
    mocks.respondAgentRunInteraction.mockReset().mockResolvedValue(undefined);
    mocks.state = { runs: { '["backend-a","run-1"]': { backendConnectionId: 'backend-a', value: run } as AgentDomainState['runs'][string] }, eventsByRun: {}, interactionsByRun: {} };
    mocks.dispatch.mockImplementation((action) => {
      if (action.type === 'replace-run-feed') mocks.state.runs[JSON.stringify([action.resource.backendConnectionId, action.resource.value.id])] = action.resource;
    });
    HTMLElement.prototype.scrollTo = vi.fn();
  });

  it('renders and closes a Run pane without cancelling the backend Run', async () => {
    render(<TerminalDashboard />);
    const pane = await screen.findByRole('button', { name: 'Run pane' });
    fireEvent.click(pane);
    expect(mocks.closePane).toHaveBeenCalledWith(paneId);
    expect(mocks.subscribeWorkspace).toHaveBeenCalledWith('workspace-1');
  });
  it('shows initial read failure, allows closing, and retries only the read', async () => {
    mocks.state.runs = {};
    mocks.getAgentRunDetail.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(detail());
    render(<AgentRunPaneSurface item={item} />);
    expect((await screen.findByRole('alert')).textContent).toContain('offline');
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close Run Pane' }));
    expect(mocks.closePane).toHaveBeenCalledWith(paneId);
    fireEvent.click(screen.getByRole('button', { name: 'Check current status' }));
    expect(await screen.findByRole('button', { name: 'Run pane' })).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mocks.getAgentRunDetail).toHaveBeenCalledTimes(2);
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.sendInput).not.toHaveBeenCalled();
    expect(mocks.respondAgentRunInteraction).not.toHaveBeenCalled();
  });

  it('keeps existing details visible when refreshing fails', async () => {
    mocks.getAgentRunDetail.mockRejectedValueOnce(new Error('refresh unavailable'));
    render(<AgentRunPaneSurface item={item} />);
    expect((await screen.findByRole('alert')).textContent).toContain('refresh unavailable');
    expect(screen.getByRole('button', { name: 'Run pane' })).not.toBeNull();
    expect(screen.getByText('run-1')).not.toBeNull();
  });

  it('ignores a late read after switching Run identity', async () => {
    mocks.state.runs = {};
    const old = deferred();
    mocks.getAgentRunDetail.mockReturnValueOnce(old.promise).mockResolvedValueOnce(detail('run-2'));
    const { rerender } = render(<AgentRunPaneSurface item={item} />);
    rerender(<AgentRunPaneSurface item={{ ...item, runId: 'run-2' }} />);
    expect(await screen.findByText('run-2')).not.toBeNull();
    await act(async () => old.resolve(detail()));
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('run-1')).toBeNull();
    expect(screen.getByText('attempts: 1')).not.toBeNull();
  });

  it('ignores a late error from the previous backend with the same Run id', async () => {
    const old = deferred();
    mocks.getAgentRunDetail.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ ...detail(), backendConnectionId: 'backend-b' });
    const { rerender } = render(<AgentRunPaneSurface item={item} />);
    rerender(<AgentRunPaneSurface item={{ ...item, backendConnectionId: 'backend-b' }} />);
    await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(1));
    await act(async () => old.reject(new Error('stale backend failure')));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Run pane' })).not.toBeNull();
  });

  it('ignores detail completion after unmount', async () => {
    const pending = deferred();
    mocks.getAgentRunDetail.mockReturnValueOnce(pending.promise);
    const { unmount } = render(<AgentRunPaneSurface item={item} />);
    unmount();
    await act(async () => pending.resolve(detail()));
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('shows an uncertain interaction response and checks status without resending', async () => {
    mocks.getAgentRunDetail.mockResolvedValue(detail());
    mocks.respondAgentRunInteraction.mockRejectedValueOnce(new Error('connection lost'));
    render(<AgentRunPaneSurface item={item} />);
    await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Respond' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Interaction response could not be confirmed');
    expect((screen.getByRole('button', { name: 'Respond' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.getAgentRunDetail).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Check current status' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(mocks.getAgentRunDetail).toHaveBeenCalledTimes(2);
    expect(mocks.respondAgentRunInteraction).toHaveBeenCalledTimes(1);
  });

  it('does not refresh the old identity after an interaction completes late', async () => {
    const response = deferred();
    mocks.respondAgentRunInteraction.mockReturnValueOnce(response.promise);
    mocks.getAgentRunDetail.mockResolvedValueOnce(detail()).mockResolvedValueOnce(detail('run-2'));
    const { rerender } = render(<AgentRunPaneSurface item={item} />);
    await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Respond' }));
    rerender(<AgentRunPaneSurface item={{ ...item, runId: 'run-2' }} />);
    expect(await screen.findByText('run-2')).not.toBeNull();
    await act(async () => response.resolve(undefined));
    expect(mocks.getAgentRunDetail).toHaveBeenCalledTimes(2);
    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps content after a successful response followed by a failed read', async () => {
    mocks.getAgentRunDetail.mockResolvedValueOnce(detail()).mockRejectedValueOnce(new Error('read failed'));
    render(<AgentRunPaneSurface item={item} />);
    await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Respond' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load Agent Run details: read failed');
    expect(screen.getByRole('button', { name: 'Run pane' })).not.toBeNull();
    expect(screen.getByText('attempts: 1')).not.toBeNull();
    expect((screen.getByRole('button', { name: 'Respond' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.respondAgentRunInteraction).toHaveBeenCalledTimes(1);
  });

});

describe('Dashboard page target reveal', () => {
  function revealBlock() {
    const owner = document.createElement('div');
    Object.assign(owner.dataset, { nativePagePane: '', pageId: 'page-1', workspaceId: 'workspace-1', backendConnectionId: 'backend-a' });
    const block = document.createElement('div');
    block.dataset.blockId = 'block-1';
    block.scrollIntoView = vi.fn();
    owner.appendChild(block);
    document.body.appendChild(owner);
    act(() => {
      window.dispatchEvent(new CustomEvent('michi:scroll-to-page-target', { detail: {
        pageId: 'page-1', workspaceId: 'workspace-1', backendConnectionId: 'backend-a',
        resourceKind: 'page', resourceId: 'page-1', targetId: 'block-1',
      } }));
    });
    owner.remove();
    return block.scrollIntoView as ReturnType<typeof vi.fn>;
  }

  beforeEach(() => { HTMLElement.prototype.scrollTo = vi.fn(); });

  it('scrolls a page target into view smoothly, and jumps when the OS reduces motion', () => {
    render(<TerminalDashboard />);
    expect(revealBlock()).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }));
    const matchMedia = window.matchMedia;
    window.matchMedia = vi.fn((query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
    try {
      expect(revealBlock()).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }));
    } finally {
      window.matchMedia = matchMedia;
    }
  });
});
