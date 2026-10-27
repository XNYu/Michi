import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { FollowUpRow } from './FollowUpRow';

describe('FollowUpRow', () => {
  it('pressing Shift+B also branches (case-insensitive)', () => {
    const onBranch = vi.fn();
    render(
      <FollowUpRow
        index={0}
        question="hello"
        onContinue={vi.fn()}
        onBranch={onBranch}
      />,
    );
    const textBtn = screen.getByRole('button', { name: /Continue follow-up/i });
    fireEvent.keyDown(textBtn, { key: 'B' });
    expect(onBranch).toHaveBeenCalledWith('hello');
  });

  it('does not trigger actions while disabled', () => {
    const onContinue = vi.fn();
    const onBranch = vi.fn();
    render(
      <FollowUpRow
        index={0}
        question="hello"
        disabled
        onContinue={onContinue}
        onBranch={onBranch}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Continue follow-up/i }));
    fireEvent.click(screen.getByRole('button', { name: /Branch follow-up/i }));
    fireEvent.keyDown(screen.getByRole('button', { name: /Continue follow-up/i }), { key: 'b' });
    expect(onContinue).not.toHaveBeenCalled();
    expect(onBranch).not.toHaveBeenCalled();
  });
});
