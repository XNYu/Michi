import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { FollowUpRow } from './FollowUpRow';

describe('FollowUpRow', () => {
  it('renders the index and the question text', () => {
    render(
      <FollowUpRow
        index={0}
        question="Central Flow 运营人员的日常工作流程是什么样的"
        onContinue={vi.fn()}
        onBranch={vi.fn()}
      />,
    );
    expect(screen.getByText('1.')).toBeTruthy();
    expect(
      screen.getByText('Central Flow 运营人员的日常工作流程是什么样的'),
    ).toBeTruthy();
  });

  it('clicking the text button calls onContinue, not onBranch', () => {
    const onContinue = vi.fn();
    const onBranch = vi.fn();
    render(
      <FollowUpRow
        index={0}
        question="hello"
        onContinue={onContinue}
        onBranch={onBranch}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Continue follow-up 1/i }));
    expect(onContinue).toHaveBeenCalledWith('hello');
    expect(onBranch).not.toHaveBeenCalled();
  });

  it('clicking the branch button calls onBranch, not onContinue', () => {
    const onContinue = vi.fn();
    const onBranch = vi.fn();
    render(
      <FollowUpRow
        index={1}
        question="hello"
        onContinue={onContinue}
        onBranch={onBranch}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Branch follow-up 2/i }));
    expect(onBranch).toHaveBeenCalledWith('hello');
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('pressing B while text button is focused calls onBranch', () => {
    const onContinue = vi.fn();
    const onBranch = vi.fn();
    render(
      <FollowUpRow
        index={0}
        question="hello"
        onContinue={onContinue}
        onBranch={onBranch}
      />,
    );
    const textBtn = screen.getByRole('button', { name: /Continue follow-up 1/i });
    fireEvent.keyDown(textBtn, { key: 'b' });
    expect(onBranch).toHaveBeenCalledWith('hello');
    expect(onContinue).not.toHaveBeenCalled();
  });

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
    const textBtn = screen.getByRole('button', { name: /Continue follow-up 1/i });
    fireEvent.keyDown(textBtn, { key: 'B' });
    expect(onBranch).toHaveBeenCalledWith('hello');
  });

  it('Enter on the text button calls onContinue (native button behavior)', () => {
    const onContinue = vi.fn();
    render(
      <FollowUpRow
        index={0}
        question="hello"
        onContinue={onContinue}
        onBranch={vi.fn()}
      />,
    );
    const textBtn = screen.getByRole('button', { name: /Continue follow-up 1/i });
    fireEvent.click(textBtn);
    expect(onContinue).toHaveBeenCalledWith('hello');
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
    fireEvent.click(screen.getByRole('button', { name: /Continue follow-up 1/i }));
    fireEvent.click(screen.getByRole('button', { name: /Branch follow-up 1/i }));
    expect(onContinue).not.toHaveBeenCalled();
    expect(onBranch).not.toHaveBeenCalled();
  });
});
