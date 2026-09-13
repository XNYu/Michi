import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import TerminalDigest from './Digest';
import ManageComposer from '../manage/ManageComposer';

const createDigest = vi.hoisted(() => vi.fn());
const markDigestViewed = vi.hoisted(() => vi.fn());
const setDigestPrompt = vi.hoisted(() => vi.fn());
const store = vi.hoisted(() => ({
  project: null as any,
  nodes: {} as Record<string, any>,
}));

vi.mock('../../../state/chatStore', () => ({
  useChatStore: () => ({
    activeProject: store.project,
    createDigest,
    refreshDigest: vi.fn(),
    setDigestPrompt,
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

vi.mock('../manage/ManageComposer', () => ({
  default: vi.fn(({ onSubmitted }: { onSubmitted: () => void }) => (
    <button onClick={onSubmitted}>Submit digest follow-up</button>
  )),
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
  setDigestPrompt.mockReset();
  vi.mocked(ManageComposer).mockClear();
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
  it('keeps custom prompt controls out of the Electron drag region and accepts edits', () => {
    render(<TerminalDigest onNav={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: 'CUSTOM PROMPT' });
    expect(toggle.parentElement?.style.getPropertyValue('-webkit-app-region')
      || (toggle.parentElement?.style as any).WebkitAppRegion).toBe('no-drag');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.change(screen.getByRole('textbox', { name: 'Custom digest prompt' }), {
      target: { value: 'Summarize in Chinese' },
    });
    expect(setDigestPrompt).toHaveBeenCalledWith('d1', 'Summarize in Chinese');
  });

  it('shows live thoughts beside partial output and removes them after generation', () => {
    store.nodes.d1.digest = {
      ...store.nodes.d1.digest,
      status: 'streaming',
      content: 'Partial digest output',
      generation: { startedAt: Date.now(), thought: 'Comparing source conversations', activity: 'Writing digest...' },
    };
    const view = render(<TerminalDigest onNav={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Digest thinking' }).textContent).toBe('Comparing source conversations');
    expect(screen.getByText('Partial digest output')).toBeTruthy();
    expect((screen.getByRole('button', { name: /Rebuild/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(markDigestViewed).not.toHaveBeenCalled();

    store.nodes.d1 = { ...store.nodes.d1, digest: {
      ...store.nodes.d1.digest, status: 'idle', content: 'Final digest output', generatedAt: 30, generation: undefined,
    } };
    view.rerender(<TerminalDigest onNav={vi.fn()} />);
    expect(screen.queryByRole('region', { name: 'Digest generation' })).toBeNull();
    expect(screen.queryByText('Comparing source conversations')).toBeNull();
    expect(screen.getByText('Final digest output')).toBeTruthy();
    expect(markDigestViewed).toHaveBeenCalledWith('d1');
  });

  it('shows generation errors instead of an empty digest', () => {
    store.nodes.d1.digest = { ...store.nodes.d1.digest, status: 'error', content: '', error: 'Runtime unavailable' };
    render(<TerminalDigest onNav={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toBe('Runtime unavailable');
    expect(screen.queryByText(/digest is empty/)).toBeNull();
  });

  it('does not render the same summary twice before section headings arrive', () => {
    store.nodes.d1.digest = { ...store.nodes.d1.digest, status: 'streaming', content: '# Title\n\nSummary so far' };
    render(<TerminalDigest onNav={vi.fn()} />);
    expect(screen.getAllByText('Summary so far')).toHaveLength(1);
    expect(screen.queryByText('# Title\n\nSummary so far')).toBeNull();
  });

  it('uses the Home composer with the current digest and Agent selection', () => {
    const onNav = vi.fn();
    render(<TerminalDigest onNav={onNav} />);

    expect(vi.mocked(ManageComposer).mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      workspaceId: 'p1', parentNodeId: 'd1', enableAgentSelect: true,
    }));
    fireEvent.click(screen.getByText('Submit digest follow-up'));
    expect(onNav).toHaveBeenCalledWith('dashboard');
  });

  it.each(['workspace', 'thread'])('does not offer follow-up composition for an archived %s', (scope) => {
    if (scope === 'workspace') store.project.archivedAt = 1;
    else store.project.trees[0].archivedAt = 1;
    render(<TerminalDigest onNav={vi.fn()} />);
    expect(screen.queryByText('Submit digest follow-up')).toBeNull();
  });

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
    expect(vi.mocked(ManageComposer).mock.calls.at(-1)?.[0].parentNodeId).toBe('d2');
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
