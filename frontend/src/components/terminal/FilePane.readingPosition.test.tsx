import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';

const H = vi.hoisted(() => {
  const ReactMod = require('react') as typeof import('react');
  return {
    mockFetchArtifactContent: vi.fn(),
    backendConnectionId: undefined as string | undefined,
    mockGetElectron: vi.fn(),
    mockUpdatePaneItem: vi.fn(),
    ChatNodeStoreContext: ReactMod.createContext<unknown>({ getNode: () => undefined }),
  };
});

declare const require: (id: string) => unknown;
const { webcrypto } = require('node:crypto') as { webcrypto: Crypto };

vi.mock('../../services/api', () => ({
  fetchArtifactContent: H.mockFetchArtifactContent,
}));
vi.mock('../../lib/electronBridge', () => ({
  getElectron: H.mockGetElectron,
}));
vi.mock('../../hooks/usePaneShellStyle', () => ({
  usePaneShellStyle: () => ({}),
}));
vi.mock('../MarkdownContent', () => ({ default: ({ text }: { text: string }) => <div data-testid="markdown">{text}</div> }));
vi.mock('../SelectionActions', () => ({ default: () => null }));

vi.mock('../../state/chatStore', () => ({
  ChatNodeStoreContext: H.ChatNodeStoreContext,
  useChatStore: () => ({ focusedNodeId: null }),
  useChatProjects: () => ({
    projects: [{ id: 'p1', name: 'P1', cwd: '/repo', backendConnectionId: H.backendConnectionId }],
  }),
  useChatActions: () => ({
    focusPane: vi.fn(),
    setFocusedNodeId: vi.fn(),
    updatePaneItem: H.mockUpdatePaneItem,
    createChildChat: vi.fn(),
    addPendingComment: vi.fn(),
    setComposerDraft: vi.fn(),
  }),
}));

vi.mock('../../state/prefs', () => ({
  usePrefs: () => ({ prefs: { terminalPalette: 'dark' } }),
}));

import FilePane from './FilePane';
import { PaneViewStateProvider } from './PaneViewState';
import type { FilePaneItem } from '../../state/paneItems';

function makeItem(overrides: Partial<FilePaneItem> = {}): FilePaneItem {
  return {
    id: 'pane:file:1',
    kind: 'file',
    projectId: 'p1',
    treeId: 't1',
    title: 'foo.ts',
    createdAt: 1,
    filePath: '/repo/src/foo.ts',
    viewMode: 'source',
    ...overrides,
  };
}

const FILE_CONTENT = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  H.backendConnectionId = undefined;
  H.mockFetchArtifactContent.mockReset();
  H.mockGetElectron.mockReset();
  H.mockUpdatePaneItem.mockReset();
  H.mockGetElectron.mockReturnValue(null);
  H.mockFetchArtifactContent.mockResolvedValue({
    content: FILE_CONTENT,
    size: FILE_CONTENT.length,
    modifiedAt: 42,
    extension: 'ts',
  });
});

function Page({ item, visible = true, open = true }: { item: FilePaneItem; visible?: boolean; open?: boolean }) {
  return <PaneViewStateProvider items={open ? { [item.id]: item } : {}}>
    {visible && open && <FilePane item={item} />}
  </PaneViewStateProvider>;
}

async function loadedScroll(container: HTMLElement) {
  await waitFor(() => expect(container.querySelector('pre, [data-testid=markdown]')).not.toBeNull());
  return container.querySelector('.term-scrollbar') as HTMLDivElement;
}

