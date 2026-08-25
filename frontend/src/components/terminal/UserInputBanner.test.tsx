import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import UserInputBanner, { ResolvedUserInput } from './UserInputBanner';
import type { UserInputRequest } from '../../state/chatTypes';

function req(overrides: Partial<UserInputRequest> = {}): UserInputRequest {
  return {
    requestId: 1,
    questions: [
      {
        question: 'Which auth approach?',
        header: 'AUTH',
        options: [{ label: 'Cookies' }, { label: 'JWT' }],
        multiSelect: false,
      },
    ],
    answers: [],
    ...overrides,
  };
}

function multiReq(): UserInputRequest {
  return req({
    questions: [
      { question: 'Q1?', options: [{ label: 'A1' }, { label: 'B1' }], multiSelect: false },
      { question: 'Q2?', options: [{ label: 'A2' }, { label: 'B2' }], multiSelect: false },
    ],
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('UserInputBanner', () => {
  it('submits the selected option', () => {
    const onSubmit = vi.fn();
    render(<UserInputBanner userInput={req()} onSubmit={onSubmit} onSkip={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: /Cookies/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onSubmit).toHaveBeenCalledWith([
      { question: 'Which auth approach?', answer: 'Cookies' },
    ]);
  });

  it('joins multiSelect selections and Other text', () => {
    const onSubmit = vi.fn();
    const r = req({
      questions: [
        {
          question: 'Pick some',
          options: [{ label: 'One' }, { label: 'Two' }],
          multiSelect: true,
        },
      ],
    });
    render(<UserInputBanner userInput={r} onSubmit={onSubmit} onSkip={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /One/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Two/ }));
    fireEvent.change(screen.getByPlaceholderText(/Other/), { target: { value: 'custom' } });
    fireEvent.click(screen.getByRole('button', { name: /Submit/ }));
    const answer = onSubmit.mock.calls[0][0][0].answer as string;
    expect(answer.split(', ').sort()).toEqual(['One', 'Two', 'custom'].sort());
  });

  it('auto-advances to the next question 320ms after a single-select pick', () => {
    vi.useFakeTimers();
    render(<UserInputBanner userInput={multiReq()} onSubmit={() => {}} onSkip={() => {}} />);
    expect(screen.getByText('1 / 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /A1/ }));
    expect(screen.getByText('1 / 2')).toBeTruthy(); // not yet
    act(() => { vi.advanceTimersByTime(320); });
    expect(screen.getByText('2 / 2')).toBeTruthy();
  });

  it('navigates back and forth with the arrow buttons', () => {
    render(<UserInputBanner userInput={multiReq()} onSubmit={() => {}} onSkip={() => {}} />);
    const prev = screen.getByRole('button', { name: 'Previous question' });
    const next = screen.getByRole('button', { name: 'Next question' });
    expect((prev as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(next);
    expect(screen.getByText('2 / 2')).toBeTruthy();
    expect((next as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(prev);
    expect(screen.getByText('1 / 2')).toBeTruthy();
  });

  it('calls onSkip from the skip button', () => {
    const onSkip = vi.fn();
    render(<UserInputBanner userInput={req()} onSubmit={() => {}} onSkip={onSkip} />);
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(onSkip).toHaveBeenCalled();
  });

  it('disables interaction in readOnly mode and hides the footer', () => {
    render(<UserInputBanner userInput={req()} onSubmit={() => {}} onSkip={() => {}} readOnly />);
    expect((screen.getByRole('radio', { name: /Cookies/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
  });

  it('renders resolved answers read-only', () => {
    const r = req({
      resolved: true,
      answers: [{ question: 'Which auth approach?', answer: 'Cookies' }],
    });
    render(<ResolvedUserInput userInput={r} />);
    expect(screen.getByText('Cookies')).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
  });
});
