import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import TPane from './TPane';
import type { ChatNodeState } from '../../state/chatTypes';

// jsdom doesn't expose CSS.highlights; polyfill so the PaneFind cleanup
// effect in TPane doesn't throw on unmount.
if (typeof CSS === 'undefined') {
  (globalThis as any).CSS = {};
}
if (!(CSS as any).highlights) {
  (CSS as any).highlights = new Map();
}

const mockNode: ChatNodeState = {
  nodeId: 'n1', chatId: null, projectId: 'p1', kind: 'chat',
  title: 't', messages: [], followUps: [], status: 'idle',
};

const mockProject = {
  id: 'p1', name: 'P', cwd: '/tmp/p1', chatIds: ['n1'], edges: [],
  trees: [{ id: 'tr1', rootNodeId: 'n1', createdAt: 0, lastActiveAt: 0 }],
  activeTreeId: 'tr1', contexts: [], createdAt: 0,
};

const createContextFn = vi.fn();
const focusPaneFn = vi.fn();
const setComposerDraftFn = vi.fn();

vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<any>('../../state/chatStore');
  const actions = () => ({
    createContext: createContextFn,
    focusPane: focusPaneFn,
    closePane: () => {},
    reorderPane: () => {},
    sendMessage: () => {},
    retryLastTurn: () => {},
    cancelStream: () => {},
    isObserver: () => false,
    createChildChat: () => Promise.resolve(),
    fanoutBranches: () => Promise.resolve(),
    setFocusedNodeId: () => {},
    switchAgent: () => Promise.resolve(),
    resolvePermission: () => {},
    denyPermission: () => {},
    addPendingComment: () => {},
    removePendingComment: () => {},
    clearPendingComments: () => {},
    queueMessage: () => {},
    dequeueMessage: () => {},
    setComposerDraft: setComposerDraftFn,
    deleteContext: () => {},
  });
  const projects = () => ({
    activeProject: mockProject,
    focusedPane: 'n1',
    openPanes: ['n1'],
    availableModes: [],
    agentStatus: null,
    refreshAgentStatus: () => {},
  });
  return {
    ...actual,
    useChatStore: () => ({ ...projects(), ...actions() }),
    useChatActions: () => actions(),
    useChatProjects: () => projects(),
    useStructuralSelector: (selector: (nodes: Record<string, ChatNodeState>) => unknown) =>
      selector({ n1: mockNode }),
    useChatNodesSnapshot: () => ({ n1: mockNode }),
    useChatNode: () => mockNode,
    chatLabel: () => '',
  };
});

vi.mock('../../state/prefs', async () => {
  const actual = await vi.importActual<any>('../../state/prefs');
  return {
    ...actual,
    usePrefs: () => ({
      prefs: {
        fontFamily: 'sans',
        showThoughts: false,
        terminalPalette: 'michi',
        terminalDensity: 'compact',
        paneRules: true,
        focusDim: 0,
        quoteMaxLines: 2,
      },
    }),
  };
});

// Stub heavy child components that reach into additional contexts.
vi.mock('../SelectionActions', () => ({ default: () => null }));
vi.mock('../SlashPopup', () => ({ default: () => null }));
vi.mock('../AtMentionPopup', () => ({ default: () => null }));
vi.mock('../MentionEditor', () => ({
  default: React.forwardRef((_props: any, _ref: any) => <textarea />),
}));
vi.mock('./PaneFind', () => ({ default: () => null }));
vi.mock('./PermissionBanner', () => ({ default: () => null }));
vi.mock('../ContextMenu', () => ({ default: () => null }));
vi.mock('../MarkdownContent', () => ({ default: ({ text }: { text: string }) => <span>{text}</span> }));

beforeEach(() => {
  createContextFn.mockReset();
  focusPaneFn.mockReset();
  setComposerDraftFn.mockReset();
});

afterEach(() => {
  // Clean up any electron shim.
  delete (window as any).electron;
});

function dragEvent(type: string, files: File[]) {
  // jsdom doesn't implement DataTransfer, so we build a minimal stub.
  const fileList = Object.assign(files, {
    item: (i: number) => files[i] ?? null,
  });
  const items = files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f }));
  const dt = {
    types: files.length > 0 ? ['Files'] : [],
    files: fileList,
    items,
    dropEffect: 'none' as string,
  };
  const ev = new Event(type, { bubbles: true, cancelable: true }) as any;
  ev.dataTransfer = dt;
  return ev;
}

describe('TPane drag-and-drop', () => {
  it('shows overlay on dragenter when dataTransfer has Files', () => {
    const { container } = render(<TPane nodeId="n1" />);
    const root = container.firstChild as HTMLElement;
    fireEvent(root, dragEvent('dragenter', [new File(['x'], 'a.md')]));
    expect(container.textContent).toMatch(/drop 1 file/);
  });

  it('does NOT show overlay for non-file drags', () => {
    const { container } = render(<TPane nodeId="n1" />);
    const root = container.firstChild as HTMLElement;
    const ev = new Event('dragenter', { bubbles: true, cancelable: true }) as any;
    ev.dataTransfer = { types: ['text/plain'], items: [] };
    fireEvent(root, ev);
    expect(container.textContent).not.toMatch(/drop \d+ file/);
  });

  it('counter handles nested dragenter/leave without flicker', () => {
    const { container } = render(<TPane nodeId="n1" />);
    const root = container.firstChild as HTMLElement;
    fireEvent(root, dragEvent('dragenter', [new File(['x'], 'a.md')]));
    fireEvent(root, dragEvent('dragenter', [new File(['x'], 'a.md')]));  // nested
    fireEvent(root, dragEvent('dragleave', [new File(['x'], 'a.md')]));
    expect(container.textContent).toMatch(/drop \d+ file/);
    fireEvent(root, dragEvent('dragleave', [new File(['x'], 'a.md')]));
    expect(container.textContent).not.toMatch(/drop \d+ file/);
  });

  it('drop with electron path focuses pane and does NOT create contexts (deferred to send)', async () => {
    (window as any).electron = {
      getPathForFile: (f: File) => `/abs/${f.name}`,
    };
    const { container } = render(<TPane nodeId="n1" />);
    const root = container.firstChild as HTMLElement;
    const a = new File(['x'], 'foo.md');
    const b = new File(['y'], 'bar.json');
    await act(async () => {
      fireEvent(root, dragEvent('drop', [a, b]));
    });
    expect(focusPaneFn).toHaveBeenCalledWith('n1');
    expect(createContextFn).not.toHaveBeenCalled();
  });

  it('drop does NOT touch composer draft and does NOT fire success toast', async () => {
    (window as any).electron = {
      getPathForFile: (f: File) => `/abs/${f.name}`,
    };
    const { toast } = await import('sonner');
    const successSpy = vi.spyOn(toast, 'success').mockImplementation(() => '' as any);
    try {
      const { container } = render(<TPane nodeId="n1" />);
      const root = container.firstChild as HTMLElement;
      await act(async () => {
        fireEvent(root, dragEvent('drop', [new File(['x'], 'foo.md')]));
      });
      expect(successSpy).not.toHaveBeenCalled();
      expect(setComposerDraftFn).not.toHaveBeenCalled();
      expect(createContextFn).not.toHaveBeenCalled();
    } finally {
      successSpy.mockRestore();
      delete (window as any).electron;
    }
  });
});
