import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ArtifactsDrawer from './ArtifactsDrawer';
import type { ArtifactEntry } from '../../state/chatTypes';

const { mockImportWorkspaceFile, mockLinkWorkspaceFile, mockOpenPath, mockGetElectron } = vi.hoisted(() => ({
  mockImportWorkspaceFile: vi.fn(),
  mockLinkWorkspaceFile: vi.fn(),
  mockOpenPath: vi.fn(),
  mockGetElectron: vi.fn(),
}));
vi.mock('../../services/api', () => ({
  importWorkspaceFile: mockImportWorkspaceFile,
  linkWorkspaceFile: mockLinkWorkspaceFile,
}));
vi.mock('../../lib/electronBridge', () => ({
  getElectron: mockGetElectron,
}));

const mockActions = {
  createContext: vi.fn(),
  updateContext: vi.fn(),
  deleteContext: vi.fn(),
  pinContext: vi.fn(),
  openArtifactPane: vi.fn(),
};

const mockContexts: ArtifactEntry[] = [];
let mockProject: { id: string; name: string; cwd?: string; artifacts: ArtifactEntry[] } | null = {
  id: 'p1',
  name: 'P1',
  cwd: '/tmp/p1',
  artifacts: mockContexts,
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
  mockProject = { id: 'p1', name: 'P1', cwd: '/tmp/p1', artifacts: mockContexts };
  Object.values(mockActions).forEach((fn) => fn.mockReset());
  mockActions.openArtifactPane.mockResolvedValue('node-1');
  mockImportWorkspaceFile.mockReset();
  mockImportWorkspaceFile.mockResolvedValue({ name: 'note', filePath: '.artifacts/note.md', size: 5 });
  mockLinkWorkspaceFile.mockReset();
  mockLinkWorkspaceFile.mockResolvedValue({ name: 'design-notes', filePath: '.artifacts/design-notes.md', size: 10 });
  mockOpenPath.mockReset();
  mockOpenPath.mockResolvedValue({ ok: true });
  mockGetElectron.mockReset();
  mockGetElectron.mockReturnValue({ openPath: mockOpenPath });
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
      filePath: '.artifacts/brief.md',
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

describe('ArtifactsDrawer open routing', () => {
  const now = 1_700_000_000_000;

  it('opens a reference doc via the OS opener, not the in-app pane', () => {
    // A disk-picked .md is a doc *reference* (absolute path outside the
    // workspace sandbox). The pane endpoint would 404, so it must go to the OS.
    mockContexts.push({
      id: 'ref-doc',
      name: 'design-notes',
      filePath: '/Users/me/Desktop/design-notes.md',
      type: 'doc',
      kind: 'reference',
      source: 'user',
      createdAt: now,
      updatedAt: now,
    });
    render(<ArtifactsDrawer open onClose={() => {}} />);
    fireEvent.click(screen.getByText('design-notes'));
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(mockOpenPath).toHaveBeenCalledWith('/Users/me/Desktop/design-notes.md');
    expect(mockActions.openArtifactPane).not.toHaveBeenCalled();
  });

  it('opens a reference image via the OS opener, not the lightbox', () => {
    mockContexts.push({
      id: 'ref-img',
      name: 'diagram',
      filePath: '/Users/me/Pictures/diagram.png',
      type: 'image',
      kind: 'reference',
      source: 'user',
      createdAt: now,
      updatedAt: now,
    });
    render(<ArtifactsDrawer open onClose={() => {}} />);
    fireEvent.click(screen.getByText('diagram'));
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(mockOpenPath).toHaveBeenCalledWith('/Users/me/Pictures/diagram.png');
    // No lightbox <img> rendered for a reference image.
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('opens an embedded doc in the in-app ArtifactPane', () => {
    mockContexts.push({
      id: 'emb-doc',
      name: 'brief.md',
      filePath: '.artifacts/brief.md',
      type: 'doc',
      kind: 'embedded',
      source: 'user',
      createdAt: now,
      updatedAt: now,
    });
    render(<ArtifactsDrawer open onClose={() => {}} />);
    fireEvent.click(screen.getByText('brief.md'));
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(mockActions.openArtifactPane).toHaveBeenCalledWith('.artifacts/brief.md');
    expect(mockOpenPath).not.toHaveBeenCalled();
  });

  it('opens a symlink artifact via the OS opener, not the in-app pane', () => {
    // A symlinked file has a cwd-relative filePath (under .artifacts/) but points
    // outside the sandbox; the pane/lightbox realpath guard 404s it, so it must
    // resolve to <cwd>/filePath and hand off to the OS opener.
    mockContexts.push({
      id: 'sym-doc',
      name: 'design-notes',
      filePath: '.artifacts/design-notes.md',
      type: 'doc',
      kind: 'symlink',
      source: 'user',
      createdAt: now,
      updatedAt: now,
    });
    render(<ArtifactsDrawer open onClose={() => {}} />);
    fireEvent.click(screen.getByText('design-notes'));
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(mockOpenPath).toHaveBeenCalledWith('/tmp/p1/.artifacts/design-notes.md');
    expect(mockActions.openArtifactPane).not.toHaveBeenCalled();
  });
});

describe('ArtifactsDrawer disk picker → symlink import', () => {
  it('symlinks a picked file into the workspace when a cwd exists', async () => {
    mockGetElectron.mockReturnValue({
      openPath: mockOpenPath,
      chooseFiles: vi.fn().mockResolvedValue({
        canceled: false,
        paths: ['/Users/me/Desktop/design-notes.md'],
      }),
    });
    render(<ArtifactsDrawer open onClose={() => {}} />);
    fireEvent.click(screen.getByTitle(/Add file from disk/i));
    // chooseFiles + linkWorkspaceFile are async; flush microtasks.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockLinkWorkspaceFile).toHaveBeenCalledWith('p1', '/tmp/p1', '/Users/me/Desktop/design-notes.md');
    expect(mockActions.createContext).toHaveBeenCalledTimes(1);
    const [, filePath, opts] = mockActions.createContext.mock.calls[0];
    expect(filePath).toBe('.artifacts/design-notes.md');
    expect(opts).toMatchObject({ kind: 'symlink', type: 'doc', source: 'user' });
  });

  it('falls back to a reference when the workspace has no cwd', async () => {
    mockProject = { id: 'p1', name: 'P1', cwd: undefined, artifacts: mockContexts };
    mockGetElectron.mockReturnValue({
      openPath: mockOpenPath,
      chooseFiles: vi.fn().mockResolvedValue({
        canceled: false,
        paths: ['/Users/me/Desktop/design-notes.md'],
      }),
    });
    render(<ArtifactsDrawer open onClose={() => {}} />);
    fireEvent.click(screen.getByTitle(/Add file from disk/i));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockLinkWorkspaceFile).not.toHaveBeenCalled();
    expect(mockActions.createContext).toHaveBeenCalledTimes(1);
    const [, filePath, opts] = mockActions.createContext.mock.calls[0];
    expect(filePath).toBe('/Users/me/Desktop/design-notes.md');
    expect(opts).toMatchObject({ kind: 'reference', type: 'doc' });
  });
});
