import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TerminalWorkspaces from './Workspaces';
import { _resetForTest, getManageWorkspaceId } from '../../../state/manageRoute';

const projects = [{
  id: 'ws-x',
  name: 'web-platform',
  chatIds: [],
  edges: [],
  createdAt: 0,
  trees: [],
  activeTreeId: null,
  artifacts: [],
}];

vi.mock('../../../state/chatStore', async () => {
  const actual: any = await vi.importActual('../../../state/chatStore');
  return {
    ...actual,
    useChatStore: () => ({
      projects,
      activeProjectId: null,
      deleteProject: vi.fn(),
    }),
    useChatNodesSnapshot: () => ({}),
    useNodesSelector: () => new Set<string>(),
    useStructuralSelector: () => new Set<string>(),
  };
});

describe('TerminalWorkspaces — row click', () => {
  beforeEach(() => _resetForTest());

  it('clicking a workspace row sets manageWorkspaceId and navigates to workspace-manage', () => {
    const onNav = vi.fn();
    render(<TerminalWorkspaces onNav={onNav} />);
    // The row contains the workspace name; find any element with that text
    // and walk up to find the click handler element. Or simply click the
    // text container — the row's onClick handler bubbles correctly.
    fireEvent.click(screen.getByText('web-platform'));
    expect(getManageWorkspaceId()).toBe('ws-x');
    expect(onNav).toHaveBeenCalledWith('workspace-manage');
  });
});
