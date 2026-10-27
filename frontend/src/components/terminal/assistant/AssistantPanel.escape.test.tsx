/**
 * Esc in the ⌘J panel with the real composer (TipTap / ProseMirror, which
 * prevents the default of every Escape): it closes the panel unless the
 * composer kept the key for its own popup or an IME composition.
 */
import React, { createRef, useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MentionEditor, { type MentionEditorHandle } from '../../MentionEditor';
import type { MentionRecord } from '../../mentions';
import { AssistantPanelHost } from './AssistantPanel';
import {
  getAssistantSnapshot,
  resetAssistantStoreForTests,
  toggleAssistantPanel,
} from '../../../state/assistant/assistantStore';
import { resetAssistantComposerForTests } from '../../../state/assistant/assistantComposer';

const api = vi.hoisted(() => ({ fetchAssistant: vi.fn() }));
vi.mock('../../../services/api/assistant', async () => {
  const actual = await vi.importActual<typeof import('../../../services/api/assistant')>('../../../services/api/assistant');
  return { ...actual, fetchAssistant: api.fetchAssistant };
});
vi.mock('../../../services/api/persistence', () => ({ fetchWorkspace: vi.fn(), fetchTreeMessages: vi.fn() }));

const editorRef = createRef<MentionEditorHandle>();
function RealComposer({ nodeId }: { nodeId: string }) {
  const [draft, setDraft] = useState<{ value: string; mentions: MentionRecord[] }>({ value: '', mentions: [] });
  return (
    <div data-testid="tpane" data-node={nodeId}>
      <MentionEditor
        ref={editorRef}
        value={draft.value}
        mentions={draft.mentions}
        onChange={setDraft}
        currentNodeId={nodeId}
        sameTreeNodes={[]}
        artifacts={[{ id: 'notes', name: 'Design notes', filePath: 'notes.md', source: 'user', createdAt: 1, updatedAt: 1 }]}
      />
    </div>
  );
}
vi.mock('../TPane', () => ({ default: ({ nodeId }: { nodeId: string }) => <RealComposer nodeId={nodeId} /> }));
vi.mock('../../../state/navigateToNode', () => ({ navigateToNode: vi.fn() }));

const chat = vi.hoisted(() => ({
  nodes: { n1: { nodeId: 'n1', projectId: 'sys', title: 'Assistant', status: 'idle', messages: [], messagesLoaded: true } } as Record<string, unknown>,
  actions: {
    selectProject: vi.fn(), openPane: vi.fn(), openPaneInTree: vi.fn(), activateTree: vi.fn(), setFocusedNodeId: vi.fn(),
    setComposerDraft: vi.fn(), focusPane: vi.fn(), installWorkspaceSnapshot: vi.fn(), dispatch: vi.fn(),
  },
}));
vi.mock('../../../state/chatStore', () => ({
  useChatNode: (id: string) => chat.nodes[id],
  useChatProjects: () => ({ projects: [], activeProjectId: 'w1' }),
  useChatPanes: () => ({ focusedPane: null, openPanes: [] }),
  useChatActions: () => chat.actions,
  useStructuralSelector: (selector: (nodes: unknown) => unknown) => selector(chat.nodes),
  useChatNodeReader: () => (id: string) => chat.nodes[id],
  chatLabel: () => 'New thread',
}));

const INFO = { nodeId: 'n1', workspaceId: 'sys', treeId: 't1', settings: { runtimeId: 'claude', modelId: null, reasoning: null }, supportedRuntimes: ['claude'] };

beforeEach(() => {
  api.fetchAssistant.mockReset().mockResolvedValue(INFO);
  resetAssistantStoreForTests();
});
afterEach(() => {
  act(() => {
    resetAssistantStoreForTests();
    resetAssistantComposerForTests();
  });
});

async function openPanel() {
  render(<AssistantPanelHost page="home" />);
  act(() => { toggleAssistantPanel(); });
  await screen.findByTestId('tpane');
  await waitFor(() => expect(editorRef.current?.editor).toBeTruthy());
  const editor = editorRef.current!.editor!;
  const dom = editor.view.dom as HTMLElement;
  await waitFor(() => expect(document.activeElement).toBe(dom));
  return { editor, dom };
}

/** A real Escape: ProseMirror reads keyCode 27. */
const escape = (target: Element, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(target, { key: 'Escape', code: 'Escape', keyCode: 27, ...init });

describe('Esc in the assistant panel, real composer', () => {
  it('closes the panel from the composer', async () => {
    const { dom } = await openPanel();
    const event = new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true });
    act(() => { dom.dispatchEvent(event); });
    // ProseMirror took the default; the panel closes all the same.
    expect(event.defaultPrevented).toBe(true);
    expect(getAssistantSnapshot().open).toBe(false);
    expect(screen.queryByRole('complementary', { name: 'Assistant' })).toBeNull();
  });

  it('leaves an Esc that closes the @-mention list to the list, then closes on the next', async () => {
    const { editor, dom } = await openPanel();
    await act(async () => { editor.commands.insertContent('@'); });
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());
    escape(dom);
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(getAssistantSnapshot().open).toBe(true);
    escape(dom);
    expect(getAssistantSnapshot().open).toBe(false);
  });

  it('leaves an Esc that closes the /-command menu to the menu', async () => {
    const { editor, dom } = await openPanel();
    await act(async () => { editor.commands.insertContent('/br'); });
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());
    escape(dom);
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(getAssistantSnapshot().open).toBe(true);
  });

  it('leaves an Esc that ends an IME composition to the composition', async () => {
    const { dom } = await openPanel();
    escape(dom, { isComposing: true, keyCode: 229 });
    expect(getAssistantSnapshot().open).toBe(true);
    // Safari reports the Escape that ends a composition after compositionend:
    // isComposing is false, only keyCode 229 says so. The composer marks it.
    escape(dom, { isComposing: false, keyCode: 229 });
    expect(getAssistantSnapshot().open).toBe(true);
    escape(dom);
    expect(getAssistantSnapshot().open).toBe(false);
  });
});
