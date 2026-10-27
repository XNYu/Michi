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
  it('omits Branch in surfaces that cannot create branches', () => {
    renderActions({ draftHasText: true, allowBranch: false });
    expect(screen.queryByRole('button', { name: /^Branch \(/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Send (Enter)' })).toBeTruthy();
  });
  it('labels uncertain recovery as a check and prevents duplicate checks', () => {
    const props = renderActions({ sendMode: 'retry', inspectOriginal: true, checkingOriginal: true });
    const button = screen.getByRole('button', { name: 'Check original turn' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Checking');
    fireEvent.click(button);
    expect(props.onRetry).not.toHaveBeenCalled();
  });

  it('says what else Stop ends, in its label and tooltip', () => {
    const { onStop } = renderActions({ sendMode: 'stop', streaming: true, stopHint: 'Also stops the running workflow.' });
    const button = screen.getByRole('button', { name: 'Stop stream. Also stops the running workflow.' });
    expect(button.getAttribute('title')).toBe('Also stops the running workflow.');
    fireEvent.click(button);
    expect(onStop).toHaveBeenCalledOnce();
  });

  it('keeps the plain Stop label without a hint', () => {
    renderActions({ sendMode: 'stop', streaming: true });
    const button = screen.getByRole('button', { name: 'Stop stream' });
    expect(button.getAttribute('title')).toBeNull();
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
