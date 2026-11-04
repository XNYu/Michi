import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import BranchRow from './BranchRow';
import type { ChatNodeState, ProjectEdge } from '../../state/chatTypes';

const store = vi.hoisted(() => ({
  edges: [] as ProjectEdge[],
  loaded: true,
  /** Nodes whose reply landed after their last view. */
  unread: new Set<string>(),
}));

function nodeState(nodeId: string): ChatNodeState {
  return {
    nodeId, kind: 'chat', chatId: null, projectId: 'p1', title: `Branch ${nodeId}`,
    messages: [], followUps: [], status: 'idle',
    ...(store.unread.has(nodeId) ? { lastAssistantAt: 5, viewedAt: 1 } : {}),
  } as ChatNodeState;
}

vi.mock('../../state/prefs', () => ({
  usePrefs: () => ({ prefs: { sidebarRowStyle: 'classic', sidebarInset: 0, showSidebarTimestamps: false } }),
}));

vi.mock('../../state/chatStore', () => ({
  useChatNode: (nodeId: string): ChatNodeState | undefined => (store.loaded ? nodeState(nodeId) : undefined),
  useChatProjects: () => ({ focusedNodeId: null, projects: [{ id: 'p0', edges: [] }, { id: 'p1', edges: store.edges }] }),
  useStructuralSelector: <T,>(selector: (nodes: Record<string, ChatNodeState>) => T): T =>
    selector(Object.fromEntries([...store.unread].map((id) => [id, nodeState(id)]))),
}));

function renderRow(nodeId: string) {
  return render(
    <div data-testid="tree">
      <BranchRow
        node={{ nodeId, depth: 1, children: [] }}
        depth={1}
        expanded={false}
        isFocused={() => false}
        isSelected={() => false}
        isExpanded={() => false}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        openState="streaming"
        getOpenState={() => 'none'}
      />
    </div>,
  );
}

const row = (nodeId: string) => document.querySelector(`[data-sidebar-row="${nodeId}"]`) as HTMLElement;
const rail = (nodeId: string) => row(nodeId).lastElementChild as HTMLElement;

describe('BranchRow entrance', () => {
  it('grows a row a branch just added: height, accent wash and its rail drawing down', async () => {
    store.edges = [{ source: 'root', target: 'fresh', kind: 'branch', createdAt: Date.now() }];
    renderRow('fresh');
    const shell = row('fresh').parentElement as HTMLElement;
    expect(shell.dataset.testid).toBeUndefined();
    expect(shell.style.height).toBe('0px');
    // Only the vertical axis clips, so the full-bleed row fill stays visible.
    expect(shell.style.overflowY).toBe('clip');
    expect(rail('fresh').style.transform).toContain('scaleY(0)');
    const wash = row('fresh').firstElementChild as HTMLElement;
    expect(wash.style.background).toContain('color-mix');

    await waitFor(() => expect(shell.style.overflowY).toBe(''));
    expect(shell.style.height).toBe('auto');
    await waitFor(() => expect(row('fresh').firstElementChild).not.toBe(wash));
  });

  it('finds a fresh edge before the node has loaded, and judges freshness when each row mounts', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      store.edges = [{ source: 'root', target: 'early', kind: 'branch', createdAt: Date.now() }];
      store.loaded = false;
      const first = renderRow('early');
      expect(row('early').parentElement?.style.height).toBe('0px');
      first.unmount();
      // The same edges array, a second later: its births are cached, but the
      // row now mounts settled.
      vi.setSystemTime(Date.now() + 1500);
      renderRow('early');
      expect(row('early').parentElement?.dataset.testid).toBe('tree');
    } finally {
      store.loaded = true;
      vi.useRealTimers();
    }
  });

  it('renders a hydrated row settled, with no wrapper, wash or drawing rail', () => {
    store.edges = [{ source: 'root', target: 'old', kind: 'branch', createdAt: Date.now() - 60_000 }];
    renderRow('old');
    expect(row('old').parentElement?.dataset.testid).toBe('tree');
    expect(row('old').querySelector('[aria-hidden][style*="color-mix"]')).toBeNull();
    expect(rail('old').style.transform).not.toContain('scaleY(0)');
  });
});

describe('BranchRow unread dot', () => {
  const dot = (nodeId: string) => row(nodeId).querySelector('.sb-unread-dot') as HTMLElement;

  function renderBranch(expanded: boolean) {
    store.edges = [];
    return render(
      <BranchRow
        node={{ nodeId: 'parent', depth: 1, children: [{ nodeId: 'child', depth: 2, children: [] }] }}
        depth={1}
        expanded={expanded}
        isFocused={() => false}
        isSelected={() => false}
        isExpanded={() => false}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        openState="none"
        getOpenState={() => 'none'}
      />,
    );
  }

  it('is solid on an unread branch, which also brightens to fg at the unread weight', () => {
    store.unread = new Set(['parent']);
    try {
      renderBranch(false);
      expect(dot('parent').dataset.unread).toBe('self');
      expect(row('parent').style.fontWeight).toBe('520');
      expect(row('parent').style.color).toBe('var(--term-fg)');
    } finally {
      store.unread = new Set();
    }
  });

  it('rings a collapsed branch hiding an unread sub-branch; expanded, the sub-branch carries it', () => {
    store.unread = new Set(['child']);
    try {
      const view = renderBranch(false);
      expect(dot('parent').dataset.unread).toBe('within');
      expect(row('parent').style.fontWeight).toBe('450');
      view.unmount();

      renderBranch(true);
      expect(dot('parent').dataset.unread).toBe('none');
      expect(dot('child').dataset.unread).toBe('self');
    } finally {
      store.unread = new Set();
    }
  });
});
