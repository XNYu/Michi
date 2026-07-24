import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ChatNodeState } from '../../state/chatTypes';

// loadArtifactContent backs BOTH the once-on-mount load and the badge-driven
// manual refresh. The mount effect guards the first load (skips when content is
// already present); the "● Changed on disk · refresh" badge must bypass that guard and
// force a fresh disk read. These tests lock in that split.

// `require` is available at runtime under vitest but the frontend tsconfig has
// no node types; declare it so `tsc --noEmit` doesn't flag TS2591 here.
declare const require: (id: string) => unknown;

// Everything the hoisted vi.mock factories close over must itself be hoisted.
const H = vi.hoisted(() => {
  const ReactMod = require('react') as typeof import('react');
  return {
    mockFetchArtifactContent: vi.fn(),
    mockGetElectron: vi.fn(),
    mockDispatch: vi.fn(),
    mockNodeStore: { getNode: vi.fn(() => undefined) },
    ChatNodeStoreContext: ReactMod.createContext<unknown>({ getNode: () => undefined }),
    // Mutable holder so tests can swap the node the pane renders.
    nodeRef: { current: undefined as ChatNodeState | undefined },
  };
});

vi.mock('../../services/api', () => ({
  fetchArtifactContent: H.mockFetchArtifactContent,
}));
vi.mock('../../lib/electronBridge', () => ({
  getElectron: H.mockGetElectron,
}));
vi.mock('../../hooks/usePaneShellStyle', () => ({
  usePaneShellStyle: () => ({}),
}));
// Keep the render tree light: stub the heavy content/selection children.
vi.mock('../MarkdownContent', () => ({ default: () => null }));
vi.mock('../SelectionActions', () => ({ default: () => null }));

vi.mock('../../state/chatStore', () => ({
  ChatNodeStoreContext: H.ChatNodeStoreContext,
  useChatStore: () => ({
    activeProject: { id: 'w1', name: 'W1', cwd: '/tmp/w1' },
    focusPane: vi.fn(),
    setFocusedNodeId: vi.fn(),
    focusedNodeId: null,
  }),
  useChatActions: () => ({
    dispatch: H.mockDispatch,
    createChildChat: vi.fn(),
    addPendingComment: vi.fn(),
    setComposerDraft: vi.fn(),
  }),
  useChatNode: () => H.nodeRef.current,
}));

// Import after mocks are registered.
import ArtifactPane from './ArtifactPane';

function artifactNode(over: Partial<NonNullable<ChatNodeState['artifact']>> = {}): ChatNodeState {
  return {
    id: 'a1',
    kind: 'artifact',
    projectId: 'w1',
    chatId: null,
    messages: [],
    followUps: [],
    status: 'idle',
    artifact: {
      filePath: '.artifacts/notes.md',
      content: '# v1',
      viewMode: 'source',
      extension: 'md',
      basename: 'notes.md',
      status: 'idle',
      pendingRefresh: true,
      ...over,
    },
  } as unknown as ChatNodeState;
}

beforeEach(() => {
  H.mockFetchArtifactContent.mockReset();
  H.mockGetElectron.mockReset();
  H.mockDispatch.mockReset();
  H.mockNodeStore.getNode.mockReset();
  // No Electron → the HTTP fetch path is exercised (relative filePath anyway).
  H.mockGetElectron.mockReturnValue(null);
  H.mockFetchArtifactContent.mockResolvedValue({
    content: '# v2',
    path: '.artifacts/notes.md',
    basename: 'notes.md',
    extension: 'md',
    size: 4,
    modifiedAt: 222,
  });
});

describe('ArtifactPane loadArtifactContent — mount guard vs. badge refresh', () => {
  it('does NOT re-fetch on mount when content is already loaded (once-guard holds)', () => {
    H.nodeRef.current = artifactNode();
    render(<ArtifactPane nodeId="a1" />);
    // Guard: content !== null → mount effect skips the read entirely.
    expect(H.mockFetchArtifactContent).not.toHaveBeenCalled();
  });

  it('clicking the "Changed on disk" badge forces a fresh read, bypassing the guard', async () => {
    H.nodeRef.current = artifactNode();
    render(<ArtifactPane nodeId="a1" />);
    expect(H.mockFetchArtifactContent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('● Changed on disk · refresh'));

    // Forced read: fetches despite content already being present.
    expect(H.mockFetchArtifactContent).toHaveBeenCalledTimes(1);
    expect(H.mockFetchArtifactContent).toHaveBeenCalledWith('w1', '.artifacts/notes.md');
    // Flips to loading immediately, then loads the fresh content.
    expect(H.mockDispatch).toHaveBeenCalledWith({ type: 'artifact-loading', nodeId: 'a1' });
    await waitFor(() =>
      expect(H.mockDispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'artifact-loaded', nodeId: 'a1', content: '# v2' }),
      ),
    );
  });

  it('clicking the "Deleted on disk" badge also forces a re-read (recovery path)', () => {
    H.nodeRef.current = artifactNode({ pendingRefresh: false, removed: true });
    render(<ArtifactPane nodeId="a1" />);
    fireEvent.click(screen.getByText('⚠ Deleted on disk'));
    expect(H.mockFetchArtifactContent).toHaveBeenCalledTimes(1);
    expect(H.mockDispatch).toHaveBeenCalledWith({ type: 'artifact-loading', nodeId: 'a1' });
  });

  it('does fetch on mount when content is null (first load is NOT skipped)', () => {
    H.nodeRef.current = artifactNode({ content: null, pendingRefresh: false });
    render(<ArtifactPane nodeId="a1" />);
    expect(H.mockFetchArtifactContent).toHaveBeenCalledTimes(1);
    expect(H.mockFetchArtifactContent).toHaveBeenCalledWith('w1', '.artifacts/notes.md');
  });
});
