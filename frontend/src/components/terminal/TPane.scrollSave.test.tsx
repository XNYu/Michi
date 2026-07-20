/**
 * Regression: pane scroll saves must not run before the mount restore has
 * settled.
 *
 * React.StrictMode (dev builds) double-invokes the restore effect:
 * setup → cleanup → setup, synchronously, before the first animation frame.
 * The cleanup calls savePaneScroll() while the layout is still the
 * content-visibility estimate — there the atBottom heuristic reads true and
 * no anchor is measurable, so an ungated save would write
 * { anchorId: null, atBottom: true, lastSeen: <newest> } over the saved
 * entry, destroying both the anchor and the unread horizon before the second
 * setup reads them. Every pane open in dev then lands at the bottom and
 * scroll-to-first-unseen never fires.
 *
 * The fix suppresses savePaneScroll while restoreInFlightRef is set — the
 * mount restore holds it true until the layout goes quiet (or the user
 * scrolls); an unmount mid-restore keeps the previous entry rather than
 * overwriting it. Live panes with no restore pass hold the same guard for
 * one frame after mount so the synchronous StrictMode cleanup can't save
 * either. These tests mount the real TPane with stubbed children; jsdom's
 * zero geometry stands in for the unsettled pre-paint layout.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';

// jsdom lacks these — without them effects crash, React tears the tree down,
// and the teardown save contaminates the experiment.
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

const anyFn = () => new Proxy({}, { get: () => vi.fn() });

vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<any>('../../state/chatStore');
  const mkMsg = (id: string, i: number, createdAt: number) => ({
    id,
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: `msg ${id}`,
    content: `msg ${id}`,
    createdAt,
    toolCalls: [],
    blocks: [],
  });
  const messages = [
    ...Array.from({ length: 10 }, (_, i) => mkMsg(`m${i + 1}`, i, (i + 1) * 100)),
    // Arrived after the pane was last left — the "unseen" tail.
    mkMsg('m11', 1, 1100),
    mkMsg('m12', 1, 1200),
  ];
  const node = {
    id: 'node1',
    chatId: 'chat1',
    projectId: 'p1',
    kind: 'chat',
    status: 'idle',
    messages,
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
      focusedPane: null,
      availableModes: [],
      agentStatus: null,
      refreshAgentStatus: vi.fn(),
      activeProject: {
        id: 'p1', name: 'P', artifacts: [], edges: [], chatIds: ['node1'],
        trees: [{ id: 't1', rootNodeId: 'node1' }], activeTreeId: 't1',
      },
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
  PaneMessageList: () => (
    <div>
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} data-msg-id={`m${i + 1}`} style={{ height: 100 }}>msg</div>
      ))}
    </div>
  ),
}));
vi.mock('./ComposerShell', () => ({
  ComposerShell: React.forwardRef((_p: any, _r: any) => null),
}));
vi.mock('./PaneComposerPreBlocks', () => ({ PaneComposerPreBlocks: () => null }));
vi.mock('./PaneComposerActions', () => ({ PaneComposerActions: () => null }));
vi.mock('./PaneComposerToolbarLeft', () => ({ PaneComposerToolbarLeft: () => null }));
vi.mock('./PaneAgentMenus', () => ({ PaneAgentMenus: () => null }));
vi.mock('./PaneFind', () => ({ default: () => null, PaneFind: () => null }));
vi.mock('./PermissionBanner', () => ({ default: () => null, PermissionBanner: () => null }));
vi.mock('./MergeBanner', () => ({ default: () => null, MergeBanner: () => null }));
vi.mock('./PaneDragOverlays', () => ({ FileDropOverlay: () => null, PaneDropIndicator: () => null }));
vi.mock('../MentionEditor', () => ({ default: React.forwardRef(() => null) }));
vi.mock('../SelectionActions', () => ({ default: () => null }));
vi.mock('../UploadProgressBar', () => ({ default: () => null }));

const LS_KEY = 'michi:paneScrollAnchors';
const SAVED_ENTRY = { anchorId: 'm5', offset: -4, atBottom: false, lastSeen: 1000 };

function seedCache() {
  window.localStorage.clear();
  window.localStorage.setItem(LS_KEY, JSON.stringify([['node1', SAVED_ENTRY]]));
}

function readCache(): Record<string, any> {
  const raw = window.localStorage.getItem(LS_KEY);
  return raw ? Object.fromEntries(JSON.parse(raw)) : {};
}

describe('paneScrollCache save gating', () => {
  // Each test's teardown unmount can trigger a save + a 1s-debounced flush
  // from THAT test's module instance. Drain it before the next test seeds,
  // or it leaks into the shared localStorage mid-test.
  afterEach(async () => {
    cleanup();
    await new Promise((r) => setTimeout(r, 1300));
  });

  it('plain mount: saved entry stays intact while mounted', async () => {
    seedCache();
    vi.resetModules();
    const { default: TPane } = await import('./TPane');
    render(<TPane nodeId="node1" />);
    await new Promise((r) => setTimeout(r, 1300));
    expect(readCache().node1).toEqual(SAVED_ENTRY);
  }, 15000);

  it('StrictMode mount: saved entry survives the dev double-invoke', async () => {
    seedCache();
    vi.resetModules();
    const { default: TPane } = await import('./TPane');
    render(
      <React.StrictMode>
        <TPane nodeId="node1" />
      </React.StrictMode>,
    );
    // paneScrollCache flushes to localStorage on a 1s debounce; if the
    // StrictMode cleanup had saved, the clobbered entry would be visible now.
    await new Promise((r) => setTimeout(r, 1300));
    expect(readCache().node1).toEqual(SAVED_ENTRY);
  }, 15000);

  it('unmount after the restore settles still saves (guard is not stuck closed)', async () => {
    seedCache();
    vi.resetModules();
    const { default: TPane } = await import('./TPane');
    const { unmount } = render(<TPane nodeId="node1" />);
    // Let the restore go quiet (RESTORE_QUIET_MS + slack) so restoreInFlightRef
    // clears before we unmount — this unmount save must fire.
    await new Promise((r) => setTimeout(r, 800));
    unmount();
    await new Promise((r) => setTimeout(r, 1300));
    const entry = readCache().node1;
    // jsdom's zero geometry makes the *content* of this save look like
    // "at bottom" — that's a test-environment artifact. What matters here
    // is that the save FIRED at all: lastSeen advanced past the seed.
    expect(entry.lastSeen).toBe(1200);
  }, 15000);
});
