import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import AskUserAlertBar from './AskUserAlertBar';
import type { ChatNodeState } from '../../state/chatTypes';

vi.mock('../../state/chatStore', () => ({
  useChatProjects: vi.fn(),
  useChatActions: vi.fn(),
  useStructuralSelector: vi.fn(),
}));

import * as chatStore from '../../state/chatStore';

const project = {
  id: 'p-1',
  name: 'WS',
  chatIds: ['root', 'child'],
  edges: [{ source: 'root', target: 'child', kind: 'branch' }],
  trees: [{ id: 't-1', rootNodeId: 'root' }],
  activeTreeId: 't-1',
  createdAt: 0,
};

const actions = {
  selectProject: vi.fn(),
  openPane: vi.fn(),
  openPaneInTree: vi.fn(),
  activateTree: vi.fn(),
  setFocusedNodeId: vi.fn(),
};

function askingNode(nodeId: string, title: string, requestId: number): ChatNodeState {
  return {
    nodeId,
    kind: 'chat',
    chatId: nodeId,
    projectId: 'p-1',
    title,
    messages: [{ id: `${nodeId}-m1`, role: 'assistant', text: '' }],
    followUps: [],
    status: 'streaming',
    pendingUserInput: {
      requestId,
      questions: [{ question: `Pick one for ${title}?`, options: [], multiSelect: false }],
      answers: [],
    },
  } as unknown as ChatNodeState;
}

/** Feed a nodes map through the REAL selector the component passes in. */
function withNodes(nodes: Record<string, ChatNodeState>) {
  vi.mocked(chatStore.useStructuralSelector).mockImplementation(
    ((selector: (n: Record<string, ChatNodeState>) => unknown) => selector(nodes)) as never,
  );
}

describe('AskUserAlertBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(chatStore.useChatProjects).mockReturnValue({
      projects: [project],
      activeProject: project,
    } as never);
    vi.mocked(chatStore.useChatActions).mockReturnValue(actions as never);
  });

  it('counts the extra asks beyond the first', () => {
    withNodes({
      child: askingNode('child', 'A', 1),
      root: askingNode('root', 'B', 2),
    });
    render(<AskUserAlertBar />);
    expect(screen.getByRole('alert').textContent).toContain('+1 more question');
  });

  it('clicking navigates to the asking node, opens the dashboard and scrolls to the ask', () => {
    withNodes({ child: askingNode('child', 'Deploy plan', 4) });
    const onNav = vi.fn();
    const scrolls: Array<{ nodeId?: string; messageId?: string }> = [];
    const onScroll = (e: Event) => scrolls.push((e as CustomEvent).detail);
    window.addEventListener('michi:scroll-to-message', onScroll as EventListener);
    const rafs: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafs.push(cb);
      return rafs.length;
    });

    render(<AskUserAlertBar onNav={onNav} />);
    fireEvent.click(screen.getByRole('alert'));

    // Same workspace + same active tree → plain openPane, then sidebar focus.
    expect(actions.openPane).toHaveBeenCalledWith('child');
    expect(actions.setFocusedNodeId).toHaveBeenCalledWith('child');
    expect(onNav).toHaveBeenCalledWith('dashboard');

    rafs.forEach((cb) => cb(0));
    expect(scrolls).toEqual([{ nodeId: 'child', messageId: 'child-m1' }]);

    window.removeEventListener('michi:scroll-to-message', onScroll as EventListener);
  });

  it('opens its height when an ask arrives; one pending at mount shows at once', () => {
    withNodes({});
    const { container, rerender, unmount } = render(<AskUserAlertBar />);
    expect(container.firstChild).toBeNull();
    withNodes({ child: askingNode('child', 'Deploy plan', 4) });
    rerender(<AskUserAlertBar />);
    expect(screen.getByRole('alert')).toBeTruthy();
    const arriving = container.firstChild as HTMLElement;
    expect(arriving.style.overflow).toBe('hidden');
    expect(arriving.style.height).toBe('0px');
    unmount();

    render(<AskUserAlertBar />);
    const shell = screen.getByRole('alert').parentElement as HTMLElement;
    expect(shell.style.height).toBe('auto');
    expect(shell.style.opacity).toBe('1');
  });

  it('closes when the last ask is answered, no longer an alert or a target while it leaves', async () => {
    withNodes({ child: askingNode('child', 'Deploy plan', 4) });
    const { container, rerender } = render(<AskUserAlertBar />);
    withNodes({});
    rerender(<AskUserAlertBar />);

    const leaving = container.querySelector('.ask-alert-bar') as HTMLElement;
    expect(leaving).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(leaving.getAttribute('aria-hidden')).toBe('true');
    expect(leaving.hasAttribute('inert')).toBe(true);
    fireEvent.click(leaving);
    fireEvent.click(leaving.querySelector('.ask-alert-cta') as HTMLElement);
    expect(actions.openPane).not.toHaveBeenCalled();
    await waitFor(() => expect(container.querySelector('.ask-alert-bar')).toBeNull());
  });

  it('exposes a keyboard/AT-reachable Answer button that navigates exactly once', () => {
    withNodes({ child: askingNode('child', 'Deploy plan', 4) });
    render(<AskUserAlertBar />);

    fireEvent.click(screen.getByRole('button', { name: /answer the agent's question/i }));

    // stopPropagation keeps the row's onClick from firing a second navigation.
    expect(actions.openPane).toHaveBeenCalledTimes(1);
    expect(actions.setFocusedNodeId).toHaveBeenCalledTimes(1);
  });
});
