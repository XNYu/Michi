import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, fireEvent, act, screen } from '@testing-library/react';
import TPane from './TPane';
import type { ChatNodeState } from '../../state/chatTypes';
import type { MentionRecord } from '../mentions';

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
  activeTreeId: 'tr1', artifacts: [], createdAt: 0,
};

const createContextFn = vi.fn();
const focusPaneFn = vi.fn();
const setComposerDraftFn = vi.fn();
const sendMessageFn = vi.fn();
const queueMessageFn = vi.fn();
const cancelStreamFn = vi.fn();
let mockObserver = false;
let mockEditorMentions: MentionRecord[] = [];

vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<any>('../../state/chatStore');
  const actions = () => ({
    createContext: createContextFn,
    focusPane: focusPaneFn,
    closePane: () => {},
    reorderPane: () => {},
    sendMessage: sendMessageFn,
    retryLastTurn: () => {},
    cancelStream: cancelStreamFn,
    isObserver: () => mockObserver,
    createChildChat: () => Promise.resolve(),
    fanoutBranches: () => Promise.resolve(),
    setFocusedNodeId: () => {},
    switchAgent: () => Promise.resolve(),
    resolvePermission: () => {},
    denyPermission: () => {},
    addPendingComment: () => {},
    removePendingComment: () => {},
    clearPendingComments: () => {},
    queueMessage: queueMessageFn,
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
vi.mock('../SelectionActions', () => ({
  default: ({ onQuote }: { onQuote: (quote: string) => void }) => (
    <button type="button" data-testid="quote-selection" onClick={() => onQuote('fresh quote')}>
      quote
    </button>
  ),
}));
vi.mock('../SlashPopup', () => ({ default: () => null }));
vi.mock('../AtMentionPopup', () => ({ default: () => null }));
vi.mock('../MentionEditor', () => ({
  default: React.forwardRef(function MentionEditorStub(props: any, ref: any) {
    React.useImperativeHandle(ref, () => ({ focus: () => {}, editor: null }));
    return (
      <>
        <textarea
          data-testid="composer-editor"
          value={props.value}
          onChange={(event) => props.onChange({
            value: event.target.value,
            mentions: mockEditorMentions,
          })}
        />
        <button
          type="button"
          data-testid="editor-submit"
          onClick={() => props.onSubmit?.({ branch: false })}
        >
          submit
        </button>
      </>
    );
  }),
}));
vi.mock('./PaneFind', () => ({ default: () => null }));
vi.mock('./PermissionBanner', () => ({ default: () => null }));
vi.mock('../ContextMenu', () => ({ default: () => null }));
vi.mock('../MarkdownContent', () => ({ default: ({ text }: { text: string }) => <span>{text}</span> }));

beforeEach(() => {
  createContextFn.mockReset();
  focusPaneFn.mockReset();
  setComposerDraftFn.mockReset();
  sendMessageFn.mockReset();
  queueMessageFn.mockReset();
  cancelStreamFn.mockReset();
  mockObserver = false;
  mockEditorMentions = [];
  mockNode.status = 'idle';
  delete mockNode.composerDraft;
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

describe('TPane composer draft freshness', () => {
  it('enables the toolbar action immediately when an empty draft becomes non-empty', () => {
    render(<TPane nodeId="n1" />);

    fireEvent.change(screen.getByTestId('composer-editor'), {
      target: { value: 'typed before the RAF' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send (Enter)' }));

    expect(sendMessageFn).toHaveBeenCalledWith(
      'n1',
      'typed before the RAF',
      expect.objectContaining({ displayText: 'typed before the RAF' }),
    );
  });

  it('switches Stop to Send next before the draft store RAF while streaming', () => {
    mockNode.status = 'streaming';
    render(<TPane nodeId="n1" />);

    fireEvent.change(screen.getByTestId('composer-editor'), {
      target: { value: 'queue this next' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Send next|Stop stream/ }));

    expect(cancelStreamFn).not.toHaveBeenCalled();
    expect(queueMessageFn).toHaveBeenCalledWith(
      'n1',
      expect.objectContaining({ value: 'queue this next' }),
    );
  });

  it('submits same-tick text, mentions, and quote from the latest editor state', async () => {
    mockNode.composerDraft = { value: 'seed', mentions: [] };
    mockEditorMentions = [
      { start: 4, end: 11, kind: 'node', refId: 'n2', label: 'Thread' },
    ];
    render(<TPane nodeId="n1" />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('quote-selection'));
      fireEvent.change(screen.getByTestId('composer-editor'), {
        target: { value: 'ask @Thread' },
      });
      fireEvent.click(screen.getByTestId('editor-submit'));
    });

    expect(sendMessageFn).toHaveBeenCalledTimes(1);
    const [nodeId, wireText, meta] = sendMessageFn.mock.calls[0];
    expect(nodeId).toBe('n1');
    expect(wireText).toContain('fresh quote');
    expect(wireText).toContain('ask @node:n2');
    expect(meta).toMatchObject({
      quotedText: 'fresh quote',
      displayText: 'ask @node:n2',
    });
    expect(setComposerDraftFn).toHaveBeenLastCalledWith('n1', null);
  });

  it('uses the same latest snapshot when the toolbar Send button is clicked', async () => {
    mockNode.composerDraft = { value: 'seed', mentions: [] };
    render(<TPane nodeId="n1" />);

    await act(async () => {
      fireEvent.change(screen.getByTestId('composer-editor'), {
        target: { value: 'latest toolbar text' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Send (Enter)' }));
    });

    expect(sendMessageFn).toHaveBeenCalledWith(
      'n1',
      'latest toolbar text',
      expect.objectContaining({ displayText: 'latest toolbar text' }),
    );
    expect(setComposerDraftFn).toHaveBeenLastCalledWith('n1', null);
  });

  it('does not let an unrelated rerender roll back an uncommitted editor change', async () => {
    mockNode.composerDraft = { value: 'seed', mentions: [] };
    const view = render(<TPane nodeId="n1" />);

    await act(async () => {
      fireEvent.change(screen.getByTestId('composer-editor'), {
        target: { value: 'latest before rerender' },
      });
    });
    await act(async () => {
      view.rerender(<TPane nodeId="n1" contentMaxWidth={800} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-submit'));
    });

    expect(sendMessageFn).toHaveBeenCalledWith(
      'n1',
      'latest before rerender',
      expect.objectContaining({ displayText: 'latest before rerender' }),
    );
  });

  it('keeps observer panes read-only', async () => {
    mockObserver = true;
    mockNode.composerDraft = { value: 'seed', mentions: [] };
    render(<TPane nodeId="n1" />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-submit'));
    });

    expect(sendMessageFn).not.toHaveBeenCalled();
  });
});
