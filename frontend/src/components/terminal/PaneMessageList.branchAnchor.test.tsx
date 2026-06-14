import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { PaneMessageList } from './PaneMessageList';
import type { ChatNodeState, ChatMessage } from '../../state/chatTypes';
import type { ChildAnchor } from '../../state/branchAnchors';
import type { Prefs } from '../../state/prefs';
import { DEFAULT_PREFS } from '../../state/prefs';

// ---------------------------------------------------------------------------
// Minimal fixture helpers
// ---------------------------------------------------------------------------

function makeMsg(id: string, role: 'user' | 'assistant', text = ''): ChatMessage {
  return { id, role, text, toolCalls: [] };
}

function makeNode(
  nodeId: string,
  messages: ChatMessage[],
  overrides: Partial<ChatNodeState> = {},
): ChatNodeState {
  return {
    nodeId,
    kind: 'chat',
    chatId: null,
    projectId: 'proj-1',
    messages,
    followUps: [],
    status: 'idle',
    ...overrides,
  } as ChatNodeState;
}

function makeAnchor(
  childNodeId: string,
  title: string,
  createdAt: number,
  status: ChatNodeState['status'] = 'idle',
  messageCount = 0,
): ChildAnchor {
  return { childNodeId, title, createdAt, status, messageCount };
}

const BASE_PREFS: Prefs = { ...DEFAULT_PREFS };

function renderList(
  node: ChatNodeState,
  anchorsByMessage: Map<string, ChildAnchor[]>,
  {
    onOpenBranch = vi.fn(),
  }: {
    onOpenBranch?: (id: string) => void;
  } = {},
) {
  return render(
    <PaneMessageList
      node={node}
      prefs={BASE_PREFS}
      contentStyle={{}}
      streaming={false}
      viewportHeight={800}
      onRetryTurn={vi.fn()}
      onEditUserMessage={vi.fn()}
      onContinueFollowUp={vi.fn()}
      onBranchFollowUp={vi.fn()}
      anchorsByMessage={anchorsByMessage}
      onOpenBranch={onOpenBranch}
    />,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PaneMessageList — branch anchor turn markers', () => {
  it('renders BranchAnchorRow after the anchored assistant message', () => {
    const u1 = makeMsg('u1', 'user', 'hello');
    const a1 = makeMsg('a1', 'assistant', 'world');
    const parent = makeNode('parent', [u1, a1]);

    const child = makeNode('child-1', [u1], { title: 'Child branch title', status: 'idle' });

    const anchors = new Map<string, ChildAnchor[]>([
      ['a1', [makeAnchor('child-1', 'Child branch title', Date.now() - 1000, 'idle', child.messages.length)]],
    ]);

    renderList(parent, anchors);

    // BranchAnchorRow renders the title as a button
    const titleBtn = screen.getByRole('button', { name: /Child branch title/ });
    expect(titleBtn).toBeTruthy();

    // Verify the marker is rendered INSIDE the assistant message wrapper
    // (data-msg-id=a1), and is positioned after the message body content
    // (i.e., it is not the very first child).
    const msgWrap = document.querySelector('[data-msg-id="a1"]');
    expect(msgWrap).toBeTruthy();
    const markerRow = titleBtn.closest('.t-pre-block');
    expect(markerRow).toBeTruthy();
    // The marker should be a descendant of the message wrapper.
    expect((msgWrap as Element).contains(markerRow as Element)).toBe(true);
    // It should NOT be the first child — content comes first, then the marker.
    expect((msgWrap as Element).firstElementChild === markerRow).toBe(false);
  });

  it('hides marker when child is soft-deleted (buildAnchorMap filters it out)', () => {
    const u1 = makeMsg('u1', 'user', 'hello');
    const a1 = makeMsg('a1', 'assistant', 'world');
    const parent = makeNode('parent', [u1, a1]);

    // buildAnchorMap already excludes soft-deleted children, so anchorsByMessage
    // will be empty — simulate that here (the actual filter is in branchAnchors.ts
    // which has its own unit tests).
    const anchors = new Map<string, ChildAnchor[]>(); // empty because child was deleted

    renderList(parent, anchors);

    // No BranchAnchorRow buttons should be present
    const buttons = screen.queryAllByRole('button', { name: /↳/ });
    expect(buttons).toHaveLength(0);
  });

  it('stacks multiple turn markers in createdAt order (already sorted by buildAnchorMap)', () => {
    const u1 = makeMsg('u1', 'user', 'question');
    const a1 = makeMsg('a1', 'assistant', 'answer');
    const parent = makeNode('parent', [u1, a1]);

    // createdAt order: child-1 is older (smaller ts)
    const t0 = 1_700_000_000_000;
    const anchors = new Map<string, ChildAnchor[]>([
      ['a1', [
        makeAnchor('child-1', 'First fork', t0),
        makeAnchor('child-2', 'Second fork', t0 + 5000),
      ]],
    ]);

    renderList(parent, anchors);

    const btns = screen.getAllByRole('button', { name: /fork/i });
    expect(btns).toHaveLength(2);
    // First button should be "First fork", second "Second fork"
    expect(btns[0].textContent).toContain('First fork');
    expect(btns[1].textContent).toContain('Second fork');
  });

  it('shows pulse indicator when child is streaming', () => {
    const u1 = makeMsg('u1', 'user', 'q');
    const a1 = makeMsg('a1', 'assistant', 'a');
    const parent = makeNode('parent', [u1, a1]);

    const anchors = new Map<string, ChildAnchor[]>([
      ['a1', [makeAnchor('child-s', 'Live branch', Date.now(), 'streaming')]],
    ]);

    const { container } = renderList(parent, anchors);

    expect(container.querySelector('.t-branch-anchor-pulse')).toBeTruthy();
  });

  it('calls onOpenBranch with the child node id when title is clicked', () => {
    const u1 = makeMsg('u1', 'user', 'q');
    const a1 = makeMsg('a1', 'assistant', 'a');
    const parent = makeNode('parent', [u1, a1]);

    const anchors = new Map<string, ChildAnchor[]>([
      ['a1', [makeAnchor('child-x', 'Click me', Date.now())]],
    ]);

    const onOpenBranch = vi.fn();
    renderList(parent, anchors, { onOpenBranch });

    fireEvent.click(screen.getByRole('button', { name: /Click me/ }));
    expect(onOpenBranch).toHaveBeenCalledWith('child-x');
  });
});
