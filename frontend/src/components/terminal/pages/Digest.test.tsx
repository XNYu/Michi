import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import TerminalDigest from './Digest';

const createDigest = vi.hoisted(() => vi.fn());
const markDigestViewed = vi.hoisted(() => vi.fn());
const store = vi.hoisted(() => ({
  project: null as any,
  nodes: {} as Record<string, any>,
}));

vi.mock('../../../state/chatStore', () => ({
  useChatStore: () => ({
    activeProject: store.project,
    createDigest,
    refreshDigest: vi.fn(),
    setDigestPrompt: vi.fn(),
    markDigestViewed,
    openPane: vi.fn(),
    createChildChat: vi.fn(),
  }),
  useChatNodesSnapshot: () => store.nodes,
  useChatNode: (id: string) => store.nodes[id] ?? null,
  chatLabel: (node: any) => node?.title ?? node?.nodeId ?? '',
}));

vi.mock('../../MarkdownContent', () => ({
  default: ({ text }: { text: string }) => <div>{text}</div>,
}));

function chat(id: string, title: string, messageCount = 1) {
  return {
    nodeId: id,
    projectId: 'p1',
    kind: 'chat',
    title,
    status: 'idle',
    messages: [],
    messageCount,
    followUps: [],
  };
}

function digest(id: string, sourceId: string, title: string, generatedAt: number) {
  return {
    nodeId: id,
    projectId: 'p1',
    kind: 'digest',
    title,
    status: 'idle',
    messages: [],
    followUps: [],
    digest: {
      sources: [sourceId],
      sourceFingerprints: {},
      content: `# ${title}\n\n${title} body`,
      generatedAt,
      viewedAt: generatedAt,
      status: 'idle',
    },
  };
}

function project(activeTreeId = 't1') {
  return {
    id: 'p1',
    name: 'Workspace',
    chatIds: ['r1', 'c1', 'r2', 'd1', 'd2'],
    edges: [{ source: 'r1', target: 'c1', kind: 'branch' }],
    trees: [
      { id: 't1', rootNodeId: 'r1', name: 'Current thread', createdAt: 1, lastActiveAt: 1 },
      { id: 't2', rootNodeId: 'r2', name: 'Other thread', createdAt: 2, lastActiveAt: 2 },
    ],
    activeTreeId,
    createdAt: 0,
  };
}

beforeEach(() => {
  createDigest.mockReset().mockResolvedValue('new-digest');
  markDigestViewed.mockReset();
  store.project = project();
  store.nodes = {
    r1: chat('r1', 'Root one', 2),
    c1: chat('c1', 'Child one', 3),
    r2: chat('r2', 'Root two', 4),
    d1: digest('d1', 'r1', 'Current digest', 10),
    d2: digest('d2', 'r2', 'Other digest', 20),
  };
});

describe('TerminalDigest thread scope', () => {
  it('opens the active thread digest directly and hides workspace-level digest cards', () => {
    render(<TerminalDigest onNav={vi.fn()} />);

    expect(screen.getByText('Current digest')).toBeTruthy();
    expect(screen.queryByText('Other digest')).toBeNull();
    expect(screen.getByText('thread')).toBeTruthy();
    expect(screen.queryByText('← all')).toBeNull();
  });

  it('follows the active thread when it changes', () => {
    const view = render(<TerminalDigest onNav={vi.fn()} />);
    expect(screen.getByText('Current digest')).toBeTruthy();

    store.project = project('t2');
    view.rerender(<TerminalDigest onNav={vi.fn()} />);

    expect(screen.getByText('Other digest')).toBeTruthy();
    expect(screen.queryByText('Current digest')).toBeNull();
  });

  it('shows an inline prompt and creates a digest from every chat in the active thread', async () => {
    store.project = {
      ...project(),
      chatIds: ['r1', 'c1', 'r2'],
    };
    store.nodes = {
      r1: chat('r1', 'Root one', 2),
      c1: chat('c1', 'Child one', 3),
      r2: chat('r2', 'Root two', 4),
    };

    render(<TerminalDigest onNav={vi.fn()} />);

    expect(screen.getByText('Create this thread’s digest')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Digest guidance (optional)'), {
      target: { value: 'Focus on decisions and next steps' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create digest' }));

    await waitFor(() => {
      expect(createDigest).toHaveBeenCalledWith(
        'p1',
        ['r1', 'c1'],
        'Focus on decisions and next steps',
      );
    });
  });
});
