import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { PaneMessageList } from './PaneMessageList';
import type { ChatMessage, ChatNodeState } from '../../state/chatTypes';
import type { Prefs } from '../../state/prefs';
import { DEFAULT_PREFS } from '../../state/prefs';
import { STREAMING_MARKDOWN_BLOCKS_STORAGE_KEY } from './streamingMarkdownBlocksFlag';

const { markdownRenderSpy } = vi.hoisted(() => ({
  markdownRenderSpy: vi.fn(),
}));

vi.mock('../MarkdownContent', () => ({
  default: ({ text }: { text: string }) => {
    markdownRenderSpy(text);
    return <span>{text}</span>;
  },
}));

function makeMsg(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  streaming = false,
): ChatMessage {
  return { id, role, text, toolCalls: [], streaming };
}

function makeNode(messages: ChatMessage[]): ChatNodeState {
  return {
    nodeId: 'n1',
    kind: 'chat',
    chatId: null,
    projectId: 'p1',
    messages,
    followUps: [],
    status: 'streaming',
  } as ChatNodeState;
}

const prefs: Prefs = { ...DEFAULT_PREFS, showThoughts: true };

function renderList(node: ChatNodeState, onOpenBranch: (id: string) => void) {
  return (
    <PaneMessageList
      node={node}
      prefs={prefs}
      contentStyle={{}}
      streaming
      viewportHeight={800}
      onRetryTurn={vi.fn()}
      onEditUserMessage={vi.fn()}
      onContinueFollowUp={vi.fn()}
      onBranchFollowUp={vi.fn()}
      anchorsByMessage={new Map()}
      onOpenBranch={onOpenBranch}
    />
  );
}

describe('PaneMessageList render performance', () => {
  beforeEach(() => {
    markdownRenderSpy.mockClear();
    window.localStorage.removeItem(STREAMING_MARKDOWN_BLOCKS_STORAGE_KEY);
  });

  it('does not re-render stable assistant markdown when only the streaming tail changes', () => {
    const u1 = makeMsg('u1', 'user', 'first question');
    const a1 = makeMsg('a1', 'assistant', 'stable answer');
    const u2 = makeMsg('u2', 'user', 'second question');
    const a2 = makeMsg('a2', 'assistant', 'stream one', true);
    const onOpenBranch = vi.fn();

    const { rerender } = render(renderList(makeNode([u1, a1, u2, a2]), onOpenBranch));
    rerender(renderList(makeNode([u1, a1, u2, { ...a2, text: 'stream two' }]), onOpenBranch));

    const renderedTexts = markdownRenderSpy.mock.calls.map((call) => call[0]);
    expect(renderedTexts.filter((text) => text === 'stable answer')).toHaveLength(1);
    expect(renderedTexts).toContain('stream one');
    expect(renderedTexts).toContain('stream two');
  });
});
