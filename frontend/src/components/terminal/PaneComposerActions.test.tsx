import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PaneComposerActions } from './PaneComposerActions';
import { FollowUpRow } from '../FollowUpRow';

function renderActions(
  overrides: Partial<React.ComponentProps<typeof PaneComposerActions>> = {},
) {
  const props: React.ComponentProps<typeof PaneComposerActions> = {
    draftHasText: false,
    sendMode: 'send',
    streaming: false,
    sendDisabled: false,
    onBranch: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
  render(<PaneComposerActions {...props} />);
  return props;
}

describe('PaneComposerActions', () => {
  it('labels an idle submit as Send', () => {
    renderActions();
    expect(screen.getByRole('button', { name: 'Send (Enter)' })).toBeTruthy();
  });

  it('labels a streaming submit as Send next and explains its FIFO behavior', () => {
    const { onSend } = renderActions({ streaming: true });
    const button = screen.getByRole('button', {
      name: 'Send next (Enter). Sends after the current response',
    });
    expect(button.textContent).toContain('Send next');
    fireEvent.click(button);
    expect(onSend).toHaveBeenCalledOnce();
  });

  it('keeps an explicit Branch action separate from Send next', () => {
    const { onBranch, onSend } = renderActions({ draftHasText: true, streaming: true });
    fireEvent.click(screen.getByRole('button', { name: /^Branch/ }));
    expect(onBranch).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('shares the right-facing split icon with follow-up branches', () => {
    renderActions({ draftHasText: true });
    render(
      <FollowUpRow index={0} question="Another approach?" onContinue={vi.fn()} onBranch={vi.fn()} />,
    );

    const composerIcon = screen.getByRole('button', { name: /^Branch \(/ }).querySelector('svg')!;
    const followUpIcon = screen.getByRole('button', { name: /^Branch follow-up/ }).querySelector('svg')!;
    for (const icon of [composerIcon, followUpIcon]) {
      expect(icon.classList.contains('lucide-split')).toBe(true);
      expect(icon.classList.contains('rotate-90')).toBe(true);
      expect(icon.getAttribute('aria-hidden')).toBe('true');
    }
    expect(composerIcon.innerHTML).toBe(followUpIcon.innerHTML);
    expect(composerIcon.getAttribute('width')).toBe('16');
  });
});
