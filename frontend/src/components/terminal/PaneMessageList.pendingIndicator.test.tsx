import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatNodeState } from '../../state/chatTypes';
import { DEFAULT_PREFS } from '../../state/prefs';
import { PaneMessageList } from './PaneMessageList';

vi.mock('../MarkdownContent', () => ({
  default: ({ text }: { text: string }) => <span>{text}</span>,
}));

const node: ChatNodeState = {
  nodeId: 'pending-node',
  kind: 'chat',
  chatId: null,
  projectId: 'p1',
  status: 'streaming',
  messages: [
    { id: 'u1', role: 'user', text: 'michi', toolCalls: [] },
    { id: 'a1', role: 'assistant', text: '', toolCalls: [], streaming: true },
  ],
  followUps: [],
};
const noop = () => {};

function list(value: ChatNodeState) {
  return <PaneMessageList
    node={value}
    prefs={DEFAULT_PREFS}
    contentStyle={{}}
    streaming={value.status === 'streaming'}
    viewportHeight={800}
    onRetryTurn={noop}
    onEditUserMessage={noop}
    onContinueFollowUp={noop}
    onBranchFollowUp={noop}
  />;
}

describe('PaneMessageList pending indicator', () => {
  it('shows the in-bubble dots for an empty turn with no labelled activity', () => {
    render(list(node));
    expect(screen.getByRole('status', { name: 'loading' })).not.toBeNull();
  });

  it('shows one indicator when a runtime activity labels the empty turn', () => {
    render(list({ ...node, runtimeActivity: 'Restoring original Claude session' }));
    expect(screen.queryByRole('status', { name: 'loading' })).toBeNull();
    expect(screen.getByRole('status', { name: /Restoring original Claude session/ })).not.toBeNull();
  });
});
