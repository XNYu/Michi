import { render, screen, fireEvent, within } from '@testing-library/react';
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

  it('underlines the passage a selection branch quoted; its card opens the branch', async () => {
    const u1 = makeMsg('u1', 'user', 'q');
    const a1 = makeMsg('a1', 'assistant', 'The quick **brown fox** jumps over the lazy dog.');
    const parent = makeNode('parent', [u1, a1]);
    const anchors = new Map<string, ChildAnchor[]>([
      ['a1', [{ ...makeAnchor('child-q', 'Why a fox?', Date.now()), quotedText: 'brown fox jumps' }]],
    ]);
    const onOpenBranch = vi.fn();
    const { container } = renderList(parent, anchors, { onOpenBranch });

    const underline = container.querySelector('[data-msg-id="a1"] .t-branch-anchor-underline') as HTMLElement;
    expect(underline.textContent).toBe('brown fox jumps');
    // The turn marker stays: touch screens cannot hover.
    expect(screen.getByRole('button', { name: 'Open branch: Why a fox?' })).toBeTruthy();

    fireEvent.pointerEnter(underline);
    const card = await screen.findByRole('group', { name: 'Branch from this passage' });
    fireEvent.click(within(card).getByRole('button', { name: 'Open branch: Why a fox?' }));
    expect(onOpenBranch).toHaveBeenCalledWith('child-q');
  });
});
