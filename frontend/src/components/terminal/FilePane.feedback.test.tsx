import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SelectionActionsProps } from '../SelectionActions';
import type { ChatNodeState, Project } from '../../state/chatTypes';
import type { FilePaneItem } from '../../state/paneItems';

declare const require: (id: string) => unknown;
const { webcrypto } = require('node:crypto') as { webcrypto: Crypto };

const H = vi.hoisted(() => ({
  props: null as SelectionActionsProps | null,
  fetch: vi.fn(), comment: vi.fn(), draft: vi.fn(), branch: vi.fn(), update: vi.fn(),
  nodes: {} as Record<string, ChatNodeState>, projects: [] as Project[],
}));
vi.mock('../../services/api', () => ({ fetchArtifactContent: H.fetch }));
vi.mock('../../lib/electronBridge', () => ({ getElectron: () => null }));
vi.mock('../../hooks/usePaneShellStyle', () => ({ usePaneShellStyle: () => ({}) }));
vi.mock('../../state/prefs', () => ({ usePrefs: () => ({ prefs: { terminalPalette: 'dark' } }) }));
vi.mock('../MarkdownContent', () => ({ default: () => null }));
vi.mock('../SelectionActions', () => ({ default: (props: SelectionActionsProps) => { H.props = props; return null; } }));
vi.mock('../../state/chatStore', async () => {
  const ReactModule = await import('react');
  return {
    ChatNodeStoreContext: ReactModule.createContext({ getNode: (id: string) => H.nodes[id] }),
    useChatProjects: () => ({ projects: H.projects }), useChatStore: () => ({}),
    useChatActions: () => ({ focusPane: vi.fn(), setFocusedNodeId: vi.fn(), updatePaneItem: H.update,
      createChildChat: H.branch, addPendingComment: H.comment, setComposerDraft: H.draft }),
  };
});
import FilePane from './FilePane';

const item: FilePaneItem = { id: 'file', kind: 'file', projectId: 'p1', treeId: 't1', originChatNodeId: 'a', title: 'doc', createdAt: 1, filePath: '/doc.txt', viewMode: 'source' };
const v1 = 'first line\nselected 中文🙂 passage\nlast line';
function capture(container: HTMLElement) {
  const text = container.querySelector('pre')!.firstChild!;
  const range = document.createRange();
  range.setStart(text, 11); range.setEnd(text, v1.indexOf('\nlast'));
  return H.props!.captureSelectionContext!(range.toString(), range);
}
async function loaded(container: HTMLElement, text = v1) {
  await waitFor(() => expect(container.querySelector('pre')?.textContent).toBe(text));
}
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  H.nodes = Object.fromEntries(['a','b'].map(nodeId => [nodeId, { nodeId, projectId: 'p1', kind: 'chat', title: `Thread ${nodeId}`, chatId: nodeId, status: 'idle', messages: [], followUps: [] }]));
  H.projects = [{ id: 'p1', name: 'P', chatIds: ['a','b'], edges: [{source:'a',target:'b'}], trees: [{id:'t1',rootNodeId:'a',createdAt:1,lastActiveAt:1}], activeTreeId:'t1', artifacts:[],createdAt:1 }];
  H.fetch.mockReset().mockResolvedValue({ content: v1, size: v1.length, modifiedAt: 1, extension: 'txt' });
  H.comment.mockReset().mockReturnValue(true); H.draft.mockReset(); H.branch.mockReset().mockResolvedValue('child');
});

