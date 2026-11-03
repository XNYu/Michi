import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatNodeState } from '../../state/chatTypes';
import { claimFlight } from './messageFlight';
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
});

describe('PaneComposerPreBlocks queued → sent motion', () => {
  const queuedNode = (pendingQueued: ChatNodeState['pendingQueued'], nodeId = 'n1'): ChatNodeState => ({
    nodeId,
    kind: 'chat',
    chatId: 'chat-1',
    projectId: 'p1',
    messages: [],
    followUps: [],
    status: 'streaming',
    pendingQueued,
  });
  const queuedEntry = (id: string, value: string) => ({ id, value, mentions: [], attachments: [], queuedAt: 1 });
  const entry = queuedEntry('q1', 'Refine the running turn');

  /** Each mount is its own surface (pane), so flight state never carries over between tests. */
  function mount(entries = [entry], container = pane(), nodeId = 'n1') {
    const onRestoreQueued = vi.fn();
    const props = (node: ChatNodeState): React.ComponentProps<typeof PaneComposerPreBlocks> => ({
      node,
      quoteMaxLines: 2,
      quotedText: null,
      pendingAttachments: [],
      canSteerQueued: true,
      steeringQueueId: null,
      onSteerQueued: vi.fn(),
      onRestoreQueued,
      onEditPendingComment: vi.fn(),
      onRemovePendingComment: vi.fn(),
      onDismissQuote: vi.fn(),
      onRemovePendingAttachment: vi.fn(),
    });
    const view = render(<PaneComposerPreBlocks {...props(queuedNode(entries, nodeId))} />, { container });
    return {
      drain: () => view.rerender(<PaneComposerPreBlocks {...props(queuedNode([], nodeId))} />),
      onRestoreQueued,
      surface: container,
    };
  }

  function pane(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'terminal-pane';
    return document.body.appendChild(el);
  }

  beforeEach(() => {
    // A block's box: the second queued block sits below the first.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const top = this.textContent?.includes('second') ? 680 : 640;
      return { left: 12, top, width: 300, height: 40, right: 312, bottom: top + 40, x: 12, y: top, toJSON() {} } as DOMRect;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('a drained block hands its box to the bubble it becomes, and leaves out of reach', async () => {
    const { drain, surface } = mount();
    const block = screen.getByText('Refine the running turn').closest('.t-pre-block') as HTMLElement;
    drain();
    expect(claimFlight(surface, 'n1', 'u-1')?.top).toBe(640);
    // Still on screen while it folds away, but not reachable.
    expect(block.getAttribute('aria-hidden')).toBe('true');
    expect(block.hasAttribute('inert')).toBe(true);
    await waitFor(() => expect(block.isConnected).toBe(false));
  });

  it('a drained batch is one bubble: it flies from the first block, once', () => {
    const { drain, surface } = mount([queuedEntry('q1', 'first part'), queuedEntry('q2', 'second part')]);
    drain();
    expect(claimFlight(surface, 'n1', 'u-1')?.top).toBe(640);
    expect(claimFlight(surface, 'n1', 'u-2')).toBeUndefined();
  });

  it('a queued command makes no bubble, so it launches nothing', () => {
    const { drain, surface } = mount([queuedEntry('q1', '/compact')]);
    drain();
    expect(claimFlight(surface, 'n1', 'u-1')).toBeUndefined();
  });

  it('taking it back into the composer (×) is not a send, in either surface showing it', () => {
    // The restore record is global (by node, for 1s): this conversation is only used here.
    const grid = mount([entry], pane(), 'n-restore');
    const panel = mount([entry], pane(), 'n-restore');
    fireEvent.click(within(grid.surface).getByRole('button', { name: 'Dequeue message' }));
    expect(grid.onRestoreQueued).toHaveBeenCalledWith('q1');
    grid.drain();
    panel.drain();
    expect(claimFlight(grid.surface, 'n-restore', 'u-1')).toBeUndefined();
    expect(claimFlight(panel.surface, 'n-restore', 'u-1')).toBeUndefined();
  });
});
