import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import UserInputBanner, { ResolvedUserInput, questionLayout } from './UserInputBanner';
import type { UserInputRequest } from '../../state/chatTypes';

vi.mock('../../state/prefs', () => ({
  usePrefs: () => ({ prefs: { reduceMotion: false } }),
}));

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
  it('preserves native question IDs when wording is duplicated', () => {
    const onSubmit = vi.fn();
    const userInput = req({ questions: ['first', 'second'].map((id) => ({
      id, question: 'Same question?', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false,
    })) });
    render(<UserInputBanner userInput={userInput} onSubmit={onSubmit} onSkip={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: /Yes/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Next question' }));
    fireEvent.click(screen.getByRole('radio', { name: /No/ }));
    fireEvent.click(screen.getByRole('button', { name: /Submit all/ }));
    expect(onSubmit).toHaveBeenCalledWith([
      { id: 'first', question: 'Same question?', answer: 'Yes' },
      { id: 'second', question: 'Same question?', answer: 'No' },
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

  it('lays out an approval question as a title and labelled facts', () => {
    expect(questionLayout([
      'Create scheduled job “Digest”?',
      'Permissions: Ask: tool approvals wait for you',
      'Permissions (unchanged): Trust',
      'Name → Nightly',
      'Removes the job and its run history.',
      'Prompt: “Summarize 18:00 changes…”',
    ].join('\n'))).toEqual({
      title: 'Create scheduled job “Digest”?',
      details: [
        { label: 'Permissions', value: 'Ask: tool approvals wait for you' },
        { label: 'Permissions (unchanged)', value: 'Trust' },
        { label: 'Name', value: 'Nightly' },
        { value: 'Removes the job and its run history.' },
        { label: 'Prompt', value: 'Summarize 18:00 changes…', quoted: true },
      ],
    });
  });

  it('keeps questions without labelled facts, or with a blank line, as written', () => {
    expect(questionLayout('Which auth approach?')).toBeNull();
    expect(questionLayout('Send this message to "A"?\n\nStatus: done\nNext: review')).toBeNull();
    expect(questionLayout('Pick one\nsee https://example.com/a:b')).toBeNull();
    const text = 'Send this message?\n\nStatus: done';
    render(<UserInputBanner userInput={req({ questions: [{ question: text, options: [{ label: 'Send' }], multiSelect: false }] })} onSubmit={() => {}} onSkip={() => {}} />);
    expect(document.querySelector('.ask-card-qtext')?.textContent).toBe(text);
    expect(document.querySelector('.ask-card-details')).toBeNull();
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