describe('FilePane reading position across page navigation', () => {
  it('restores vertical and horizontal position after the page unmounts', async () => {
    const item = makeItem();
    const view = render(<Page item={item} />);
    const scroll = await loadedScroll(view.container);
    scroll.scrollTop = 640;
    scroll.scrollLeft = 80;
    fireEvent.scroll(scroll);
    view.rerender(<Page item={item} visible={false} />);
    expect(view.container.querySelector('pre')).toBeNull();
    view.rerender(<Page item={item} />);
    const restored = await loadedScroll(view.container);
    expect(restored.scrollTop).toBe(640);
    expect(restored.scrollLeft).toBe(80);
    expect(H.mockFetchArtifactContent).toHaveBeenCalledTimes(2);
  });

  it('restores rendered Markdown reading position after page navigation', async () => {
    H.mockFetchArtifactContent.mockResolvedValue({ content: '# document', size: 10, modifiedAt: 42, extension: 'md' });
    const item = makeItem({ filePath: '/repo/doc.md', viewMode: 'rendered' });
    const view = render(<Page item={item} />);
    (await loadedScroll(view.container)).scrollTop = 320;
    view.rerender(<Page item={item} visible={false} />);
    view.rerender(<Page item={item} />);
    expect((await loadedScroll(view.container)).scrollTop).toBe(320);
  });

  it('does not restore a local reading position on a different backend', async () => {
    const item = makeItem();
    const view = render(<Page item={item} />);
    (await loadedScroll(view.container)).scrollTop = 640;
    view.rerender(<Page item={item} visible={false} />);
    H.backendConnectionId = 'remote-other';
    view.rerender(<Page item={item} />);
    expect((await loadedScroll(view.container)).scrollTop).toBe(0);
  });

  it('captures the final position on unmount even without a scroll event', async () => {
    const item = makeItem();
    const view = render(<Page item={item} />);
    (await loadedScroll(view.container)).scrollTop = 520;
    view.rerender(<Page item={item} visible={false} />);
    view.rerender(<Page item={item} />);
    expect((await loadedScroll(view.container)).scrollTop).toBe(520);
  });

  it.each([
    ['tree', { treeId: 'other-tree' }],
    ['workspace', { projectId: 'other-project' }],
    ['instance', { id: 'other-pane' }],
    ['view mode', { viewMode: 'rendered' as const }],
    ['navigation', { sourceLocation: { line: 10 } }],
  ])('does not apply a different %s reading position', async (_name, patch) => {
    const item = makeItem();
    const view = render(<Page item={item} />);
    (await loadedScroll(view.container)).scrollTop = 640;
    view.rerender(<Page item={item} visible={false} />);
    view.rerender(<Page item={{ ...item, ...patch }} />);
    expect((await loadedScroll(view.container)).scrollTop).not.toBe(640);
  });

  it('clears a closed descriptor before the same ID is reopened', async () => {
    const item = makeItem();
    const view = render(<Page item={item} />);
    (await loadedScroll(view.container)).scrollTop = 640;
    view.rerender(<Page item={item} open={false} />);
    view.rerender(<Page item={item} />);
    expect((await loadedScroll(view.container)).scrollTop).toBe(0);
  });

  it('does not restore a reading position onto changed file contents', async () => {
    const item = makeItem();
    const view = render(<Page item={item} />);
    (await loadedScroll(view.container)).scrollTop = 640;
    view.rerender(<Page item={item} visible={false} />);
    H.mockFetchArtifactContent.mockResolvedValue({ content: FILE_CONTENT, size: FILE_CONTENT.length, modifiedAt: 43, extension: 'ts' });
    view.rerender(<Page item={item} />);
    expect((await loadedScroll(view.container)).scrollTop).toBe(0);
  });

  it('preserves reading past an already handled source request on remount', async () => {
    const item = makeItem({ sourceLocation: { line: 10 } });
    const view = render(<Page item={item} />);
    const scroll = await loadedScroll(view.container);
    // Loading text precedes the effect that handles the source-line request.
    await waitFor(() => expect(scroll.scrollTop).toBeGreaterThan(0));
    scroll.scrollTop = 740;
    view.rerender(<Page item={item} visible={false} />);
    view.rerender(<Page item={item} />);
    expect((await loadedScroll(view.container)).scrollTop).toBe(740);
  });
});
