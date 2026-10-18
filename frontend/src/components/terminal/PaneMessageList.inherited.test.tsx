import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PaneMessageList } from './PaneMessageList';
import type { ChatNodeState } from '../../state/chatTypes';
import { DEFAULT_PREFS } from '../../state/prefs';

const noop = () => {};
const message = (id: string, role: 'user' | 'assistant', text: string) => ({
  id, role, text, toolCalls: [],
});

function node(overrides: Partial<ChatNodeState> = {}): ChatNodeState {
  return {
    nodeId: 'extracted', kind: 'chat', chatId: null, projectId: 'project',
    status: 'idle', followUps: [], messagesLoaded: true,
    messages: [
      message('copied-u', 'user', 'Original research question'),
      message('copied-a', 'assistant', 'Important parent background'),
      message('own-u', 'user', 'Investigate this direction'),
      message('own-a', 'assistant', 'Independent branch answer'),
    ],
    inheritedMessageCount: 2,
    forkedFromNodeId: 'parent',
    ...overrides,
  };
}

function list(overrides: Partial<ChatNodeState> = {}) {
  return <PaneMessageList
    node={node(overrides)} prefs={DEFAULT_PREFS} contentStyle={{}}
    streaming={false} viewportHeight={800}
    onRetryTurn={noop} onEditUserMessage={noop} onContinueFollowUp={noop} onBranchFollowUp={noop}
  />;
}

describe('PaneMessageList inherited history', () => {
  it('separates copied parent history from the extracted thread\'s own turns', () => {
    const { container } = render(list());
    const divider = container.querySelector('.t-inherited-divider');
    expect(divider).toBeTruthy();
    expect(divider?.textContent).toContain('Inherited history');
    expect(divider?.textContent).toContain('2 messages');
    // The divider sits between the copied pair and the first own turn.
    const frames = Array.from(container.querySelectorAll('.terminal-message-frame'));
    const firstOwnFrame = frames[2];
    expect(firstOwnFrame.previousElementSibling).toBe(divider);
    expect(firstOwnFrame.textContent).toContain('Investigate this direction');
  });

  it('renders no divider for an ordinary (non-extracted) node', () => {
    const { container } = render(list({ inheritedMessageCount: 0, forkedFromNodeId: undefined }));
    expect(container.querySelector('.t-inherited-divider')).toBeNull();
  });
});
