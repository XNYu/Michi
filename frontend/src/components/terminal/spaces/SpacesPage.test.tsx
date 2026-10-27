import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createPage: vi.fn(), getMaintenance: vi.fn(), excludeSpace: vi.fn(), firstRun: vi.fn() }));

vi.mock('../../../state/chatStore', () => ({ useChatProjects: () => ({ projects: [
  { id: 'ws-local', name: 'Local workspace', backendConnectionId: 'local' },
  { id: 'remote-ws', name: 'Remote workspace', backendConnectionId: 'remote-1' },
], activeProject: null }) }));
vi.mock('./home/SpacesHome', () => ({ default: () => <h1>Home</h1> }));
vi.mock('./home/WorkspaceHome', () => ({ default: ({ workspaceId, backendConnectionId, onOpenPage }: { workspaceId: string; backendConnectionId: string; onOpenPage: (route: unknown) => void }) => (
  <button type="button" onClick={() => onOpenPage({ pageId: 'space-1', workspaceId, backendConnectionId })}>{`Home of ${workspaceId}`}</button>
) }));
vi.mock('./allTasks/AllTasksPage', () => ({ default: () => <h1>All tasks</h1> }));
vi.mock('../../../config/backendConnections', () => ({
  backendConnectionIdForWorkspace: (id: string) => id === 'remote-ws' ? 'remote-1' : 'local',
  getKnownBackendConnections: () => [{ id: 'local', name: 'Local' }, { id: 'remote-1', name: 'Research server' }],
}));
vi.mock('../../../services/api/pages', () => ({ createPage: mocks.createPage }));
vi.mock('../../../state/metaAgent/spacesFirstRun', () => ({ useSpacesFirstRun: mocks.firstRun }));
vi.mock('../../../services/api/pageMaintenance', () => ({ getPageMaintenance: mocks.getMaintenance, setPageMaintenanceSpaceExcluded: mocks.excludeSpace }));

import { CreateSpaceDialog, SpacesPage } from './SpacesPage';
import { act } from '@testing-library/react';
import { requestWorkspaceHome } from '../../../state/pages/workspaceHomeNav';

describe('Spaces main area', () => {
  it('shows All tasks', async () => {
    render(<SpacesPage target={{ kind: 'all-tasks' }} onOpenPage={vi.fn()} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'All tasks' })).toBeTruthy();
  });

  beforeEach(() => {
    mocks.createPage.mockReset();
    mocks.getMaintenance.mockReset().mockResolvedValue({ excludedSpaceIds: [], config: null, backlog: { plans: [], pendingSources: 0, attentionSources: 0 }, status: null, job: null });
    mocks.excludeSpace.mockReset().mockResolvedValue({});
    mocks.firstRun.mockReset();
  });

  it('starts the Meta agent’s first run on every visit', () => {
    render(<SpacesPage target={{ kind: 'home' }} onOpenPage={vi.fn()} />);
    expect(mocks.firstRun).toHaveBeenCalledWith('local', { start: true });
  });

  it('shows a workspace home nobody else answered for, until the shell’s own target changes', async () => {
    const view = render(<SpacesPage target={{ kind: 'home' }} onOpenPage={vi.fn()} />);
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    act(() => requestWorkspaceHome({ workspaceId: 'ws-local', backendConnectionId: 'local' }));
    expect(await screen.findByRole('button', { name: 'Home of ws-local' })).toBeTruthy();
    view.rerender(<SpacesPage target={{ kind: 'workspace', workspaceId: 'remote-ws', backendConnectionId: 'remote-1' }} onOpenPage={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Home of remote-ws' })).toBeTruthy();
  });

  it('lands on the global Home instead of a management table', async () => {
    render(<SpacesPage target={{ kind: 'home' }} onOpenPage={vi.fn()} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows a workspace home that opens the workspace Spaces', async () => {
    const onOpenPage = vi.fn();
    render(<SpacesPage target={{ kind: 'workspace', workspaceId: 'ws-local', backendConnectionId: 'local' }} onOpenPage={onOpenPage} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Home of ws-local' }));
    expect(onOpenPage).toHaveBeenCalledWith({ pageId: 'space-1', workspaceId: 'ws-local', backendConnectionId: 'local' });
  });

  it('creates a Space in the selected backend workspace and reports its exact route', async () => {
    mocks.createPage.mockResolvedValue({ id: 'remote-page', workspaceId: 'remote-ws' });
    const onCreated = vi.fn();
    render(<CreateSpaceDialog activeWorkspaceId="ws-local" onClose={vi.fn()} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText('Backend'), { target: { value: 'remote-1' } });
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: 'remote-ws' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Field notes' } });
    fireEvent.change(screen.getByLabelText('Starting point'), { target: { value: 'research' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create page' }));
    await waitFor(() => expect(mocks.createPage).toHaveBeenCalledWith(
      { workspaceId: 'remote-ws', title: 'Field notes', template: 'research' },
      { backendConnectionId: 'remote-1', workspaceId: 'remote-ws' },
    ));
    await waitFor(() => expect(mocks.excludeSpace).toHaveBeenCalledWith('remote-page', true, 0, { backendConnectionId: 'remote-1', workspaceId: 'remote-ws' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ pageId: 'remote-page', workspaceId: 'remote-ws', backendConnectionId: 'remote-1' }));
  });
});
