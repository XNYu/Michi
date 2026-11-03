import React from 'react';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import UserInputBanner, { ResolvedUserInput, questionLayout } from './UserInputBanner';
import type { UserInputRequest } from '../../state/chatTypes';
import type { UserInputAnswer } from '../../services/chatStreamEvents';

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
  vi.restoreAllMocks();
});

/** jsdom lays nothing out; the hand-off needs the live card's height. */
function layOutCards() {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(180);
}

/**
 * What MessageBlock does: the receipt replaces the live card once the request
 * resolves, which the store does after the response round trip (async).
 * `extraReceipts` mounts more receipts for the same request in the same commit.
 */
function Swap({ userInput, extraReceipts = 0 }: { userInput: UserInputRequest; extraReceipts?: number }) {
  const [answers, setAnswers] = React.useState<UserInputAnswer[] | null>(null);
  const resolveLater = (next: UserInputAnswer[]) => { void Promise.resolve().then(() => setAnswers(next)); };
  if (!answers) return <UserInputBanner userInput={userInput} onSubmit={resolveLater} onSkip={() => resolveLater([])} />;
  const resolved = { ...userInput, resolved: true, answers };
  return <>
    <ResolvedUserInput userInput={resolved} />
    {Array.from({ length: extraReceipts }, (_, i) => <ResolvedUserInput key={i} userInput={resolved} />)}
  </>;
}

async function landAnswer() {
  await act(async () => { await Promise.resolve(); });
}

interface GhostSighting {
  ghost: HTMLElement;
  receipt: HTMLElement;
  receiptHeight: string;
  fades: number;
  fills: number;
  /** Findable text (text nodes only) of the receipt and of the copy. */
  receiptText: string;
  ghostText: string;
  labelled: boolean;
  receipts: number;
  liveCards: number;
}

/**
 * The copy lives for a few frames; with animations skipped its exit can finish
 * inside the same act, so look at it the moment the receipt takes it in.
 */
