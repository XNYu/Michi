import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PaneComposerActions, composerGlyph } from './PaneComposerActions';
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

  it('labels the retry action Resume after a restart cut the turn short', () => {
    const props = renderActions({ sendMode: 'retry', resumeTurn: true });
    const button = screen.getByRole('button', { name: 'Resume the interrupted turn' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain('Resume');
    fireEvent.click(button);
    expect(props.onRetry).toHaveBeenCalledOnce();
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

  it('names one glyph per send state, so only a change of state swaps it', () => {
    expect(composerGlyph('send', false, false)).toBe('send');
    expect(composerGlyph('send', true, false)).toBe('send-next');
    expect(composerGlyph('stop', true, false)).toBe('stop');
    expect(composerGlyph('retry', false, false)).toBe('retry');
    expect(composerGlyph('retry', false, true)).toBe('resume');
  });

  it('cross-fades the glyph on Send → Stop inside the same button, and not on mount', async () => {
    const base: React.ComponentProps<typeof PaneComposerActions> = {
      draftHasText: true, sendMode: 'send', streaming: false, sendDisabled: false,
      onBranch: vi.fn(), onSend: vi.fn(), onStop: vi.fn(), onRetry: vi.fn(),
    };
    const glyphs = (button: HTMLElement) => Array.from(button.querySelectorAll<HTMLElement>('[data-glyph]'));
    const { rerender } = render(<PaneComposerActions {...base} />);
    const button = screen.getByRole('button', { name: 'Send (Enter)' });
    // Mounting shows the glyph as it is: no entrance from half size.
    expect(glyphs(button).map((g) => g.dataset.glyph)).toEqual(['send']);
    expect(glyphs(button)[0].style.opacity).not.toBe('0');

    rerender(<PaneComposerActions {...base} draftHasText={false} sendMode="stop" streaming />);
    const stop = screen.getByRole('button', { name: 'Stop stream' });
    expect(stop).toBe(button);
    expect(glyphs(stop).map((g) => g.dataset.glyph)).toContain('stop');
    await waitFor(() => expect(glyphs(stop).map((g) => g.dataset.glyph)).toEqual(['stop']));
    for (const glyph of glyphs(stop)) expect(glyph.getAttribute('aria-hidden')).toBe('true');

    // Typing during the reply turns Stop into Send next (dashed shaft).
    rerender(<PaneComposerActions {...base} sendMode="send" streaming />);
    await waitFor(() => expect(glyphs(button).map((g) => g.dataset.glyph)).toEqual(['send-next']));
    expect(button.querySelector('path[stroke-dasharray]')).toBeTruthy();
  });
});
