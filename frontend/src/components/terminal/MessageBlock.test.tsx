// Locks the role-differentiation styling contract for MessageBlock.
// User: right-aligned paper-card bubble with no role/time label; surface +
//   drop shadow + 72% max-width live in index.css (.terminal-message-user),
//   not inline. The time shows only in the hover action row.
// Assistant: flush-left, no border, no fill, "> michi" label above.
// Asserts on inline style strings because jsdom doesn't resolve var()/color-mix()/calc().
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, render, fireEvent } from '@testing-library/react';
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
