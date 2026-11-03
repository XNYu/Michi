// Locks the role-differentiation styling contract for MessageBlock.
// User: right-aligned paper-card bubble with no role/time label; surface +
//   drop shadow + 72% max-width live in index.css (.terminal-message-user),
//   not inline. The time shows only in the hover action row.
// Assistant: flush-left, no border, no fill, "> michi" label above.
// Asserts on inline style strings because jsdom doesn't resolve var()/color-mix()/calc().
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, render, fireEvent, waitFor } from '@testing-library/react';
import { MessageBlock, TermThoughtBlock } from './MessageBlock';
import { AgentBlockStyleOverride } from '../../state/prefs';
import { recordBackendObservation, resetBackendClocksForTest } from '../../services/backendClock';
import type { AssistantBlock, ChatMessage } from '../../state/chatTypes';

const baseMsg = {
  id: 'm1',
  role: 'user' as const,
  text: 'hello',
  toolCalls: [],
  streaming: false,
} satisfies Partial<ChatMessage> as ChatMessage;

const noop = () => {};

function renderMessage(
  overrides: Partial<ChatMessage>,
  extraProps?: {
    isErrorTail?: boolean;
    onRetry?: () => void;
    errorMessage?: string;
    usageInfo?: React.ComponentProps<typeof MessageBlock>['usageInfo'];
  },
) {
  return render(
    <MessageBlock
      m={{ ...baseMsg, ...overrides }}
      index={0}
      isDark={false}
      // Only pass onRetry when explicitly provided so MessageActions doesn't
      // render its own hover-retry button in tests that only care about the
      // error-tail row.
      onRetry={extraProps?.onRetry}
      onEdit={noop}
      onCopy={noop}
      showThoughts={false}
      fontFamily={'inherit'}
      density={'comfortable'}
      usageInfo={extraProps?.usageInfo}
      isErrorTail={extraProps?.isErrorTail}
      errorMessage={extraProps?.errorMessage}
    />,
  );
}

describe('MessageBlock — role styling', () => {
  it('marks a relayed thread message and links to the sending thread', () => {
    const onMentionClick = vi.fn();
    const { container, getByRole } = render(
      <MessageBlock
        m={{ ...baseMsg, text: 'Please review', threadMessage: { fromNodeId: 'n-a', fromTitle: 'Research notes' } }}
        index={0}
        isDark={false}
        onEdit={noop}
        onCopy={noop}
        showThoughts={false}
        fontFamily={'inherit'}
        density={'comfortable'}
        onMentionClick={onMentionClick}
      />,
    );
    const marker = container.querySelector('.terminal-message-thread-source');
    expect(marker?.textContent).toBe('From Research notes');
    expect(container.querySelector('.terminal-message-user')?.textContent).toContain('Please review');
    fireEvent.click(getByRole('button', { name: 'Research notes' }));
    expect(onMentionClick).toHaveBeenCalledWith('Research notes', 'node', 'n-a');
  });
});

describe('MessageBlock — turn usage', () => {
  it('shows native Codex token usage beside the completed assistant turn', () => {
    const { getByTestId } = renderMessage(
      { role: 'assistant', text: 'done', streaming: false },
      {
        usageInfo: {
          durationMs: 9_700,
          credits: 0,
          totalTokens: 1_534,
          inputTokens: 1_234,
          cachedInputTokens: 800,
          outputTokens: 300,
          reasoningOutputTokens: 120,
          contextUsagePercentage: 12.5,
        },
      },
    );
    const usage = getByTestId('turn-usage');
    expect(usage.textContent).toBe('usage 1.5k tokens (1.2k in / 300 out) · 9.7s');
    expect(usage.getAttribute('title')).toContain('800 cached input tokens');
    expect(usage.getAttribute('title')).toContain('12.5% context used');
  });
});