function watchGhosts(): GhostSighting[] {
  const seen: GhostSighting[] = [];
  const append = Node.prototype.appendChild;
  vi.spyOn(Node.prototype, 'appendChild').mockImplementation(function appendChild<T extends Node>(this: Node, node: T): T {
    const result = append.call(this, node) as T;
    if (node instanceof HTMLElement && node.classList.contains('ask-card-ghost')) {
      const receipt = this as HTMLElement;
      seen.push({
        ghost: node,
        receipt,
        receiptHeight: receipt.style.height,
        fades: node.querySelectorAll('[data-ask-fade]').length,
        fills: node.querySelectorAll('[data-ask-fill]').length,
        receiptText: receipt.textContent ?? '',
        ghostText: node.textContent ?? '',
        labelled: !!node.querySelector('[aria-label], [aria-live], [placeholder], [id]'),
        receipts: document.querySelectorAll('.ask-resolved').length,
        liveCards: document.querySelectorAll('.ask-card:not(.ask-resolved)').length,
      });
    }
    return result;
  });
  return seen;
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('UserInputBanner answering', () => {
  it('fills the chosen option, fades the others and sends once', () => {
    const onSubmit = vi.fn();
    const onSkip = vi.fn();
    render(<UserInputBanner userInput={req()} onSubmit={onSubmit} onSkip={onSkip} />);
    fireEvent.click(screen.getByRole('radio', { name: /Cookies/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    expect(document.querySelector('.ask-card')?.getAttribute('data-answering')).toBe('true');
    const cookies = screen.getByRole('radio', { name: /Cookies/ });
    expect(cookies.querySelector('[data-ask-fill]')).not.toBeNull();
    expect(cookies.hasAttribute('data-ask-fade')).toBe(false);
    expect(screen.getByRole('radio', { name: /JWT/ }).hasAttribute('data-ask-fade')).toBe(true);
    expect(document.querySelector('.ask-card-opt-other')?.hasAttribute('data-ask-fade')).toBe(true);
    // The controls tell AT they are not taking input.
    expect(screen.getByRole('button', { name: 'Submit' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('button', { name: 'Skip' }).getAttribute('aria-disabled')).toBe('true');
    expect(cookies.getAttribute('aria-disabled')).toBe('true');

    // Until the receipt takes over, the card is settled on the sent answer.
    fireEvent.click(screen.getByRole('radio', { name: /JWT/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSkip).not.toHaveBeenCalled();
    expect(cookies.getAttribute('aria-checked')).toBe('true');
  });

  it('takes input again as soon as the send reports it did not land', async () => {
    const onSubmit = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(false))
      .mockImplementationOnce(() => Promise.reject(new Error('offline')))
      .mockImplementationOnce(() => Promise.resolve(true));
    render(<UserInputBanner userInput={req()} onSubmit={onSubmit} onSkip={() => {}} />);
    const card = () => document.querySelector('.ask-card') as HTMLElement;
    fireEvent.click(screen.getByRole('radio', { name: /Cookies/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await flush();
    expect(card().hasAttribute('data-answering')).toBe(false);
    expect(screen.getByRole('button', { name: 'Submit' }).hasAttribute('aria-disabled')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await flush();
    expect(card().hasAttribute('data-answering')).toBe(false);

    // Landed: stays answered while the receipt is on its way.
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await flush();
    expect(card().getAttribute('data-answering')).toBe('true');
    expect(onSubmit).toHaveBeenCalledTimes(3);
  });

  it('falls back to giving the card back when the send returns nothing to wait on', () => {
    vi.useFakeTimers();
    const onSubmit = vi.fn();
    render(<UserInputBanner userInput={req()} onSubmit={onSubmit} onSkip={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: /Cookies/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    act(() => { vi.advanceTimersByTime(2999); });
    expect(document.querySelector('.ask-card')?.getAttribute('data-answering')).toBe('true');
    act(() => { vi.advanceTimersByTime(1); });
    expect(document.querySelector('.ask-card')?.hasAttribute('data-answering')).toBe(false);
    expect(screen.getByRole('radio', { name: /JWT/ }).hasAttribute('data-ask-fade')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('collapses the answered card into its receipt under a fading, unfindable copy of the card', async () => {
    layOutCards();
    const ghosts = watchGhosts();
    render(<Swap userInput={req({ interactionId: 'turn:input:handoff' })} />);
    fireEvent.click(screen.getByRole('radio', { name: /JWT/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(document.querySelector('.ask-resolved')).toBeNull();
    await landAnswer();

    const receipt = document.querySelector('.ask-resolved') as HTMLElement;
    expect(ghosts).toHaveLength(1);
    const [seen] = ghosts;
    expect(seen.receipt).toBe(receipt);
    expect(seen.ghost.getAttribute('aria-hidden')).toBe('true');
    expect(seen.ghost.hasAttribute('inert')).toBe(true);
    expect(seen.ghost.style.height).toBe('180px');
    expect(seen.receiptHeight).toBe('180px');
    // The copy carries the marking: JWT filled, the rest fading.
    expect(seen.fills).toBe(1);
    expect(seen.fades).toBe(2);
    // The copy is drawn, not text: only the receipt's answer is findable, and
    // it is neither a card, a receipt, a label nor a placeholder to lookups.
    expect(seen.ghost.querySelector('[data-ask-ghost-text="JWT"]')).not.toBeNull();
    expect(seen.ghostText.trim()).toBe('');
    expect(seen.receiptText.split('JWT')).toHaveLength(2);
    expect(seen.receiptText).not.toContain('Which auth approach?');
    expect(seen.labelled).toBe(false);
    expect(seen.receipts).toBe(1);
    expect(seen.liveCards).toBe(0);
    expect(screen.queryByRole('radio')).toBeNull();

    await waitFor(() => expect(receipt.querySelector('.ask-card-ghost')).toBeNull());
    await waitFor(() => expect(receipt.style.height).toBe(''));
    expect(within(receipt).getAllByText('JWT')).toHaveLength(1);
  });

  it('copies what is on screen: running fades are committed before the copy is taken', async () => {
    layOutCards();
    const commitStyles = vi.fn();
    Object.defineProperty(Element.prototype, 'getAnimations', {
      configurable: true,
      value() { return [{ commitStyles }]; },
    });
    try {
      render(<Swap userInput={req({ interactionId: 'turn:input:commit' })} />);
      fireEvent.click(screen.getByRole('radio', { name: /JWT/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
      expect(commitStyles).not.toHaveBeenCalled();
      await landAnswer();
      expect(commitStyles).toHaveBeenCalled();
    } finally {
      delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
    }
  });

  it('hands off a skip the same way', async () => {
    layOutCards();
    const ghosts = watchGhosts();
    render(<Swap userInput={req({ interactionId: 'turn:input:skip' })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await landAnswer();
    const receipt = document.querySelector('.ask-resolved') as HTMLElement;
    expect(within(receipt).getByText('(skipped)')).toBeTruthy();
    // Nothing was chosen: every option fades.
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].fades).toBe(3);
    expect(ghosts[0].fills).toBe(0);
    await waitFor(() => expect(receipt.querySelector('.ask-card-ghost')).toBeNull());
  });

  it('gives the copy to the first receipt only', async () => {
    layOutCards();
    const ghosts = watchGhosts();
    render(<Swap userInput={req({ interactionId: 'turn:input:twice' })} extraReceipts={1} />);
    fireEvent.click(screen.getByRole('radio', { name: /JWT/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await landAnswer();
    const receipts = document.querySelectorAll<HTMLElement>('.ask-resolved');
    expect(receipts).toHaveLength(2);
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].receipt).toBe(receipts[0]);
    expect(receipts[1].getAttribute('style')).toBeNull();
  });

  it('keeps hand-offs to their own conversation', async () => {
    layOutCards();
    // No interaction id: the same request id in two panes must not mix.
    const userInput = req();
    function TwoPanes() {
      const [answers, setAnswers] = React.useState<UserInputAnswer[] | null>(null);
      const resolved = answers ? { ...userInput, resolved: true, answers } : null;
      return <>
        <div data-node-id="other">{resolved && <ResolvedUserInput userInput={resolved} />}</div>
        <div data-node-id="asking">{resolved
          ? <ResolvedUserInput userInput={resolved} />
          : <UserInputBanner userInput={userInput} onSubmit={(next) => { void Promise.resolve().then(() => setAnswers(next)); }} onSkip={() => {}} />}
        </div>
      </>;
    }
    const ghosts = watchGhosts();
    render(<TwoPanes />);
    fireEvent.click(screen.getByRole('radio', { name: /Cookies/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await landAnswer();
    // The other pane's receipt mounts first in the commit but has its own key.
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].receipt.closest('[data-node-id]')?.getAttribute('data-node-id')).toBe('asking');
    expect(document.querySelector('[data-node-id="other"] .ask-resolved')?.getAttribute('style')).toBeNull();
  });

  it('renders a receipt settled when the live card left for another reason', () => {
    layOutCards();
    const userInput = req({ interactionId: 'turn:input:stale' });
    const live = render(<UserInputBanner userInput={userInput} onSubmit={() => {}} onSkip={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: /Cookies/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    live.unmount(); // e.g. the pane closed before the answer landed
    const later = Date.now() + 1000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    const resolved = { ...userInput, resolved: true, answers: [{ question: 'Which auth approach?', answer: 'Cookies' }] };
    render(<ResolvedUserInput userInput={resolved} />);
    const receipt = document.querySelector('.ask-resolved') as HTMLElement;
    expect(receipt.getAttribute('style')).toBeNull();
    expect(receipt.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('plays the entrance only for a request that just arrived', () => {
    const now = Date.now();
    const live = req({ interactionId: 'turn:input:entrance', receivedAt: now });
    const first = render(<UserInputBanner userInput={live} onSubmit={() => {}} onSkip={() => {}} />);
    const card = () => document.querySelector('.ask-card') as HTMLElement;
    expect(card().style.opacity).toBe('0');
    first.unmount();

    // Remounted later (pane or thread switch): settled.
    vi.spyOn(Date, 'now').mockReturnValue(now + 5000);
    const again = render(<UserInputBanner userInput={live} onSubmit={() => {}} onSkip={() => {}} />);
    expect(card().style.opacity).toBe('1');
    again.unmount();

    // Hydrated (no stamp): settled.
    render(<UserInputBanner userInput={req({ interactionId: 'turn:input:hydrated' })} onSubmit={() => {}} onSkip={() => {}} />);
    expect(card().style.opacity).toBe('1');
  });
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
    // From history: settled, with no hand-off to play.
    expect(document.querySelector('.ask-resolved')?.getAttribute('style')).toBeNull();
  });
});
