import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatNodeState } from '../../state/chatTypes';
import { DEFAULT_PREFS } from '../../state/prefs';
import { PaneMessageList } from './PaneMessageList';

vi.mock('../MarkdownContent', () => ({
  default: ({ text }: { text: string }) => <span>{text}</span>,
}));

const node: ChatNodeState = {
  nodeId: 'mcp-error-node',
  kind: 'chat',
  chatId: null,
  projectId: 'p1',
  status: 'streaming',
  messages: [
    { id: 'u1', role: 'user', text: 'Continue this task', toolCalls: [] },
    { id: 'a1', role: 'assistant', text: '', toolCalls: [], streaming: true },
  ],
  followUps: [],
};
const failure = { serverName: 'treg', error: 'MCP HTTP headers helper returned a reserved header' };
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

describe('PaneMessageList MCP failures', () => {
  it('dismisses a failure and shows a subsequent distinct failure', () => {
    const { rerender } = render(list({ ...node, mcpServerError: failure }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/MCP server/)).toBeNull();

    rerender(list({ ...node, mcpServerError: { ...failure, error: 'Connection refused' } }));
    expect(screen.getByText(/MCP server/).textContent).toContain('Connection refused');
  });
});


it('shows a repeated provider warning for a different owning turn after dismissal', () => {
  const warning = { source: 'anthropic-api', category: 'provider' as const, message: 'Retrying request' };
  const warned = (id: string): ChatNodeState => ({ ...node, messages: [{ id, role: 'assistant', text: '', toolCalls: [], warnings: [warning] }] });
  const { rerender } = render(list(warned('turn-one')));
  expect(screen.getByText('anthropic-api: Retrying request')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss warning' }));
  expect(screen.queryByText('anthropic-api: Retrying request')).toBeNull();
  rerender(list(warned('turn-two')));
  expect(screen.getByText('anthropic-api: Retrying request')).not.toBeNull();
  expect(screen.queryByText(/MCP server/)).toBeNull();
});