describe('MessageBlock — error-tail row', () => {
  it('renders the friendly error message when provided', () => {
    const msg = 'Claude slots are busy. Stop a running reply or wait for one to finish, then retry.';
    const { getByText } = renderMessage(
      { role: 'assistant', text: '' },
      { isErrorTail: true, onRetry: noop, errorMessage: msg },
    );
    expect(getByText(msg)).not.toBeNull();
  });

  it('calls onRetry when the error-tail retry button is clicked', () => {
    const onRetry = vi.fn();
    const { getByTestId } = renderMessage(
      { role: 'assistant', text: 'something went wrong' },
      { isErrorTail: true, onRetry },
    );
    fireEvent.click(getByTestId('error-tail-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('MessageBlock — highlight frame', () => {
  const props = {
    index: 0, isDark: false, onEdit: noop, onCopy: noop, onRetry: noop, showThoughts: false,
    fontFamily: 'inherit', density: 'comfortable' as const,
  };
  const reply = { ...baseMsg, role: 'assistant' as const, text: 'The cited reply' };
  const mark = <div data-testid="mark">Referenced by page</div>;

  it('frames the mark and the message, and keeps the hover actions under the frame', () => {
    const { container, getByTestId, getByRole } = render(<MessageBlock {...props} m={reply} highlight={mark} />);
    const frame = container.querySelector('.terminal-message-highlight')!;
    expect(frame.firstElementChild).toBe(getByTestId('mark'));
    expect(frame.textContent).toContain('The cited reply');
    const copy = getByRole('button', { name: 'copy message' });
    // Nothing of the reserved actions row sits inside the frame, so its bottom is the message's.
    expect(frame.contains(copy)).toBe(false);
    expect(frame.lastElementChild!.classList.contains('terminal-message-assistant')).toBe(true);
    const actions = copy.parentElement!;
    expect(actions.style.opacity).toBe('0');
    fireEvent.mouseEnter(frame.parentElement!);
    expect(actions.style.opacity).toBe('1');
    fireEvent.mouseEnter(copy);
    expect(actions.style.opacity).toBe('1');
  });

  it('leaves a message that is not highlighted as it was', () => {
    const { container, getByRole } = render(<MessageBlock {...props} m={reply} />);
    expect(container.querySelector('.terminal-message-highlight')).toBeNull();
    const root = container.firstElementChild!;
    expect(root.firstElementChild!.textContent).toBe('> michi');
    expect(root.contains(getByRole('button', { name: 'copy message' }))).toBe(true);
  });
});

describe('MessageBlock — user modules', () => {
  it('renders one AttachmentPill per attachment', () => {
    const { container } = renderMessage({
      role: 'user',
      text: 'check these',
      attachments: [
        { name: 'a.tsx', absPath: '/a.tsx' },
        { name: 'b.tsx', absPath: '/b.tsx' },
      ],
    });
    expect(container.querySelectorAll('[data-testid="attachment-pill"]').length).toBe(2);
  });

  it('renders one CommentChip per comment', () => {
    const { container } = renderMessage({
      role: 'user',
      text: 'follow up',
      comments: [
        { id: 'c1', quotedText: 'q1', body: 'b1', createdAt: 0 },
        { id: 'c2', quotedText: 'q2', body: 'b2', createdAt: 0 },
      ],
    });
    expect(container.querySelectorAll('[data-testid="comment-quote"]').length).toBe(2);
  });
});

describe('MessageBlock — subagents forwarding', () => {
  it('renders the SubAgent spine row and now line when matching subagents are passed', () => {
    const detail = JSON.stringify({ subagent_type: 'Explore', description: 'Explore Michi' });
    const subagentTool = {
      id: 't1',
      title: 'Agent',
      status: 'in_progress',
      kind: 'tool',
      detail,
    };
    const m = {
      ...baseMsg,
      role: 'assistant' as const,
      text: '',
      toolCalls: [subagentTool],
      blocks: [
        { id: 'a1', kind: 'answer' as const, rawText: '' },
        {
          id: 'b1',
          kind: 'tool' as const,
          toolCallId: 't1',
          section: 'answer' as const,
          rawOffset: 0,
        },
      ],
    } as ChatMessage;

    const { getByTestId, container } = render(
      <MessageBlock
        m={m}
        index={0}
        isDark={true}
        onCopy={noop}
        showThoughts={true}
        fontFamily="monospace"
        density="comfortable"
        subagents={[
          {
            sessionId: 's1',
            sessionName: 's1',
            agentName: 'Explore',
            initialQuery: 'Explore Michi',
            status: 'working',
            group: 'g',
            dependsOn: [],
            currentTool: 'Glob',
          },
        ]}
      />,
    );
    expect(getByTestId('subagent-spine-row')).toBeTruthy();
    expect(container.textContent).toContain('now ❯ Glob');
  });
});

describe('MessageBlock — collapsed user text', () => {
  it('fades only the clamped content and keeps the expansion control outside the overlay', () => {
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
    try {
      const { container, getByRole } = renderMessage({ role: 'user', text: 'A long message that overflows the measured preview.' });
      const toggle = getByRole('button', { name: 'Show more' });
      const content = container.querySelector(`[id="${toggle.getAttribute('aria-controls')}"]`) as HTMLElement;
      const fade = content.querySelector<HTMLElement>('[aria-hidden="true"]');
      expect(content.style.maxHeight).not.toBe('');
      expect(content.style.position).toBe('relative');
      expect(fade?.parentElement).toBe(content);
      expect(content.contains(toggle)).toBe(false);
      expect(toggle.classList.contains('t-user-text-toggle')).toBe(true);
      expect(toggle.style.color).toBe('');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(toggle);
      expect(getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe('true');
      expect(content.querySelector('[aria-hidden="true"]')).toBeNull();
      expect(content.style.maxHeight).toBe('');
      fireEvent.click(toggle);
      expect(content.querySelector('[aria-hidden="true"]')).toBeTruthy();
    } finally {
      height.mockRestore();
      width.mockRestore();
    }
  });

  it('opens and closes as a height disclosure that moves in the click’s own commit', async () => {
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
    try {
      const { container, getByRole } = renderMessage({ role: 'user', text: 'A long message that overflows the measured preview.' });
      const toggle = getByRole('button', { name: 'Show more' });
      const content = container.querySelector(`[id="${toggle.getAttribute('aria-controls')}"]`) as HTMLElement;
      const clamp = parseFloat(content.style.maxHeight);
      expect(clamp).toBeGreaterThan(0);
      let shown = clamp;
      const box = vi.spyOn(content, 'getBoundingClientRect').mockImplementation(
        () => ({ height: shown, width: 400, top: 0, left: 0, right: 400, bottom: shown, x: 0, y: 0, toJSON() {} }) as DOMRect,
      );
      const probe = document.createElement('div');
      const heights = new MutationObserver(() => {});
      heights.observe(content, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
      const heightsSoFar = () => heights.takeRecords().flatMap((r) => {
        probe.setAttribute('style', r.oldValue ?? '');
        return [probe.style.height, content.style.height].filter(Boolean);
      });

      fireEvent.click(toggle);
      // The first frame is already 1px taller than the clamp: TPane sees the
      // transcript change in this commit and leaves follow mode.
      expect(heightsSoFar()).toContain(`${clamp + 1}px`);
      expect(content.style.maxHeight).toBe('');
      await waitFor(() => expect(content.style.height).toBe(''));

      shown = 500;
      fireEvent.click(getByRole('button', { name: 'Show less' }));
      expect(heightsSoFar()).toContain('499px');
      // Clamped again once the height has come down.
      await waitFor(() => expect(content.style.maxHeight).toBe(`${clamp}px`));
      expect(content.style.height).toBe('');
      heights.disconnect();
      box.mockRestore();
    } finally {
      height.mockRestore();
      width.mockRestore();
    }
  });

  it('does not clamp while the pane has no width yet', () => {
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);
    try {
      const { queryByRole } = renderMessage({ role: 'user', text: 'A short message in a pane that is still opening.' });
      expect(queryByRole('button', { name: 'Show more' })).toBeNull();
    } finally {
      height.mockRestore();
    }
  });
});

describe('MessageBlock — branch anchors motion', () => {
  const reply = { ...baseMsg, id: 'a1', role: 'assistant' as const, text: 'An answer' };
  const anchor = (childNodeId: string, createdAt: number) =>
    ({ childNodeId, title: `Branch ${childNodeId}`, messageCount: 1, createdAt, status: 'idle' as const });
  const block = (anchors: ReturnType<typeof anchor>[]) => (
    <MessageBlock
      m={reply} index={0} isDark={false} onEdit={noop} onCopy={noop} showThoughts={false}
      fontFamily="inherit" density="comfortable" turnAnchors={anchors} onOpenBranch={noop}
    />
  );
  const sectionOf = (container: HTMLElement) =>
    container.querySelector('section[aria-label="Branches from this reply"]') as HTMLElement;
  const grows = (el: HTMLElement | null) => el?.parentElement?.style.display === 'flow-root';

  it('renders branches made earlier settled', () => {
    const { container } = render(block([anchor('b1', Date.now() - 60_000)]));
    expect(grows(sectionOf(container))).toBe(false);
  });

  it('grows the list in when its first branch was made just now', () => {
    const { container } = render(block([anchor('b1', Date.now())]));
    expect(grows(sectionOf(container))).toBe(true);
    // One entrance: the row inside the growing list does not grow again.
    expect(grows(sectionOf(container).querySelector('.t-branch-anchor-row'))).toBe(false);
  });

  it('a new branch on an existing list grows in as its own row', () => {
    const { container, rerender } = render(block([anchor('b1', Date.now() - 60_000)]));
    rerender(block([anchor('b1', Date.now() - 60_000), anchor('b2', Date.now())]));
    const rows = sectionOf(container).querySelectorAll<HTMLElement>('.t-branch-anchor-row');
    expect(grows(sectionOf(container))).toBe(false);
    expect(grows(rows[0])).toBe(false);
    expect(grows(rows[1])).toBe(true);
    expect(sectionOf(container).querySelector('h3')?.textContent).toBe('Branches 2');
  });
});

describe('MessageBlock — user message markdown', () => {
  it('renders inline markdown instead of literal markers', () => {
    const { container } = renderMessage({ role: 'user', text: 'This is **bold** and `code`' });
    const strong = container.querySelector('.terminal-message-user strong');
    expect(strong?.textContent).toBe('bold');
    const code = container.querySelector('.terminal-message-user code');
    expect(code?.textContent).toBe('code');
    expect(container.textContent).not.toContain('**');
  });

  it('preserves single newlines as hard breaks', () => {
    const { container } = renderMessage({ role: 'user', text: 'line1\nline2' });
    expect(container.querySelector('.terminal-message-user br')).toBeTruthy();
    expect(container.textContent).toContain('line1');
    expect(container.textContent).toContain('line2');
  });

  it('renders fenced code blocks without mangling their content', () => {
    const { container } = renderMessage({ role: 'user', text: '```\nconst x = 1;\n```' });
    const pre = container.querySelector('.terminal-message-user pre');
    expect(pre?.textContent).toContain('const x = 1;');
  });
});

describe('MessageBlock — expanded activity scroll', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['card', 'terminal', 'plain'] as const)('preserves reading position and resumes following at the bottom (%s)', (variant) => {
    let height = 1000;
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => height);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
    const view = (text: string, streaming = true) => <AgentBlockStyleOverride.Provider value={variant}>
      <TermThoughtBlock text={text} streaming={streaming} initialMode="expanded" />
    </AgentBlockStyleOverride.Provider>;
    const { getByRole, rerender } = render(view('First step'));
    const activity = getByRole('region', { name: 'Activity details' });
    expect(activity.tabIndex).toBe(0);
    expect(activity.style.overflowY).toBe('auto');
    expect(activity.scrollTop).toBe(1000);

    activity.scrollTop = 120;
    fireEvent.scroll(activity);
    height = 1200;
    rerender(view('First step\nNext step'));
    expect(activity.scrollTop).toBe(120);

    activity.scrollTop = 900;
    fireEvent.scroll(activity);
    height = 1400;
    rerender(view('First step\nNext step\nLatest step'));
    expect(activity.scrollTop).toBe(1400);

    activity.scrollTop = 160;
    fireEvent.scroll(activity);
    rerender(view('First step\nNext step\nLatest step', false));
    expect(activity.scrollTop).toBe(160);
    expect(getByRole('region', { name: 'Activity details' })).toBe(activity);
  });

  it('opens completed activity from the start without an extra tab stop for short content', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(80);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(80);
    const { getByText, queryByRole } = render(<TermThoughtBlock text="Earlier reasoning" />);
    fireEvent.click(getByText('thoughts'));
    const body = getByText('Earlier reasoning').closest('div[style*="overflow-y"]') as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.scrollTop).toBe(0);
    expect(body.hasAttribute('tabindex')).toBe(false);
    expect(queryByRole('region')).toBeNull();
  });

  it('opens and reopens a live activity at its latest content', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
    const { getByText, getByRole } = render(<TermThoughtBlock text="Live reasoning" streaming />);
    fireEvent.click(getByText('thinking'));
    const activity = getByRole('region', { name: 'Activity details' });
    expect(activity.scrollTop).toBe(1000);
    activity.scrollTop = 100;
    fireEvent.scroll(activity);
    fireEvent.click(getByText('thinking'));
    fireEvent.click(getByText('thinking'));
    expect(getByRole('region', { name: 'Activity details' }).scrollTop).toBe(1000);
  });
});

