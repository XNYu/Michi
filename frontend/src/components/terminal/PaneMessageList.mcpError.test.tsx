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
  it('keeps new failures before the tail spacer so follow mode does not track empty space', () => {
    const { container, rerender } = render(list(node));
    const content = container.firstElementChild!;
    const spacer = content.lastElementChild as HTMLElement;
    expect(spacer.getAttribute('aria-hidden')).toBe('true');
    expect(spacer.style.height).toBe('560px');

    rerender(list({ ...node, mcpServerError: failure }));

    expect(screen.getByText(/MCP server/).textContent).toContain(failure.error);
    expect(content.lastElementChild).toBe(spacer);
    expect(screen.getByText(/MCP server/).parentElement!.nextElementSibling).toBe(spacer);
    expect(container.querySelector('[data-msg-id="u1"]')!.textContent).toContain('Continue this task');
  });

  it('wraps long transport errors without crowding out the dismiss button', () => {
    render(list({ ...node, mcpServerError: { ...failure, error: 'Transport::'.repeat(80) } }));
    const text = screen.getByText(/Transport::/);
    expect(text.style.minWidth).toBe('0');
    expect(text.style.overflowWrap).toBe('anywhere');
    expect(screen.getByRole('button', { name: 'Dismiss' })).not.toBeNull();
  });

  it('dismisses a failure and shows a subsequent distinct failure', () => {
    const { rerender } = render(list({ ...node, mcpServerError: failure }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/MCP server/)).toBeNull();

    rerender(list({ ...node, mcpServerError: { ...failure, error: 'Connection refused' } }));
    expect(screen.getByText(/MCP server/).textContent).toContain('Connection refused');
  });
});
