import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRunStatus } from 'michi-shared';
import { agentRunPaneId } from '../../../state/paneItems';

const mocks = vi.hoisted(() => ({
  customAgentsEnabled: true as boolean | undefined,
  closePane: vi.fn(),
  loadRuns: vi.fn(async () => undefined),
  subscribeWorkspace: vi.fn(() => vi.fn()),
  getAgentRunDetail: vi.fn(() => new Promise(() => undefined)),
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
    state: { runs: { '["backend-a","run-1"]': { backendConnectionId: 'backend-a', value: run } }, eventsByRun: {}, interactionsByRun: {} },
    loadRuns: mocks.loadRuns, subscribeWorkspace: mocks.subscribeWorkspace,
    dispatch: vi.fn(), sendInput: vi.fn(), cancel: vi.fn(),
  }),
}));
vi.mock('../../../state/prefs', () => ({ usePrefs: () => ({ prefs: { singlePaneContentWidth: null, defaultPaneWidth: 480 } }) }));
vi.mock('../../../services/api', () => ({
  getAgentRunDetail: mocks.getAgentRunDetail,
  getWebUploadCwd: vi.fn(), importWorkspaceFileUpload: vi.fn(), respondAgentRunInteraction: vi.fn(),
}));
vi.mock('../../../services/notifications', () => ({ notify: vi.fn() }));
vi.mock('../../../lib/electronBridge', () => ({ getElectron: () => null }));
vi.mock('../agentRuns/AgentRunPane', () => ({
  AgentRunPane: ({ onClose }: { onClose: () => void }) => <button onClick={onClose}>Run pane</button>,
}));
vi.mock('../../ResizeHandle', () => ({ default: () => null }));

import TerminalDashboard from './Dashboard';

describe('Dashboard Agent Run panes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.customAgentsEnabled = true;
    HTMLElement.prototype.scrollTo = vi.fn();
  });

  it('renders and closes a Run pane without cancelling the backend Run', async () => {
    render(<TerminalDashboard />);
    const pane = await screen.findByRole('button', { name: 'Run pane' });
    fireEvent.click(pane);
    expect(mocks.closePane).toHaveBeenCalledWith(paneId);
    expect(mocks.subscribeWorkspace).toHaveBeenCalledWith('workspace-1');
  });

  it.each([false, undefined])('does not poll optional Run routes when support is %s', (enabled) => {
    mocks.customAgentsEnabled = enabled;
    render(<TerminalDashboard />);
    expect(mocks.loadRuns).not.toHaveBeenCalled();
    expect(mocks.subscribeWorkspace).not.toHaveBeenCalled();
  });
});