describe('MessageBlock — thought activity sync', () => {
  function renderCardMessage(m: ChatMessage) {
    return render(
      <AgentBlockStyleOverride.Provider value="card">
        <MessageBlock
          m={m}
          index={0}
          isDark={false}
          onCopy={noop}
          showThoughts
          fontFamily="inherit"
          density="comfortable"
        />
      </AgentBlockStyleOverride.Provider>,
    );
  }

  it('keeps the latest thought block working during a between-steps gap', () => {
    const m: ChatMessage = {
      ...baseMsg,
      role: 'assistant',
      text: '',
      streaming: true,
      toolCalls: [{
        id: 't1',
        title: 'bash',
        status: 'completed',
        startedAt: 100,
        endedAt: 500,
      }],
      blocks: [
        { id: 'b1', kind: 'thinking', rawText: 'Assessing options', streaming: false },
        { id: 'b2', kind: 'tool', toolCallId: 't1', section: 'thinking', rawOffset: 17 },
      ],
    };

    const { getByText, queryByText } = renderCardMessage(m);

    expect(getByText('Working…')).not.toBeNull();
    expect(queryByText(/Thought for/)).toBeNull();
  });

  it('leaves the thought block completed once a visible answer starts streaming', () => {
    const m: ChatMessage = {
      ...baseMsg,
      role: 'assistant',
      text: 'Here is the answer',
      streaming: true,
      toolCalls: [{
        id: 't1',
        title: 'bash',
        status: 'in_progress',
        startedAt: 100,
      }],
      blocks: [
        { id: 'b1', kind: 'thinking', rawText: 'Assessing options', streaming: false },
        { id: 'b2', kind: 'tool', toolCallId: 't1', section: 'thinking', rawOffset: 17 },
        { id: 'b3', kind: 'answer', rawText: 'Here is the answer', streaming: true },
      ],
    };

    const { getByText, queryByText } = renderCardMessage(m);

    expect(getByText('Ran 1 command')).not.toBeNull();
    expect(queryByText('Working…')).toBeNull();
  });

  it('heads a finished block with what it did, the duration at the right and failures apart', () => {
    const m: ChatMessage = {
      ...baseMsg,
      role: 'assistant',
      text: 'Done',
      streaming: false,
      toolCalls: [
        { id: 't1', title: 'Read a.ts', kind: 'read', status: 'completed', startedAt: 1_000, endedAt: 2_000 },
        { id: 't2', title: 'Edit a.ts', kind: 'edit', status: 'completed', startedAt: 2_000, endedAt: 3_000 },
        { id: 't3', title: 'Bash npm test', kind: 'bash', status: 'error', startedAt: 3_000, endedAt: 13_000 },
      ],
      blocks: [
        { id: 'b1', kind: 'thinking', rawText: 'Fixing', streaming: false },
        { id: 'b2', kind: 'tool', toolCallId: 't1', section: 'thinking', rawOffset: 6 },
        { id: 'b3', kind: 'tool', toolCallId: 't2', section: 'thinking', rawOffset: 6 },
        { id: 'b4', kind: 'tool', toolCallId: 't3', section: 'thinking', rawOffset: 6 },
        { id: 'b5', kind: 'answer', rawText: 'Done', streaming: false },
      ],
    };

    const { getByText, queryByText } = renderCardMessage(m);

    const summary = getByText('Edited 1 file, ran 1 command, read 1 file');
    expect(summary.getAttribute('title')).toBe('Edited 1 file, ran 1 command, read 1 file');
    expect(getByText('· 1 failed')).not.toBeNull();
    const duration = getByText('12s');
    expect(summary.compareDocumentPosition(duration) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(queryByText(/Worked/)).toBeNull();
    expect(queryByText(/tool calls/)).toBeNull();
  });

  it('moves tools that close a prose run into the thought block that follows', () => {
    const m: ChatMessage = {
      ...baseMsg,
      role: 'assistant',
      text: 'Checking first:',
      streaming: false,
      toolCalls: [
        { id: 't1', title: 'Bash npm test', kind: 'bash', status: 'completed' },
        { id: 't2', title: 'Read a.ts', kind: 'read', status: 'completed' },
        { id: 't3', title: 'Edit a.ts', kind: 'edit', status: 'completed' },
      ],
      blocks: [
        { id: 'b1', kind: 'answer', rawText: 'Checking first:', streaming: false },
        { id: 'b2', kind: 'tool', toolCallId: 't1', section: 'answer', rawOffset: 15 },
        { id: 'b3', kind: 'tool', toolCallId: 't2', section: 'answer', rawOffset: 15 },
        { id: 'b4', kind: 'thinking', rawText: 'Deciding', streaming: false },
        { id: 'b5', kind: 'tool', toolCallId: 't3', section: 'thinking', rawOffset: 8 },
      ],
    };

    const { getByText, queryByText } = renderCardMessage(m);

    expect(getByText('Checking first:')).not.toBeNull();
    expect(getByText('Edited 1 file, ran 1 command, read 1 file')).not.toBeNull();
    expect(queryByText('ran 1 command, read 1 file')).toBeNull();
  });

  it('moves tools that open a prose run into the thought block before it', () => {
    const m: ChatMessage = {
      ...baseMsg,
      role: 'assistant',
      text: 'Done',
      streaming: false,
      toolCalls: [
        { id: 't1', title: 'Read a.ts', kind: 'read', status: 'completed' },
        { id: 't2', title: 'Bash npm test', kind: 'bash', status: 'completed' },
      ],
      blocks: [
        { id: 'b1', kind: 'thinking', rawText: 'Deciding', streaming: false },
        { id: 'b2', kind: 'tool', toolCallId: 't1', section: 'thinking', rawOffset: 8 },
        { id: 'b3', kind: 'tool', toolCallId: 't2', section: 'answer', rawOffset: 0 },
        { id: 'b4', kind: 'answer', rawText: 'Done', streaming: false },
      ],
    };

    const { getByText, queryByText } = renderCardMessage(m);

    expect(getByText('Done')).not.toBeNull();
    expect(getByText('Ran 1 command, read 1 file')).not.toBeNull();
    expect(queryByText('Bash npm test')).toBeNull();
  });

  it('leaves hidden metadata tools with the prose run', () => {
    const m: ChatMessage = {
      ...baseMsg,
      role: 'assistant',
      text: 'Done',
      streaming: false,
      toolCalls: [{ id: 't1', title: 'set_branch_overview', status: 'completed' }],
      blocks: [
        { id: 'b1', kind: 'thinking', rawText: 'Wrapping up', streaming: false },
        { id: 'b2', kind: 'tool', toolCallId: 't1', section: 'answer', rawOffset: 0 },
        { id: 'b3', kind: 'answer', rawText: 'Done', streaming: false },
      ],
    };

    const { getByText, queryByText } = renderCardMessage(m);

    expect(getByText(/^Thoughts$/)).not.toBeNull();
    expect(queryByText(/Worked/)).toBeNull();
  });

  it('keeps Thought for when a duration is known but there were no tools', () => {
    const { getByText, queryByText } = render(
      <AgentBlockStyleOverride.Provider value="card">
        <TermThoughtBlock text="Just reasoning" durationMs={7_000} />
      </AgentBlockStyleOverride.Provider>,
    );
    expect(getByText('Thought for 7.0s')).not.toBeNull();
    expect(queryByText(/Worked/)).toBeNull();
  });

  it('labels a completed thought-only block as Thoughts when duration is unknown', () => {
    const m: ChatMessage = {
      ...baseMsg,
      role: 'assistant',
      text: '',
      streaming: false,
      blocks: [
        { id: 'b1', kind: 'thinking', rawText: 'Just reasoning', streaming: false },
      ],
    };

    const { getByText, queryByText } = renderCardMessage(m);

    expect(getByText(/^Thoughts$/)).not.toBeNull();
    expect(queryByText(/Worked/)).toBeNull();
  });
});


it('renders durable answered and skipped cards without pending node state', () => {
  const { getByText } = renderMessage({ role: 'assistant', text: '', blocks: [
    { id: 'first', kind: 'user-input', requestId: 1, section: 'answer', rawOffset: 0,
      interaction: { interactionId: 't:1', requestId: 1, status: 'answered', questions: [{ id: 'q1', question: 'Color?', options: [], multiSelect: false }], answers: [{ id: 'q1', question: 'Color?', answer: 'Blue' }] } },
    { id: 'second', kind: 'user-input', requestId: 2, section: 'answer', rawOffset: 0,
      interaction: { interactionId: 't:2', requestId: 2, status: 'skipped', questions: [{ id: 'q2', question: 'Continue?', options: [], multiSelect: false }], answers: [] } },
  ] });
  expect(getByText('Color?')).not.toBeNull();
  expect(getByText('Blue')).not.toBeNull();
  expect(getByText('Continue?')).not.toBeNull();
  expect(getByText('(skipped)')).not.toBeNull();
});

it('labels estimated USD costs with their unit and provenance', () => {
  const { getByTestId } = renderMessage({ role: 'assistant', text: 'done' }, { usageInfo: { charge: { amount: 0.0123, unit: 'USD', provenance: 'sdk_estimate' } } });
  expect(getByTestId('turn-usage').textContent).toBe('usage estimated 0.0123 USD');
  expect(getByTestId('turn-usage').title).toContain('sdk estimate');
});

describe('MessageBlock — durable agent timer', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetBackendClocksForTest();
  });

  function renderCard(m: ChatMessage) {
    return render(
      <AgentBlockStyleOverride.Provider value="card">
        <MessageBlock m={m} index={0} isDark={false} onCopy={noop} showThoughts fontFamily="inherit" density="comfortable" />
      </AgentBlockStyleOverride.Provider>,
    );
  }

  // Backend-clock times; the cluster started at 50s, its tool ran 60s-99s.
  function workingMessage(id: string, extraBlocks: AssistantBlock[] = []): ChatMessage {
    return {
      ...baseMsg,
      id,
      role: 'assistant',
      text: '',
      streaming: true,
      toolCalls: [{ id: 't1', title: 'bash', status: 'completed', startedAt: 60_000, endedAt: 99_000 }],
      blocks: [
        { id: `${id}-b-0`, kind: 'thinking', rawText: 'Checking disks', streaming: false, startedAt: 50_000, endedAt: 60_000 },
        { id: `${id}-b-1`, kind: 'tool', toolCallId: 't1', section: 'thinking', rawOffset: 14 },
        ...extraBlocks,
      ],
    };
  }

  it('resumes the Working… count from the durable start after a remount', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const m = workingMessage('a-live');

    const first = renderCard(m);
    expect(first.getByText('Working…')).not.toBeNull();
    expect(first.getByText('50s')).not.toBeNull();
    first.unmount();

    vi.setSystemTime(106_000);
    const second = renderCard(m);
    expect(second.getByText('56s')).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(second.getByText('57s')).not.toBeNull();
  });

  it('counts on the backend clock once its offset is confirmed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(160_000);
    // The renderer runs 60s ahead of the backend that stamped the blocks.
    recordBackendObservation('a-remote', 99_000, 159_000);
    recordBackendObservation('a-remote', 100_000, 160_000);

    const { getByText, queryByText } = renderCard(workingMessage('a-remote'));
    expect(getByText('50s')).not.toBeNull();
    expect(queryByText('110s')).toBeNull();
  });

  it('labels a finished cluster with its durable window, ending when the answer opened', () => {
    vi.useFakeTimers();
    vi.setSystemTime(200_000);
    const m = workingMessage('a-done', [
      { id: 'a-done-b-2', kind: 'answer', rawText: 'Here is the answer', streaming: true, startedAt: 104_000 },
    ]);

    const { getByText, queryByText } = renderCard(m);
    expect(getByText('Ran 1 command')).not.toBeNull();
    expect(getByText('54s')).not.toBeNull();
    expect(queryByText('Working…')).toBeNull();
  });
});