describe('FilePane captured feedback', () => {
  it('keeps the selected version, selector and target after reload and origin changes', async () => {
    const view = render(<FilePane item={item} />); await loaded(view.container);
    let context: unknown; act(() => { context = capture(view.container); });
    H.fetch.mockResolvedValue({ content: 'v2 completely changed', size: 21, modifiedAt: 2, extension: 'txt' });
    view.rerender(<FilePane item={{...item, originChatNodeId:'b'}} />);
    fireEvent.click(screen.getByRole('button', {name:'Reload file'})); await loaded(view.container, 'v2 completely changed');
    act(() => { expect(H.props!.onComment('selected 中文🙂 passage', 'review this', undefined, context)).toBe(true); });
    expect(H.comment).toHaveBeenCalledWith('a', 'selected 中文🙂 passage', 'review this', expect.objectContaining({
      filePath:'/doc.txt', selector:expect.objectContaining({exact:'selected 中文🙂 passage',startLine:2}),
      snapshot:expect.objectContaining({hashKind:'sha256-text-utf8',contentHash:expect.stringMatching(/^[a-f0-9]{64}$/),modifiedAt:1}),
    }), expect.objectContaining({nodeId:'a',treeId:'t1'}));
    const banner = render(<>{H.props!.renderSelectionContext!(context, vi.fn())}</>);
    expect(banner.getByText(/previously read content/)).toBeTruthy();
  });

  it('rejects an invalid target without falling back and allows explicit replacement', async () => {
    const view = render(<FilePane item={item} />); await loaded(view.container);
    let context: unknown; act(() => { context = capture(view.container); });
    H.nodes.a = {...H.nodes.a, kind:'digest'};
    act(() => { expect(H.props!.onComment('selected', 'keep my input', undefined, context)).toBe(false); });
    expect(H.comment).not.toHaveBeenCalled();
    // The root remains alive, while the chat destination is invalid.
    const picker = render(<>{H.props!.renderSelectionContext!(context, next => { context = next; })}</>);
    fireEvent.change(picker.getByLabelText('File feedback thread'), {target:{value:'b'}});
    act(() => { expect(H.props!.onComment('selected', 'keep my input', undefined, context)).toBe(true); });
    expect(H.comment.mock.calls[0][0]).toBe('b');
  });

  it('retains the same source on quote and branch and does not guess a legacy destination', async () => {
    const view = render(<FilePane item={item} />); await loaded(view.container);
    let context: unknown; act(() => { context = capture(view.container); });
    act(() => { H.props!.onQuote('selected', undefined, context); H.props!.onBranch('selected', 'why?', undefined, undefined, context); });
    expect(H.draft.mock.calls[0][1].quoteSource.snapshot.contentHash).toHaveLength(64);
    expect(H.branch.mock.calls[0][1]).toContain('already-read version');
    expect(H.branch.mock.calls[0][2].quoteSource).toEqual(H.draft.mock.calls[0][1].quoteSource);
    view.rerender(<FilePane item={{...item, originChatNodeId:undefined}} />);
    act(() => { context = capture(view.container); });
    act(() => { expect(H.props!.onQuote('selected', undefined, context)).toBe(false); });
    expect(H.draft).toHaveBeenCalledTimes(1);
  });

  it('isolates backend reads and ignores a digest that finishes after its load was replaced', async () => {
    const realDigest = webcrypto.subtle.digest.bind(webcrypto.subtle);
    let release!: (result: ArrayBuffer) => void;
    const digest = vi.fn().mockImplementationOnce(() => new Promise<ArrayBuffer>(resolve => { release = resolve; }))
      .mockImplementation((algorithm, bytes) => realDigest(algorithm, bytes));
    vi.stubGlobal('crypto', {subtle:{digest}});
    const view = render(<FilePane item={item} />);
    await waitFor(() => expect(digest).toHaveBeenCalledTimes(1));
    H.projects = [{...H.projects[0], backendConnectionId:'remote'}];
    H.fetch.mockResolvedValue({content:'remote text',size:11,modifiedAt:2,extension:'txt'});
    view.rerender(<FilePane item={item} />); await loaded(view.container, 'remote text');
    await act(async () => { release(await realDigest('SHA-256',new TextEncoder().encode(v1))); });
    expect(view.container.querySelector('pre')?.textContent).toBe('remote text');
    expect(H.fetch).toHaveBeenCalledTimes(2);
  });

  it('uses the resolved fallback path in the snapshot', async () => {
    H.fetch.mockImplementation((_project, path) => path.includes(':3') ? Promise.reject(new Error('missing literal'))
      : Promise.resolve({content:v1,size:v1.length,modifiedAt:1,extension:'txt'}));
    const view = render(<FilePane item={{...item,sourceReferencePath:'/doc.txt:3',sourceLocation:{line:3}}} />); await loaded(view.container);
    let context: any; act(() => {context = capture(view.container);});
    expect(context.source.snapshot.resolvedFilePath).toBe('/doc.txt');
  });

  it('requires explicit thread selection for a workspace file without tree ownership', async () => {
    const view = render(<FilePane item={{...item,treeId:null,originChatNodeId:undefined}} />); await loaded(view.container);
    let context: unknown; act(() => {context = capture(view.container);});
    act(() => {expect(H.props!.onQuote('selected',undefined,context)).toBe(false);});
    const picker = render(<>{H.props!.renderSelectionContext!(context,next => {context = next;})}</>);
    fireEvent.change(picker.getByLabelText('File feedback thread'),{target:{value:'b'}});
    act(() => {expect(H.props!.onQuote('selected',undefined,context)).toBe(true);});
    expect(H.draft.mock.calls[0][0]).toBe('b');
  });
});
