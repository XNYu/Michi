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
