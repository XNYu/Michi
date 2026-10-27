/**
 * A jump from a page's source into its conversation: TPane scrolls the cited
 * message to the middle once, then Continue puts the cursor in the composer
 * and Open leaves it out. Real TPane with stubbed children, as in
 * TPane.scrollSave.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, act } from '@testing-library/react';

const focusState = vi.hoisted(() => ({ focused: null as string | null, focus: vi.fn(), scrolled: [] as string[], editorReady: true }));

if (typeof (globalThis as any).CSS === 'undefined') (globalThis as any).CSS = {};
if (!(globalThis as any).CSS.highlights) (globalThis as any).CSS.highlights = new Map();
if (typeof (globalThis as any).Highlight === 'undefined') {
  (globalThis as any).Highlight = class Highlight { constructor(..._r: any[]) {} };
}
if (typeof window.matchMedia !== 'function') {
  (window as any).matchMedia = () => ({
    matches: false, media: '', onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
}

const anyFn = () => new Proxy({}, { get: () => vi.fn() });

vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<any>('../../state/chatStore');
  const messages = Array.from({ length: 6 }, (_, i) => ({
    id: `m${i + 1}`, role: i % 2 === 0 ? 'user' : 'assistant', text: `msg ${i + 1}`, content: `msg ${i + 1}`,
    createdAt: (i + 1) * 100, toolCalls: [], blocks: [],
  }));
  const node = {
    id: 'node1', nodeId: 'node1', chatId: 'chat1', projectId: 'p1', kind: 'chat', status: 'idle', messages, followUps: [],
    followUpsGenerating: false, title: 'Test thread', pendingComments: [], queuedMessages: [], injectedContexts: [],
  };
  return {
    ...actual,
    useChatActions: anyFn,
    useChatStore: () => ({ focusedPane: null }),
    useChatProjects: () => ({
      availableModes: [], agentStatus: null, refreshAgentStatus: vi.fn(),
      activeProject: { id: 'p1', name: 'P', artifacts: [], edges: [], chatIds: ['node1'], trees: [{ id: 't1', rootNodeId: 'node1' }], activeTreeId: 't1' },
    }),
    useChatPanes: () => ({ focusedPane: focusState.focused, openPanes: [], focusNonce: 0, paneItems: {}, viewMode: 'single' as const }),
    useChatNode: () => node,
    useStructuralSelector: (sel: any) => { try { return sel({}); } catch { return undefined; } },
  };
});
vi.mock('../../state/prefs', () => ({ usePrefs: () => ({ prefs: {}, setPref: vi.fn() }) }));
vi.mock('../../services/api', () => ({
  listAgentModels: vi.fn(async () => []),
  saveAgentOptions: vi.fn(async () => {}),
  getWebUploadCwd: vi.fn(async () => null),
  importWorkspaceFileUpload: vi.fn(async () => ({ filePath: '', displayName: '' })),
}));
vi.mock('./PaneMessageList', () => ({
  PaneMessageList: () => (
    <div>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} data-msg-id={`m${i + 1}`} ref={(el) => { if (el) el.scrollIntoView = () => { focusState.scrolled.push(`m${i + 1}`); }; }}>msg</div>
      ))}
    </div>
  ),
}));
vi.mock('./ComposerShell', () => ({ ComposerShell: React.forwardRef((p: any, _r: any) => p.input) }));
vi.mock('./PaneComposerPreBlocks', () => ({ PaneComposerPreBlocks: () => null }));
vi.mock('./PaneComposerActions', () => ({ PaneComposerActions: () => null }));
vi.mock('./PaneComposerToolbarLeft', () => ({ PaneComposerToolbarLeft: () => null }));
vi.mock('./PaneAgentMenus', () => ({ PaneAgentMenus: () => null }));
vi.mock('./PaneFind', () => ({ default: () => null, PaneFind: () => null }));
vi.mock('./PermissionBanner', () => ({ default: () => null, PermissionBanner: () => null }));
vi.mock('./MergeBanner', () => ({ default: () => null, MergeBanner: () => null }));
vi.mock('./PaneDragOverlays', () => ({ FileDropOverlay: () => null, PaneDropIndicator: () => null }));
vi.mock('../MentionEditor', () => ({ default: React.forwardRef((_p, ref) => {
  React.useImperativeHandle(ref, () => ({ get editor() { return focusState.editorReady ? { commands: { focus: focusState.focus } } : null; } }));
  return null;
}) }));
vi.mock('../SelectionActions', () => ({ default: () => null }));
vi.mock('../UploadProgressBar', () => ({ default: () => null }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

async function load() {
  vi.resetModules();
  const [{ default: TPane }, nav] = await Promise.all([import('./TPane'), import('../../state/sourceNav/sourceNav')]);
  nav.registerSourceNavigator({ currentOrigin: () => ({ kind: 'home', title: 'Home' }), reveal: async () => true, returnTo: () => {} });
  return { TPane, nav };
}

describe('TPane: jump from a page source', () => {
  beforeEach(() => { vi.useFakeTimers(); window.localStorage.clear(); focusState.editorReady = true; });
  afterEach(async () => {
    cleanup();
    focusState.focused = null;
    focusState.focus.mockClear();
    focusState.scrolled = [];
    try { await act(async () => { await vi.advanceTimersByTimeAsync(1300); }); } finally { vi.useRealTimers(); }
  });

  it('Continue scrolls to the cited message once and puts the cursor in the composer', async () => {
    const { TPane, nav } = await load();
    await nav.openConversationFromSpaces({ backendConnectionId: 'local', workspaceId: 'p1', nodeId: 'node1', messageId: 'm4', focus: true });
    const { unmount } = render(<TPane nodeId="node1" />);
    await act(async () => { await vi.dynamicImportSettled(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(focusState.scrolled[0]).toBe('m4');
    expect(focusState.focus).toHaveBeenCalledWith('end', { scrollIntoView: false });
    unmount();
    focusState.scrolled = [];
    focusState.focus.mockClear();
    render(<TPane nodeId="node1" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(focusState.scrolled).toEqual([]);
    expect(focusState.focus).not.toHaveBeenCalledWith('end', { scrollIntoView: false });
  });

  it('Continue waits for the lazy composer after its cited message is ready', async () => {
    const { TPane, nav } = await load();
    focusState.editorReady = false;
    await nav.openConversationFromSpaces({ backendConnectionId: 'local', workspaceId: 'p1', nodeId: 'node1', messageId: 'm4', focus: true });
    render(<TPane nodeId="node1" />);
    await act(async () => { await vi.dynamicImportSettled(); await vi.advanceTimersByTimeAsync(200); });
    expect(focusState.scrolled[0]).toBe('m4');
    expect(focusState.focus).not.toHaveBeenCalled();
    focusState.editorReady = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(focusState.focus).toHaveBeenCalledExactlyOnceWith('end', { scrollIntoView: false });
  });

  it('Open scrolls to the message without focusing the composer; another conversation is left alone', async () => {
    const { TPane, nav } = await load();
    await nav.openConversationFromSpaces({ backendConnectionId: 'local', workspaceId: 'p1', nodeId: 'node1', messageId: 'm2' });
    render(<TPane nodeId="node1" />);
    await act(async () => { await vi.dynamicImportSettled(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(focusState.scrolled[0]).toBe('m2');
    expect(focusState.focus).not.toHaveBeenCalled();
    expect(nav.getSourceNavState().reference).toMatchObject({ nodeId: 'node1', messageId: 'm2' });

    await nav.openConversationFromSpaces({ backendConnectionId: 'local', workspaceId: 'p1', nodeId: 'other', messageId: 'm1', focus: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(focusState.scrolled).toEqual(expect.not.arrayContaining(['m1']));
    expect(focusState.focus).not.toHaveBeenCalled();
  });

  it('a conversation opened without a message (a new conversation card) only takes the cursor for Continue', async () => {
    const { TPane, nav } = await load();
    await nav.openConversationFromSpaces({ backendConnectionId: 'local', workspaceId: 'p1', nodeId: 'node1', focus: true });
    render(<TPane nodeId="node1" />);
    await act(async () => { await vi.dynamicImportSettled(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(focusState.scrolled).toEqual([]);
    expect(focusState.focus).toHaveBeenCalledWith('end', { scrollIntoView: false });
  });
});
