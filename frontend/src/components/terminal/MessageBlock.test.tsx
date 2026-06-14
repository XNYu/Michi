// Locks the role-differentiation styling contract for MessageBlock.
// User: right-aligned paper-card bubble with an inline overline label
//   ("you · HH:MM") inside the card; surface + drop shadow + 72% max-width
//   live in index.css (.terminal-message-user), not inline.
// Assistant: flush-left, no border, no fill, "> michi" label above.
// Asserts on inline style strings because jsdom doesn't resolve var()/color-mix()/calc().
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import { MessageBlock, userTextToMarkdown } from './MessageBlock';
import type { ChatMessage } from '../../state/chatTypes';

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
  extraProps?: { isErrorTail?: boolean; onRetry?: () => void; errorMessage?: string },
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
      usageInfo={undefined}
      isErrorTail={extraProps?.isErrorTail}
      errorMessage={extraProps?.errorMessage}
    />,
  );
}

describe('MessageBlock — role styling', () => {
  it('user message labels itself with an inline "you" overline (no outer label)', () => {
    const { container } = renderMessage({ role: 'user', text: 'q?' });
    const block = container.querySelector('.terminal-message-user') as HTMLElement;
    expect(block).not.toBeNull();
    const overline = block.querySelector('.bubble-overline') as HTMLElement;
    expect(overline).not.toBeNull();
    expect(overline.textContent).toMatch(/you/);
    // The outer "$ you" sibling that the baseline bubble used is gone.
    const outerSibling = block.parentElement?.previousElementSibling as HTMLElement | null;
    expect(outerSibling?.textContent ?? '').not.toMatch(/^\$ you/);
  });
});

describe('MessageBlock — error-tail row', () => {
  it('renders failed label and retry button when isErrorTail is true on assistant message', () => {
    const { getByText, getByTestId } = renderMessage(
      { role: 'assistant', text: 'something went wrong' },
      { isErrorTail: true, onRetry: noop },
    );
    expect(getByText('failed')).not.toBeNull();
    expect(getByTestId('error-tail-retry')).not.toBeNull();
  });

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

  it('does not render the failed label when isErrorTail is false', () => {
    const { queryByText, queryByTestId } = renderMessage(
      { role: 'assistant', text: 'ok response' },
      { isErrorTail: false, onRetry: noop },
    );
    expect(queryByText('failed')).toBeNull();
    expect(queryByTestId('error-tail-retry')).toBeNull();
  });

  it('does not render the failed label when isErrorTail is not provided', () => {
    const { queryByText, queryByTestId } = renderMessage({ role: 'assistant', text: 'ok response' });
    expect(queryByText('failed')).toBeNull();
    expect(queryByTestId('error-tail-retry')).toBeNull();
  });

  it('does not render the failed label on user messages even when isErrorTail is true', () => {
    const { queryByText, queryByTestId } = renderMessage(
      { role: 'user', text: 'user message' },
      { isErrorTail: true, onRetry: noop },
    );
    expect(queryByText('failed')).toBeNull();
    expect(queryByTestId('error-tail-retry')).toBeNull();
  });

  it('does not render the failed label when message is still streaming', () => {
    const { queryByText, queryByTestId } = renderMessage(
      { role: 'assistant', text: 'partial...', streaming: true },
      { isErrorTail: true, onRetry: noop },
    );
    expect(queryByText('failed')).toBeNull();
    expect(queryByTestId('error-tail-retry')).toBeNull();
  });
});

describe('MessageBlock — user modules', () => {
  it('renders QuoteChip when m.quotedText is set', () => {
    const { container } = renderMessage({
      role: 'user',
      text: 'why?',
      quotedText: 'because foo bar baz',
    });
    expect(container.textContent).toContain('because foo bar baz');
    // Chip body has its own paragraph with the data-testid.
    expect(container.querySelector('[data-testid="quote-preview"]')).not.toBeNull();
  });

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

  it('legacy user message (no structured fields) renders body via existing path', () => {
    const { container } = renderMessage({
      role: 'user',
      text: '> quoted line\n\nmy follow-up',
    });
    expect(container.querySelector('[data-testid="quote-preview"]')).toBeNull();
    expect(container.querySelector('[data-testid="attachment-pill"]')).toBeNull();
    // Inline `> ` quotes now render as a real blockquote (user markdown).
    expect(container.querySelector('.terminal-message-user blockquote')?.textContent).toContain(
      'quoted line',
    );
    expect(container.textContent).toContain('my follow-up');
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
  it('renders the SubAgent spine row and Now: line when matching subagents are passed', () => {
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
    expect(container.textContent).toContain('Now: Glob');
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

describe('userTextToMarkdown', () => {
  it('suffixes plain lines with a markdown hard break', () => {
    expect(userTextToMarkdown('a\nb')).toBe('a  \nb');
  });
  it('leaves blank lines and the last line untouched', () => {
    expect(userTextToMarkdown('a\n\nb')).toBe('a\n\nb');
  });
  it('never touches lines inside a code fence', () => {
    expect(userTextToMarkdown('```\ncode line\n```\nafter\nend')).toBe(
      '```\ncode line\n```\nafter  \nend',
    );
  });
});
