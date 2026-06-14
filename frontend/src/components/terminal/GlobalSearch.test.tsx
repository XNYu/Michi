import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import GlobalSearch from './GlobalSearch';
import type { ChatNodeState, Project } from '../../state/chatTypes';

function makeFixture() {
  const nodes: Record<string, ChatNodeState> = {
    a1: {
      nodeId: 'a1', chatId: null, projectId: 'p1', kind: 'chat',
      title: 'Pricing thread',
      messages: [
        { id: 'm1', role: 'user', text: 'how should we handle tier-3 enterprise pricing?', toolCalls: [] },
      ],
      followUps: [], status: 'idle',
    },
    b1: {
      nodeId: 'b1', chatId: null, projectId: 'p2', kind: 'chat',
      title: 'Other workspace thread',
      messages: [
        { id: 'm2', role: 'assistant', text: 'tier-3 SLA includes...', toolCalls: [] },
      ],
      followUps: [], status: 'idle',
    },
  };
  const projects: Project[] = [
    { id: 'p1', name: 'Workspace 1', chatIds: ['a1'], edges: [], trees: [], activeTreeId: null, createdAt: 0 },
    { id: 'p2', name: 'Workspace 2', chatIds: ['b1'], edges: [], trees: [], activeTreeId: null, createdAt: 0 },
  ];
  return { nodes, projects };
}

beforeEach(() => {
  // The component debounces by 200ms; advance fake timers in tests.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

describe('GlobalSearch', () => {
  it('returns null when open is false', () => {
    const { nodes, projects } = makeFixture();
    const { container } = render(
      <GlobalSearch
        open={false}
        nodes={nodes}
        projects={projects}
        activeProjectId="p1"
        onClose={vi.fn()}
        onOpenMatch={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows hint copy on empty query', () => {
    const { nodes, projects } = makeFixture();
    render(
      <GlobalSearch
        open
        nodes={nodes}
        projects={projects}
        activeProjectId="p1"
        onClose={vi.fn()}
        onOpenMatch={vi.fn()}
      />,
    );
    expect(screen.getByText(/type to search/i)).toBeTruthy();
  });

  it('renders grouped results across workspaces', async () => {
    const { nodes, projects } = makeFixture();
    render(
      <GlobalSearch
        open
        nodes={nodes}
        projects={projects}
        activeProjectId="p1"
        onClose={vi.fn()}
        onOpenMatch={vi.fn()}
      />,
    );
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'tier-3' } });
    // Advance debounce timer.
    await vi.advanceTimersByTimeAsync(250);
    expect(screen.getByText(/Workspace 1/)).toBeTruthy();
    expect(screen.getByText(/Workspace 2/)).toBeTruthy();
  });

  it('Esc closes the modal', () => {
    const onClose = vi.fn();
    const { nodes, projects } = makeFixture();
    render(
      <GlobalSearch
        open
        nodes={nodes}
        projects={projects}
        activeProjectId="p1"
        onClose={onClose}
        onOpenMatch={vi.fn()}
      />,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('Enter on the active result calls onOpenMatch with a payload', async () => {
    const onOpenMatch = vi.fn();
    const { nodes, projects } = makeFixture();
    render(
      <GlobalSearch
        open
        nodes={nodes}
        projects={projects}
        activeProjectId="p1"
        onClose={vi.fn()}
        onOpenMatch={onOpenMatch}
      />,
    );
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'tier-3' } });
    await vi.advanceTimersByTimeAsync(250);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onOpenMatch).toHaveBeenCalledTimes(1);
    const arg = onOpenMatch.mock.calls[0][0];
    expect(arg).toMatchObject({
      nodeId: expect.any(String),
      messageId: expect.any(String),
      projectId: expect.any(String),
    });
  });
});
