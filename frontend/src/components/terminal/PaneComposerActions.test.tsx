import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PaneComposerActions } from './PaneComposerActions';

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
      name: 'Send next (Enter) — sends after the current response',
    });
    expect(button.textContent).toContain('Send next');
    fireEvent.click(button);
    expect(onSend).toHaveBeenCalledOnce();
  });

  it('keeps an explicit Branch action separate from Send next', () => {
    renderActions({ draftHasText: true, streaming: true });
    expect(screen.getByRole('button', { name: /^Branch/ })).toBeTruthy();
  });
});