describe('MessageBlock — thought block motion', () => {
  afterEach(() => vi.restoreAllMocks());

  const card = (node: React.ReactNode) => <AgentBlockStyleOverride.Provider value="card">{node}</AgentBlockStyleOverride.Provider>;
  const block = (container: HTMLElement) => container.querySelector('[data-agent-block]') as HTMLElement;

  it('finishes in place: the live label leaves unannounced while the summary arrives and the body closes', async () => {
    const view = (streaming: boolean) => card(<TermThoughtBlock text="Weighing the options" streaming={streaming} />);
    const { getByText, queryByText, rerender } = render(view(true));
    expect(getByText('Weighing the options')).not.toBeNull();

    rerender(view(false));
    expect(getByText(/^Thought for /)).not.toBeNull();
    expect(getByText('Thinking…').closest('[aria-hidden="true"]')).not.toBeNull();
    await waitFor(() => expect(queryByText('Thinking…')).toBeNull());
    await waitFor(() => expect(queryByText('Weighing the options')).toBeNull());
  });

  it('turns one chevron and opens/closes the body, reversing when clicked mid-way', async () => {
    const { container, getByText, queryByText } = render(card(<TermThoughtBlock text="Earlier reasoning" durationMs={2_000} />));
    expect(queryByText('Earlier reasoning')).toBeNull();
    const chevron = () => Array.from(container.querySelectorAll('span')).find((s) => s.textContent === '▸')!;
    expect(container.textContent).not.toContain('▾');

    fireEvent.click(getByText('Thought for 2.0s'));
    expect(getByText('Earlier reasoning')).not.toBeNull();
    await waitFor(() => expect(chevron().style.transform).toContain('rotate(90deg)'));

    // Close, then reopen before the close finishes: the same body comes back.
    fireEvent.click(getByText('Thought for 2.0s'));
    fireEvent.click(getByText('Thought for 2.0s'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getByText('Earlier reasoning')).not.toBeNull();

    fireEvent.click(getByText('Thought for 2.0s'));
    await waitFor(() => expect(queryByText('Earlier reasoning')).toBeNull());
    await waitFor(() => expect(chevron().style.transform).not.toContain('90deg'));
  });

  it('grows a block that arrives while its message is on screen from the dots it replaces', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(28);
    const pending: ChatMessage = { ...baseMsg, id: 'a1', role: 'assistant', text: '', streaming: true, blocks: [] };
    const view = (m: ChatMessage) => card(
      <MessageBlock m={m} index={0} isDark={false} onCopy={noop} showThoughts fontFamily="inherit" density="comfortable" />,
    );
    const { container, getByRole, queryByRole, rerender } = render(view(pending));
    expect(getByRole('status', { name: 'loading' })).not.toBeNull();

    // Every inline style the arriving block goes through.
    const styles: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if ((record.target as HTMLElement).matches?.('[data-agent-block]')) styles.push(record.oldValue ?? '');
      }
    });
    observer.observe(container, { subtree: true, attributes: true, attributeFilter: ['style'], attributeOldValue: true });
    rerender(view({ ...pending, blocks: [{ id: 'a1-b-0', kind: 'thinking', rawText: 'First thought', streaming: true }] }));
    // The leaving dots stop being a status at once.
    expect(queryByRole('status', { name: 'loading' })).toBeNull();
    // It starts clipped at the dots' height, then releases its height entirely.
    await waitFor(() => expect(styles.some((style) => /height: 28px/.test(style) && /overflow: hidden/.test(style))).toBe(true));
    await waitFor(() => expect(block(container).style.height).toBe(''));
    expect(block(container).style.overflow).toBe('');
    observer.disconnect();
    await waitFor(() => expect(container.querySelector('.typing-dot')).toBeNull());
  });

  it('keeps the tail pinned while its content resizes after the render (a tool row growing in)', () => {
    const observers: Array<{ callback: ResizeObserverCallback; targets: Element[] }> = [];
    vi.stubGlobal('ResizeObserver', class {
      private entry: { callback: ResizeObserverCallback; targets: Element[] };
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: [] };
        observers.push(this.entry);
      }
      observe(target: Element) { this.entry.targets.push(target); }
      unobserve() {}
      disconnect() { this.entry.targets = []; }
    });
    let height = 300;
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => height);
    const { getByText } = render(card(<TermThoughtBlock text="Running the tests" streaming />));
    const tail = getByText('Running the tests').closest('div[style*="max-height"]') as HTMLElement;
    expect(tail.scrollTop).toBe(300);

    // No re-render: the content only grows (a row animating in).
    height = 360;
    const watcher = observers.find((o) => o.targets.some((t) => tail.contains(t) && t !== tail))!;
    act(() => watcher.callback([], {} as ResizeObserver));
    expect(tail.scrollTop).toBe(360);
    vi.unstubAllGlobals();
  });

  it('leaves a body present at mount unclipped, and takes a leaving body out of reach', async () => {
    const view = (streaming: boolean) => card(<TermThoughtBlock text="Live reasoning" streaming={streaming} />);
    const { getByText, queryByText, rerender } = render(view(true));
    const reveal = () => getByText('Live reasoning').closest('div[style*="max-height"]')!.parentElement as HTMLElement;
    // Present with its block: settled, so nothing clips its focus ring.
    expect(reveal().style.overflow).toBe('visible');

    rerender(view(false));
    expect(reveal().getAttribute('aria-hidden')).toBe('true');
    expect(reveal().hasAttribute('inert')).toBe(true);
    await waitFor(() => expect(queryByText('Live reasoning')).toBeNull());
  });

  it('renders blocks that were there when the message mounted settled', () => {
    const m: ChatMessage = {
      ...baseMsg, id: 'a1', role: 'assistant', text: '', streaming: true,
      blocks: [{ id: 'a1-b-0', kind: 'thinking', rawText: 'Resumed thought', streaming: true }],
    };
    const { container } = render(card(
      <MessageBlock m={m} index={0} isDark={false} onCopy={noop} showThoughts fontFamily="inherit" density="comfortable" />,
    ));
    expect(block(container).style.height).toBe('');
    expect(block(container).style.opacity).toBe('');
  });
});
