import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import MergeBanner from './MergeBanner';

// Mock the chatStore module so we can control hook return values.
vi.mock('../../state/chatStore', () => ({
  useChatStore: vi.fn(),
  useChatNodesSnapshot: vi.fn(),
}));

// Mock mergePreamble so we can control token estimates.
vi.mock('../../state/mergePreamble', () => ({
  MERGE_PREAMBLE_TOKEN_WARN: 32_000,
  estimateMergePreambleTokens: vi.fn(),
}));

import * as chatStoreModule from '../../state/chatStore';
import * as mergePreambleModule from '../../state/mergePreamble';

function makeActiveProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj-1',
    name: 'Test',
    chatIds: ['n-merge', 'n-1', 'n-2'],
    edges: [
      { source: 'n-1', target: 'n-merge', kind: 'merge' },
      { source: 'n-2', target: 'n-merge', kind: 'merge' },
    ],
    createdAt: 0,
    trees: [],
    activeTreeId: null,
    artifacts: [],
    ...overrides,
  };
}

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    activeProject: makeActiveProject(),
    ...overrides,
  };
}

function makeNodes(overrides: Record<string, unknown> = {}) {
  return {
    'n-1': {
      id: 'n-1',
      title: 'Thread A',
      messages: [{ role: 'user', text: 'hello', id: 'msg-1', toolCalls: [] }],
      mergeSources: undefined,
      deletedAt: undefined,
    },
    'n-2': {
      id: 'n-2',
      title: 'Thread B',
      messages: [{ role: 'user', text: 'world', id: 'msg-2', toolCalls: [] }],
      mergeSources: undefined,
      deletedAt: undefined,
    },
    'n-merge': {
      id: 'n-merge',
      title: 'Merged',
      messages: [],
      mergeSources: ['n-1', 'n-2'],
      deletedAt: undefined,
    },
    ...overrides,
  };
}

describe('MergeBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(chatStoreModule.useChatStore).mockReturnValue(makeStore() as never);
    vi.mocked(chatStoreModule.useChatNodesSnapshot).mockReturnValue(makeNodes() as never);
    vi.mocked(mergePreambleModule.estimateMergePreambleTokens).mockReturnValue(0);
  });

  it('renders nothing when node has no mergeSources', () => {
    vi.mocked(chatStoreModule.useChatNodesSnapshot).mockReturnValue(
      makeNodes({
        'n-merge': {
          id: 'n-merge',
          title: 'Not a merge',
          messages: [],
          mergeSources: undefined,
          deletedAt: undefined,
        },
      }) as never,
    );

    const { container } = render(<MergeBanner nodeId="n-merge" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when mergeSources is empty array', () => {
    vi.mocked(chatStoreModule.useChatNodesSnapshot).mockReturnValue(
      makeNodes({
        'n-merge': {
          id: 'n-merge',
          title: 'Not a merge',
          messages: [],
          mergeSources: [],
          deletedAt: undefined,
        },
      }) as never,
    );

    const { container } = render(<MergeBanner nodeId="n-merge" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when node already has messages (first message sent)', () => {
    vi.mocked(chatStoreModule.useChatNodesSnapshot).mockReturnValue(
      makeNodes({
        'n-merge': {
          id: 'n-merge',
          title: 'Merged',
          messages: [{ role: 'user', text: 'first msg', id: 'msg-x', toolCalls: [] }],
          mergeSources: ['n-1', 'n-2'],
          deletedAt: undefined,
        },
      }) as never,
    );

    const { container } = render(<MergeBanner nodeId="n-merge" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders warning banner when estimated tokens exceed 32k', () => {
    vi.mocked(mergePreambleModule.estimateMergePreambleTokens).mockReturnValue(40_000);

    render(<MergeBanner nodeId="n-merge" />);

    const alert = screen.getByRole('alert');
    expect(alert).toBeTruthy();
    expect(alert.textContent).toMatch(/may exceed model context/i);
    expect(alert.textContent).toMatch(/40,000/);
  });

  it('renders nothing when estimated tokens are at or below 32k', () => {
    vi.mocked(mergePreambleModule.estimateMergePreambleTokens).mockReturnValue(32_000);

    const { container } = render(<MergeBanner nodeId="n-merge" />);
    expect(container.firstChild).toBeNull();
  });

  it('can be dismissed — banner disappears after clicking Dismiss', () => {
    vi.mocked(mergePreambleModule.estimateMergePreambleTokens).mockReturnValue(40_000);

    render(<MergeBanner nodeId="n-merge" />);
    expect(screen.getByRole('alert')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));

    expect(screen.queryByRole('alert')).toBeNull();
  });
});
