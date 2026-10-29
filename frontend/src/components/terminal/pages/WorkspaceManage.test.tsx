import React from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import WorkspaceManage from './WorkspaceManage';

const { uploadMock } = vi.hoisted(() => ({ uploadMock: vi.fn() }));
vi.mock('../../../services/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../services/api')>(),
  importWorkspaceFileUpload: uploadMock,
}));

const baseStoreShape: any = {
  projects: [],
  activeProjectId: null,
  createThread: vi.fn(),
  sendMessage: vi.fn(),
  selectProject: vi.fn(),
  updateContext: vi.fn(),
  deleteContext: vi.fn(),
  toggleAutoInject: vi.fn(),
  createContext: vi.fn(),
  openPane: vi.fn(),
  openPaneInTree: vi.fn(),
  activateTree: vi.fn(),
  setFocusedNodeId: vi.fn(),
  refreshDigest: vi.fn().mockResolvedValue(undefined),
  agentStatus: null,
  refreshAgentStatus: vi.fn(),
  treeSelection: new Set<string>(),
  toggleTreeSelection: vi.fn(),
  clearTreeSelection: vi.fn(),
  selectAllTrees: vi.fn(),
  bulkArchiveTrees: vi.fn(),
  bulkDeleteTrees: vi.fn(),
  bulkUnarchiveTrees: vi.fn(),
  archiveTree: vi.fn(),
  unarchiveTree: vi.fn(),
  pinTree: vi.fn(),
  unpinTree: vi.fn(),
  renameTree: vi.fn(),
  deleteTree: vi.fn(),
  setProjectInstructions: vi.fn(),
};

let mockNodes: Record<string, any> = {};

vi.mock('../../../state/chatStore', async () => {
  const actual: any = await vi.importActual('../../../state/chatStore');
  return {
    ...actual,
    useChatStore: () => baseStoreShape,
    useChatNodesSnapshot: () => mockNodes,
  };
});

vi.mock('../manage/ManageComposer', () => ({
  default: ({ onSubmitted }: { onSubmitted: () => void }) => (
    <button type="button" onClick={onSubmitted}>Submit managed prompt</button>
  ),
}));

function seedWorkspace() {
  mockNodes = {
    a: {
      nodeId: 'a',
      projectId: 'ws1',
      kind: 'chat',
      title: 'Test chat',
      status: 'idle',
      messages: [],
      followUps: [],
      createdAt: 0,
    },
  };
  baseStoreShape.activeProjectId = 'ws1';
  baseStoreShape.projects = [{
    id: 'ws1',
    name: 'web-platform',
    cwd: '~/projects/web',
    chatIds: ['a'],
    edges: [],
    createdAt: 0,
    trees: [{ id: 't1', rootNodeId: 'a', createdAt: 0, lastActiveAt: Date.now() }],
    activeTreeId: 't1',
    artifacts: [
      { id: 'ctx', name: 'a.md', filePath: 'a.md', source: 'user', createdAt: 0, updatedAt: 0 },
    ],
  }];
}

describe('WorkspaceManage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    baseStoreShape.projects = [];
    baseStoreShape.activeProjectId = null;
    baseStoreShape.treeSelection = new Set<string>();
    mockNodes = {};
  });

  it('shows empty state when workspace not found', () => {
    baseStoreShape.projects = [];
    render(<WorkspaceManage workspaceId="missing" onNav={() => {}} />);
    expect(screen.queryByText(/workspace not found/i)).not.toBeNull();
  });

  it('activates the managed workspace before its composer can create a thread', () => {
    seedWorkspace();
    baseStoreShape.activeProjectId = 'another-workspace';

    render(<WorkspaceManage workspaceId="ws1" onNav={() => {}} />);

    expect(baseStoreShape.selectProject).toHaveBeenCalledWith('ws1');
  });

  it('opens, rebuilds, and exports a digest with visible destinations', () => {
    seedWorkspace();
    mockNodes.digest = {
      nodeId: 'digest',
      projectId: 'ws1',
      kind: 'digest',
      title: 'Weekly digest',
      status: 'idle',
      messages: [],
      followUps: [],
      createdAt: 1,
      digest: {
        sources: ['a'],
        sourceCount: 1,
        content: '# Weekly digest\nSummary',
        generatedAt: 2,
        viewedAt: 0,
        status: 'idle',
        sourceFingerprints: {},
      },
    };
    baseStoreShape.projects[0].chatIds.push('digest');
    const onNav = vi.fn();
    const exportSpy = vi.fn();
    window.addEventListener('michi:toggle-export-panel', exportSpy as EventListener);
    try {
      render(<WorkspaceManage workspaceId="ws1" onNav={onNav} />);
      fireEvent.click(screen.getByRole('button', { name: /Digests/i }));

      fireEvent.click(screen.getByRole('button', { name: /open/i }));
      expect(baseStoreShape.openPaneInTree).toHaveBeenCalledWith('ws1', 't1', 'digest');
      expect(baseStoreShape.activateTree).toHaveBeenCalledWith('t1', 'ws1');
      expect(baseStoreShape.setFocusedNodeId).toHaveBeenCalledWith('digest');
      expect(onNav).toHaveBeenCalledWith('dashboard');

      fireEvent.click(screen.getByRole('button', { name: /rebuild/i }));
      expect(baseStoreShape.refreshDigest).toHaveBeenCalledWith('digest');

      fireEvent.click(screen.getByRole('button', { name: /export/i }));
      expect(exportSpy).toHaveBeenCalledOnce();
      const event = exportSpy.mock.calls[0][0] as CustomEvent;
      expect(event.detail).toEqual({ projectId: 'ws1', digestNodeId: 'digest' });
    } finally {
      window.removeEventListener('michi:toggle-export-panel', exportSpy as EventListener);
    }
  });
});

it('classifies uploaded remote images and unknown formats without treating them as documents', async () => {
  seedWorkspace();
  baseStoreShape.projects[0].backendConnectionId = 'remote';
  baseStoreShape.createContext.mockClear();
  uploadMock.mockResolvedValueOnce({ name: 'shot', filePath: '.artifacts/shot.png', size: 3 })
    .mockResolvedValueOnce({ name: 'data', filePath: '.artifacts/data.custom', size: 2 });
  const { container } = render(<WorkspaceManage workspaceId="ws1" onNav={() => {}} />);
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [new File(['png'], 'shot.png'), new File(['xx'], 'data.custom')] },
  });
  await waitFor(() => expect(baseStoreShape.createContext).toHaveBeenCalledTimes(2));
  expect(baseStoreShape.createContext).toHaveBeenCalledWith('shot', '.artifacts/shot.png', expect.objectContaining({ type: 'image' }));
  expect(baseStoreShape.createContext).toHaveBeenCalledWith('data', '.artifacts/data.custom', expect.objectContaining({ type: 'file' }));
});
