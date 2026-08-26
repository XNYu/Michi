import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatNodeState } from '../../state/chatTypes';
import { PaneComposerPreBlocks } from './PaneComposerPreBlocks';

vi.mock('../../state/chatStore', () => ({
  useChatProjects: () => ({ activeProject: undefined }),
}));

function renderQueue(overrides: Partial<React.ComponentProps<typeof PaneComposerPreBlocks>> = {}) {
  const node: ChatNodeState = {
    nodeId: 'n1',
    kind: 'chat',
    chatId: 'chat-1',
    projectId: 'p1',
    messages: [],
    followUps: [],
    status: 'streaming',
    pendingQueued: [{
      id: 'q1',
      value: 'Refine the running turn',
      mentions: [],
      attachments: [],
      queuedAt: 1,
    }],
  };
  const props: React.ComponentProps<typeof PaneComposerPreBlocks> = {
    node,
    quoteMaxLines: 2,
    quotedText: null,
    pendingAttachments: [],
    canSteerQueued: true,
    steeringQueueId: null,
    onSteerQueued: vi.fn(),
    onRestoreQueued: vi.fn(),
    onEditPendingComment: vi.fn(),
    onRemovePendingComment: vi.fn(),
    onDismissQuote: vi.fn(),
    onRemovePendingAttachment: vi.fn(),
    ...overrides,
  };
  render(<PaneComposerPreBlocks {...props} />);
  return props;
}

describe('PaneComposerPreBlocks queued steer', () => {
  it('keeps the message queued and offers an explicit Steer now action', () => {
    const props = renderQueue();
    expect(screen.getByText(/sends when stream ends/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Steer now' }));
    expect(props.onSteerQueued).toHaveBeenCalledWith('q1');
  });

  it('hides steer for runtimes without native steering', () => {
    renderQueue({ canSteerQueued: false });
    expect(screen.queryByRole('button', { name: 'Steer now' })).toBeNull();
  });

  it('shows progress while a queued message is being steered', () => {
    renderQueue({ steeringQueueId: 'q1' });
    expect((screen.getByRole('button', { name: 'Steering…' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
