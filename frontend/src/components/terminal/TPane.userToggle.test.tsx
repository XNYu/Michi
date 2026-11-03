/**
 * Regression: expanding content in the transcript must not throw a following
 * pane to the bottom.
 *
 * While a turn streams, follow mode pins every transcript growth to the tail.
 * "Show more" on a long user message grew the transcript the same way, so the
 * ResizeObserver pin scrolled the viewport away from the message the reader
 * had just expanded. A click that changes the transcript height now leaves
 * follow mode instead; a click that changes nothing keeps it.
 *
 * jsdom has no layout, so the scroll container's geometry is stubbed and the
 * pin's tail is scrollHeight - clientHeight (children measure 0).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, act, fireEvent } from '@testing-library/react';

const geom = vi.hoisted(() => ({ scrollHeight: 800, userMessageHeight: 100 }));
const observers = vi.hoisted(() => [] as Array<{ cb: () => void; targets: Element[] }>);

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
if (typeof (Element.prototype as any).scrollIntoView !== 'function') {
  (Element.prototype as any).scrollIntoView = () => {};
}

class FakeResizeObserver {
  private entry: { cb: () => void; targets: Element[] };
  constructor(cb: () => void) {
    this.entry = { cb, targets: [] };
    observers.push(this.entry);
  }
  observe(el: Element) { this.entry.targets.push(el); }
  unobserve() {}
  disconnect() { this.entry.targets = []; }
}

const anyFn = () => new Proxy({}, { get: () => vi.fn(async () => {}) });

vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<any>('../../state/chatStore');
  const msg = (id: string, role: 'user' | 'assistant') => ({
    id, role, text: id, content: id, createdAt: 1, toolCalls: [], blocks: [],
  });
  const node = {
    id: 'node1',
    chatId: 'chat1',
    projectId: 'p1',
    kind: 'chat',
    status: 'streaming',
    messages: [msg('u1', 'user'), msg('a1', 'assistant')],
    followUps: [],
    followUpsGenerating: false,
    title: 'Test thread',
    pendingComments: [],
    queuedMessages: [],
    injectedContexts: [],
  };
  return {
    ...actual,
    useChatActions: anyFn,
    useChatStore: () => ({ focusedPane: null }),
    useChatProjects: () => ({
      availableModes: [],
      agentStatus: null,
      refreshAgentStatus: vi.fn(),
      activeProject: {
        id: 'p1', name: 'P', artifacts: [], edges: [], chatIds: ['node1'],
        trees: [{ id: 't1', rootNodeId: 'node1' }], activeTreeId: 't1',
      },
    }),
    useChatPanes: () => ({
      focusedPane: null,
      openPanes: [],
      focusNonce: 0,
      paneItems: {},
      viewMode: 'single' as const,
    }),
    useChatNode: () => node,
    useStructuralSelector: (sel: any) => {
      try { return sel({}); } catch { return undefined; }
    },
  };
});
vi.mock('../../state/prefs', () => ({
  usePrefs: () => ({ prefs: {}, setPref: vi.fn() }),
}));
vi.mock('../../services/api', () => ({
  listAgentModels: vi.fn(async () => []),
  saveAgentOptions: vi.fn(async () => {}),
  getWebUploadCwd: vi.fn(async () => null),
  importWorkspaceFileUpload: vi.fn(async () => ({ filePath: '', displayName: '' })),
}));
vi.mock('./PaneMessageList', () => ({
  PaneMessageList: ({ onBranchFollowUp }: any) => (
    <div>
      {/* A row wrapper, so the pin's tail (direct children) still measures 0. */}
      <div>
      <div
        data-msg-id="u1"
        ref={(el) => {
          if (el) Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => geom.userMessageHeight });
        }}
      >
        user message
        <button
          type="button"
          onClick={(e) => {
            // Same as CollapsibleUserText: the toggle stops propagation.
            e.stopPropagation();
            geom.scrollHeight += 600;
            geom.userMessageHeight += 600;
          }}
        >
          Show more
        </button>
        <button
          type="button"
          onClick={() => {
            // A disclosure that animates its height from a later frame (motion).
            setTimeout(() => {
              geom.scrollHeight += 300;
              geom.userMessageHeight += 300;
            }, 80);
          }}
        >
          Open later
        </button>
        <button type="button">Copy</button>
      </div>
      </div>
      <div data-msg-id="a1">assistant reply</div>
      <button type="button" onClick={() => {
        onBranchFollowUp('Explore this');
        geom.scrollHeight += 120;
      }}>Branch follow-up</button>
    </div>
  ),
}));
vi.mock('./ComposerShell', () => ({
  ComposerShell: React.forwardRef((p: any, _r: any) => p.input),
}));
vi.mock('./PaneComposerPreBlocks', () => ({ PaneComposerPreBlocks: () => null }));
vi.mock('./PaneComposerActions', () => ({ PaneComposerActions: () => null }));
vi.mock('./PaneComposerToolbarLeft', () => ({ PaneComposerToolbarLeft: () => null }));
vi.mock('./PaneAgentMenus', () => ({ PaneAgentMenus: () => null }));
vi.mock('./PaneFind', () => ({ default: () => null, PaneFind: () => null }));
vi.mock('./PermissionBanner', () => ({ default: () => null, PermissionBanner: () => null }));
vi.mock('./MergeBanner', () => ({ default: () => null, MergeBanner: () => null }));
vi.mock('./PaneDragOverlays', () => ({ FileDropOverlay: () => null, PaneDropIndicator: () => null }));
vi.mock('../MentionEditor', () => ({ default: React.forwardRef((_p, ref) => {
  React.useImperativeHandle(ref, () => ({ editor: { commands: { focus: vi.fn() } } }));
  return null;
}) }));
vi.mock('../SelectionActions', () => ({ default: () => null }));
vi.mock('../UploadProgressBar', () => ({ default: () => null }));

