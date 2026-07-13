import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ArtifactsDrawer from './ArtifactsDrawer';
import type { ContextEntry } from '../../state/chatTypes';

const { mockImportWorkspaceFile } = vi.hoisted(() => ({
  mockImportWorkspaceFile: vi.fn(),
}));
vi.mock('../../services/api', () => ({
  importWorkspaceFile: mockImportWorkspaceFile,
}));

const mockActions = {
  createContext: vi.fn(),
  updateContext: vi.fn(),
  deleteContext: vi.fn(),
  pinContext: vi.fn(),
};

const mockContexts: ContextEntry[] = [];
let mockProject: { id: string; name: string; cwd?: string; contexts: ContextEntry[] } | null = {
  id: 'p1',
  name: 'P1',
  cwd: '/tmp/p1',
  contexts: mockContexts,
};

vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<any>('../../state/chatStore');
  return {
    ...actual,
    useChatStore: () => ({ activeProject: mockProject, focusedNodeId: null, ...mockActions }),
  };
});

beforeEach(() => {
  mockContexts.length = 0;
  mockProject = { id: 'p1', name: 'P1', cwd: '/tmp/p1', contexts: mockContexts };
  Object.values(mockActions).forEach((fn) => fn.mockReset());
  mockImportWorkspaceFile.mockReset();
  mockImportWorkspaceFile.mockResolvedValue({ name: 'note', filePath: '.contexts/note.md', size: 5 });
});

describe('ArtifactsDrawer + button', () => {
  it('reveals the paste bar when + is clicked', () => {
    render(<ArtifactsDrawer open onClose={() => {}} />);
    expect(screen.queryByPlaceholderText(/Paste a URL/i)).toBeNull();
    fireEvent.click(screen.getByTitle(/Add link or paste text/i));
    expect(screen.getByPlaceholderText(/Paste a URL/i)).toBeTruthy();
  });

  it('saves a pasted URL as a link artifact', () => {
    render(<ArtifactsDrawer open onClose={() => {}} />);
    fireEvent.click(screen.getByTitle(/Add link or paste text/i));
    fireEvent.change(screen.getByPlaceholderText(/Paste a URL/i), {
      target: { value: 'https://stripe.com/docs/refunds' },
    });
    fireEvent.click(screen.getByText('Save'));
    expect(mockActions.createContext).toHaveBeenCalledTimes(1);
    const [name, filePath, opts] = mockActions.createContext.mock.calls[0];
    expect(filePath).toBe('');
    expect(opts).toMatchObject({ url: 'https://stripe.com/docs/refunds', type: 'link' });
    expect(name).toMatch(/stripe/);
  });

  it('saves pasted text as a doc via importWorkspaceFile', async () => {
    render(<ArtifactsDrawer open onClose={() => {}} />);
    fireEvent.click(screen.getByTitle(/Add link or paste text/i));
    fireEvent.change(screen.getByPlaceholderText(/Paste a URL/i), {
      target: { value: 'some free text note' },
    });
    fireEvent.click(screen.getByText('Save'));
    // importWorkspaceFile is async; flush microtasks.
    await Promise.resolve();
    await Promise.resolve();
    expect(mockImportWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(mockActions.createContext).toHaveBeenCalledTimes(1);
  });

  it('uses Favorite language for artifact ordering', () => {
    mockContexts.push({
      id: 'c1',
      name: 'brief.md',
      filePath: '.contexts/brief.md',
      type: 'doc',
      source: 'user',
      pinnedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    render(<ArtifactsDrawer open onClose={() => {}} />);

    fireEvent.click(screen.getByText('brief.md'));
    expect(screen.getByTitle('favorite')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove from favorites' }));
    expect(mockActions.pinContext).toHaveBeenCalledWith('c1');
  });
});
