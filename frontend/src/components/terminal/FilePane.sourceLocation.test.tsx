import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';

const H = vi.hoisted(() => {
  const ReactMod = require('react') as typeof import('react');
  return {
    mockFetchArtifactContent: vi.fn(),
    mockGetElectron: vi.fn(),
    mockUpdatePaneItem: vi.fn(),
    ChatNodeStoreContext: ReactMod.createContext<unknown>({ getNode: () => undefined }),
  };
});

declare const require: (id: string) => unknown;

vi.mock('../../services/api', () => ({
  fetchArtifactContent: H.mockFetchArtifactContent,
}));
vi.mock('../../lib/electronBridge', () => ({
  getElectron: H.mockGetElectron,
}));
vi.mock('../../hooks/usePaneShellStyle', () => ({
  usePaneShellStyle: () => ({}),
}));
vi.mock('../MarkdownContent', () => ({ default: () => null }));
vi.mock('../SelectionActions', () => ({ default: () => null }));

vi.mock('../../state/chatStore', () => ({
  ChatNodeStoreContext: H.ChatNodeStoreContext,
  useChatStore: () => ({ focusedNodeId: null }),
  useChatProjects: () => ({
    projects: [{ id: 'p1', name: 'P1', cwd: '/repo' }],
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

function renderPane(item: FilePaneItem) {
  return render(
    <H.ChatNodeStoreContext.Provider value={{ getNode: () => undefined }}>
      <FilePane item={item} />
    </H.ChatNodeStoreContext.Provider>,
  );
}

function rect(top: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    right: 100,
    bottom: top + 20,
    left: 0,
    width: 100,
    height: 20,
    toJSON: () => ({}),
  } as DOMRect;
}

function prepareScrollGeometry(container: HTMLElement) {
  const scrollContainer = container.querySelector('.term-scrollbar') as HTMLDivElement;
  const pre = container.querySelector('pre') as HTMLPreElement;
  Object.defineProperty(scrollContainer, 'clientHeight', { configurable: true, value: 200 });
  scrollContainer.getBoundingClientRect = vi.fn(() => rect(0));
  pre.getBoundingClientRect = vi.fn(() => rect(20 - scrollContainer.scrollTop));
  scrollContainer.scrollTop = 0;
  return { pre, scrollContainer };
}

const FILE_CONTENT = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');

beforeEach(() => {
  H.mockFetchArtifactContent.mockReset();
  H.mockGetElectron.mockReset();
  H.mockUpdatePaneItem.mockReset();
  H.mockGetElectron.mockReturnValue(null);
  H.mockFetchArtifactContent.mockResolvedValue({
    content: FILE_CONTENT,
    size: FILE_CONTENT.length,
    modifiedAt: Date.now(),
    extension: 'ts',
  });
});

describe('FilePane source locations', () => {
  it('keeps source content in one text node instead of creating one element per line', async () => {
    const { container } = renderPane(makeItem());

    await waitFor(() => {
      const pre = container.querySelector('pre');
      expect(pre?.textContent).toBe(FILE_CONTENT);
      expect(pre?.childElementCount).toBe(0);
    });
  });

  it('preserves source text exactly without adding a trailing newline', async () => {
    H.mockFetchArtifactContent.mockResolvedValue({
      content: 'alpha\nbeta',
      size: 10,
      modifiedAt: Date.now(),
      extension: 'ts',
    });
    const { container } = renderPane(makeItem());

    await waitFor(() => {
      expect(container.querySelector('pre')?.textContent).toBe('alpha\nbeta');
    });
  });

  it('navigates again when the same source location is reopened', async () => {
    const view = renderPane(makeItem());
    await waitFor(() => expect(view.container.querySelector('pre')).toBeTruthy());
    const { scrollContainer } = prepareScrollGeometry(view.container);
    const firstLocation = { line: 414 };

    view.rerender(
      <H.ChatNodeStoreContext.Provider value={{ getNode: () => undefined }}>
        <FilePane item={makeItem({ sourceLocation: firstLocation })} />
      </H.ChatNodeStoreContext.Provider>,
    );
    await waitFor(() => expect(scrollContainer.scrollTop).toBeGreaterThan(0));

    scrollContainer.scrollTop = 0;
    view.rerender(
      <H.ChatNodeStoreContext.Provider value={{ getNode: () => undefined }}>
        <FilePane item={makeItem({ sourceLocation: { line: 414 } })} />
      </H.ChatNodeStoreContext.Provider>,
    );
    await waitFor(() => expect(scrollContainer.scrollTop).toBeGreaterThan(0));
  });

  it('repositions when the same location returns from rendered to source mode', async () => {
    H.mockFetchArtifactContent.mockResolvedValue({
      content: FILE_CONTENT,
      size: FILE_CONTENT.length,
      modifiedAt: Date.now(),
      extension: 'md',
    });
    const view = renderPane(makeItem({ filePath: '/repo/doc.md' }));
    await waitFor(() => expect(view.container.querySelector('pre')).toBeTruthy());
    const { scrollContainer } = prepareScrollGeometry(view.container);
    const location = { line: 100 };

    view.rerender(
      <H.ChatNodeStoreContext.Provider value={{ getNode: () => undefined }}>
        <FilePane item={makeItem({ filePath: '/repo/doc.md', sourceLocation: location })} />
      </H.ChatNodeStoreContext.Provider>,
    );
    await waitFor(() => expect(scrollContainer.scrollTop).toBeGreaterThan(0));

    view.rerender(
      <H.ChatNodeStoreContext.Provider value={{ getNode: () => undefined }}>
        <FilePane item={makeItem({ filePath: '/repo/doc.md', sourceLocation: location, viewMode: 'rendered' })} />
      </H.ChatNodeStoreContext.Provider>,
    );
    scrollContainer.scrollTop = 0;
    view.rerender(
      <H.ChatNodeStoreContext.Provider value={{ getNode: () => undefined }}>
        <FilePane item={makeItem({ filePath: '/repo/doc.md', sourceLocation: location })} />
      </H.ChatNodeStoreContext.Provider>,
    );
    await waitFor(() => expect(scrollContainer.scrollTop).toBeGreaterThan(0));
  });

  it('clamps an out-of-range source location to the final line', async () => {
    const view = renderPane(makeItem());
    await waitFor(() => expect(view.container.querySelector('pre')).toBeTruthy());
    const { scrollContainer } = prepareScrollGeometry(view.container);

    view.rerender(
      <H.ChatNodeStoreContext.Provider value={{ getNode: () => undefined }}>
        <FilePane item={makeItem({ sourceLocation: { line: 500 } })} />
      </H.ChatNodeStoreContext.Provider>,
    );
    await waitFor(() => expect(scrollContainer.scrollTop).toBeGreaterThan(0));
    const finalLineTop = scrollContainer.scrollTop;

    view.rerender(
      <H.ChatNodeStoreContext.Provider value={{ getNode: () => undefined }}>
        <FilePane item={makeItem({ sourceLocation: { line: 999 } })} />
      </H.ChatNodeStoreContext.Provider>,
    );
    await waitFor(() => expect(scrollContainer.scrollTop).toBe(finalLineTop));
  });

  it('does not reinterpret a failed numeric-colon path as another file', async () => {
    const rawPath = '/repo/report:2024';
    const readFile = vi.fn(async (filePath: string) => (
      filePath === rawPath
        ? null
        : { content: 'wrong file', size: 10, modifiedAt: 1 }
    ));
    H.mockGetElectron.mockReturnValue({
      statFile: vi.fn().mockResolvedValue({ size: 10, modifiedAt: 1 }),
      readFile,
    });

    const { container } = renderPane(makeItem({ filePath: rawPath, title: 'report:2024' }));
    await waitFor(() => expect(container.textContent).toContain('File is not readable'));
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith(rawPath);
  });

  it('reads a valid numeric-colon filename without treating it as a location', async () => {
    const filePath = '/repo/report:2024';
    const readFile = vi.fn().mockResolvedValue({
      content: 'annual report',
      size: 13,
      modifiedAt: 1,
    });
    H.mockGetElectron.mockReturnValue({
      statFile: vi.fn().mockResolvedValue({ size: 13, modifiedAt: 1 }),
      readFile,
    });

    const { container } = renderPane(makeItem({ filePath, title: 'report:2024' }));
    await waitFor(() => expect(container.querySelector('pre')?.textContent).toBe('annual report'));
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith(filePath);
  });

  it('reads a valid source-reference candidate literally when that path exists', async () => {
    const rawPath = '/repo/report:2024';
    const readFile = vi.fn().mockResolvedValue({
      content: 'literal report',
      size: 14,
      modifiedAt: 1,
    });
    H.mockGetElectron.mockReturnValue({
      statFile: vi.fn().mockResolvedValue({ size: 14, modifiedAt: 1 }),
      readFile,
    });

    const { container } = renderPane(makeItem({
      filePath: '/repo/report',
      sourceLocation: { line: 2024 },
      sourceReferencePath: rawPath,
    }));
    await waitFor(() => expect(container.querySelector('pre')?.textContent).toBe('literal report'));
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith(rawPath);
    expect(container.textContent).not.toContain('source reference');
  });

  it('re-resolves changed source candidates and re-navigates repeated source links', async () => {
    const cleanPath = '/repo/src/foo.ts';
    const firstRawPath = `${cleanPath}:100`;
    const secondRawPath = `${cleanPath}:200`;
    const readFile = vi.fn(async (filePath: string) => (
      filePath === cleanPath
        ? { content: FILE_CONTENT, size: FILE_CONTENT.length, modifiedAt: 1 }
        : null
    ));
    H.mockGetElectron.mockReturnValue({
      statFile: vi.fn(async (filePath: string) => (
        filePath === cleanPath ? { size: FILE_CONTENT.length, modifiedAt: 1 } : null
      )),
      readFile,
    });

    const view = renderPane(makeItem({
      filePath: cleanPath,
      sourceLocation: { line: 100 },
      sourceReferencePath: firstRawPath,
    }));
    await waitFor(() => expect(view.container.querySelector('pre')).toBeTruthy());
    let geometry = prepareScrollGeometry(view.container);

    view.rerender(
      <H.ChatNodeStoreContext.Provider value={{ getNode: () => undefined }}>
        <FilePane item={makeItem({
          filePath: cleanPath,
          sourceLocation: { line: 100 },
          sourceReferencePath: firstRawPath,
        })} />
      </H.ChatNodeStoreContext.Provider>,
    );
    await waitFor(() => expect(geometry.scrollContainer.scrollTop).toBeGreaterThan(0));
    const firstLineTop = geometry.scrollContainer.scrollTop;

    view.rerender(
      <H.ChatNodeStoreContext.Provider value={{ getNode: () => undefined }}>
        <FilePane item={makeItem({
          filePath: cleanPath,
          sourceLocation: { line: 200 },
          sourceReferencePath: secondRawPath,
        })} />
      </H.ChatNodeStoreContext.Provider>,
    );
    await waitFor(() => expect(readFile).toHaveBeenCalledWith(secondRawPath));
    await waitFor(() => expect(view.container.querySelector('pre')).toBeTruthy());
    geometry = prepareScrollGeometry(view.container);
    view.rerender(
      <H.ChatNodeStoreContext.Provider value={{ getNode: () => undefined }}>
        <FilePane item={makeItem({
          filePath: cleanPath,
          sourceLocation: { line: 200 },
          sourceReferencePath: secondRawPath,
        })} />
      </H.ChatNodeStoreContext.Provider>,
    );
    await waitFor(() => expect(geometry.scrollContainer.scrollTop).toBeGreaterThan(firstLineTop));
    expect(readFile.mock.calls.map(([filePath]) => filePath)).toEqual([
      firstRawPath,
      cleanPath,
      secondRawPath,
      cleanPath,
    ]);
  });

  it('shows sourceLocation in the header', async () => {
    const { container } = renderPane(makeItem({ sourceLocation: { line: 414 } }));

    await waitFor(() => {
      const header = container.querySelector('[title="/repo/src/foo.ts"]');
      expect(header?.textContent).toContain(':414');
    });
  });

  it('shows line and column in the header', async () => {
    const { container } = renderPane(makeItem({ sourceLocation: { line: 42, column: 10 } }));

    await waitFor(() => {
      const header = container.querySelector('[title="/repo/src/foo.ts"]');
      expect(header?.textContent).toContain(':42:10');
    });
  });

  it('opens a Windows absolute path externally without prefixing the workspace cwd', async () => {
    const filePath = 'C:\\Users\\me\\foo.ts';
    const openPath = vi.fn();
    H.mockGetElectron.mockReturnValue({
      statFile: vi.fn().mockResolvedValue({ size: 7, modifiedAt: 1 }),
      readFile: vi.fn().mockResolvedValue({ content: 'content', size: 7, modifiedAt: 1 }),
      openPath,
    });

    const { container, getByRole } = renderPane(makeItem({ filePath, title: 'foo.ts' }));
    await waitFor(() => expect(container.querySelector('pre')?.textContent).toBe('content'));
    expect(container.textContent).toContain('foo.ts');
    fireEvent.click(getByRole('button', { name: 'Open externally' }));
    expect(openPath).toHaveBeenCalledWith(filePath);
  });

  it('treats a Windows UNC path as local and opens it unchanged', async () => {
    const filePath = '\\\\server\\share\\foo.ts';
    const openPath = vi.fn();
    const readFile = vi.fn().mockResolvedValue({ content: 'content', size: 7, modifiedAt: 1 });
    H.mockGetElectron.mockReturnValue({
      statFile: vi.fn().mockResolvedValue({ size: 7, modifiedAt: 1 }),
      readFile,
      openPath,
    });

    const { container, getByRole } = renderPane(makeItem({ filePath, title: 'foo.ts' }));
    await waitFor(() => expect(container.querySelector('pre')?.textContent).toBe('content'));
    expect(readFile).toHaveBeenCalledWith(filePath);
    fireEvent.click(getByRole('button', { name: 'Open externally' }));
    expect(openPath).toHaveBeenCalledWith(filePath);
  });
});