const CLIENT_HEIGHT = 500;

async function mountFollowingPane() {
  vi.resetModules();
  const { default: TPane } = await import('./TPane');
  const view = render(<TPane nodeId="node1" />);
  await act(async () => { await vi.dynamicImportSettled(); });
  const scroller = view.container.querySelector<HTMLDivElement>('.term-scrollbar');
  if (!scroller) throw new Error('scroll container not rendered');
  let scrollTop = geom.scrollHeight - CLIENT_HEIGHT;
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => CLIENT_HEIGHT });
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => geom.scrollHeight });
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => { scrollTop = v; },
  });
  // Let the mount-time follow pin run against the stubbed geometry.
  await act(async () => { await vi.advanceTimersByTimeAsync(32); });
  const resize = () => {
    act(() => {
      for (const o of observers) if (o.targets.includes(scroller)) o.cb();
    });
  };
  return { ...view, scroller, resize };
}

describe('follow mode and user expand clicks', () => {
  beforeEach(() => {
    geom.scrollHeight = 800;
    geom.userMessageHeight = 100;
    observers.length = 0;
    window.localStorage.clear();
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.useFakeTimers();
  });

  afterEach(async () => {
    cleanup();
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('streamed growth still pins a following pane to the tail', async () => {
    const { scroller, resize } = await mountFollowingPane();
    expect(scroller.scrollTop).toBe(300);
    geom.scrollHeight = 1400;
    resize();
    expect(scroller.scrollTop).toBe(900);
  });

  it('Show more does not jump to the bottom, and later output does not either', async () => {
    const { scroller, resize, getByRole } = await mountFollowingPane();
    expect(scroller.scrollTop).toBe(300);

    fireEvent.click(getByRole('button', { name: 'Show more' }));
    resize();
    expect(scroller.scrollTop).toBe(300);

    // The reader left follow mode: output that streams in afterwards stays
    // below the viewport until they scroll back to the bottom.
    await act(async () => { await vi.advanceTimersByTimeAsync(32); });
    geom.scrollHeight += 200;
    resize();
    expect(scroller.scrollTop).toBe(300);
  });

  it('branch insertion keeps follow-ups at the tail and continues following growth', async () => {
    const { scroller, resize, getByRole } = await mountFollowingPane();
    fireEvent.click(getByRole('button', { name: 'Branch follow-up' }));
    resize();
    expect(scroller.scrollTop).toBe(420);

    geom.scrollHeight += 200;
    resize();
    expect(scroller.scrollTop).toBe(620);
  });

  it('a click that changes nothing keeps follow mode', async () => {
    const { scroller, resize, getByRole } = await mountFollowingPane();
    fireEvent.click(getByRole('button', { name: 'Copy' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(32); });
    geom.scrollHeight = 1400;
    resize();
    expect(scroller.scrollTop).toBe(900);
  });

  it('output streaming elsewhere right after a click is still followed', async () => {
    const { scroller, resize, getByRole } = await mountFollowingPane();
    fireEvent.click(getByRole('button', { name: 'Copy' }));
    // Still inside the click's window: the clicked message did not change.
    geom.scrollHeight = 1400;
    resize();
    expect(scroller.scrollTop).toBe(900);
  });

  it('an opening that animates from a later frame still leaves follow mode', async () => {
    const { scroller, resize, getByRole } = await mountFollowingPane();
    fireEvent.click(getByRole('button', { name: 'Open later' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(80); });
    resize();
    expect(scroller.scrollTop).toBe(300);
  });
});
