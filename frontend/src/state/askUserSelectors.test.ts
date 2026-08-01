import { describe, it, expect } from 'vitest';
import {
  isAwaitingUserInput,
  pendingAskUsersEqual,
  selectPendingAskUsers,
} from './askUserSelectors';
import type { ChatNodeState, UserInputRequest } from './chatTypes';

function request(overrides: Partial<UserInputRequest> = {}): UserInputRequest {
  return {
    requestId: 1,
    questions: [{ question: 'Which database?', header: 'db', options: [], multiSelect: false }],
    answers: [],
    ...overrides,
  };
}

function node(overrides: Partial<ChatNodeState> = {}): ChatNodeState {
  return {
    nodeId: 'n-1',
    kind: 'chat',
    chatId: 'n-1',
    projectId: 'p-1',
    messages: [{ id: 'm-1', role: 'assistant', text: 'thinking' }],
    followUps: [],
    status: 'streaming',
    ...overrides,
  } as unknown as ChatNodeState;
}

describe('isAwaitingUserInput', () => {
  it('is true for an unresolved request', () => {
    expect(isAwaitingUserInput(node({ pendingUserInput: request() }))).toBe(true);
  });

  it('is false once the request resolves', () => {
    expect(
      isAwaitingUserInput(node({ pendingUserInput: request({ resolved: true }) })),
    ).toBe(false);
  });

  it('is false with no pending request, a null request, or a missing node', () => {
    expect(isAwaitingUserInput(node())).toBe(false);
    expect(isAwaitingUserInput(node({ pendingUserInput: null }))).toBe(false);
    expect(isAwaitingUserInput(undefined)).toBe(false);
  });

  it('is false for a trashed node — its ask can no longer be answered', () => {
    expect(
      isAwaitingUserInput(node({ pendingUserInput: request(), deletedAt: 123 })),
    ).toBe(false);
  });
});

describe('selectPendingAskUsers', () => {
  it('returns only awaiting nodes, in nodes-map order', () => {
    const pending = selectPendingAskUsers({
      'n-1': node({ nodeId: 'n-1', title: 'First' }),
      'n-2': node({ nodeId: 'n-2', title: 'Second', pendingUserInput: request({ requestId: 7 }) }),
      'n-3': node({ nodeId: 'n-3', title: 'Third', pendingUserInput: request({ requestId: 8 }) }),
    });
    expect(pending.map((p) => p.nodeId)).toEqual(['n-2', 'n-3']);
    expect(pending[0]).toEqual({
      nodeId: 'n-2',
      title: 'Second',
      question: 'Which database?',
      requestId: 7,
      anchorMessageId: 'm-1',
    });
  });

  it('falls back to empty strings / null rather than throwing on sparse nodes', () => {
    const pending = selectPendingAskUsers({
      'n-1': node({
        title: undefined,
        messages: [],
        pendingUserInput: request({ questions: [] }),
      }),
    });
    expect(pending).toEqual([
      { nodeId: 'n-1', title: '', question: '', requestId: 1, anchorMessageId: null },
    ]);
  });

  it('takes the first question of a multi-question ask', () => {
    const pending = selectPendingAskUsers({
      'n-1': node({
        pendingUserInput: request({
          questions: [
            { question: 'Q1?', header: 'a', options: [], multiSelect: false },
            { question: 'Q2?', header: 'b', options: [], multiSelect: false },
          ],
        }),
      }),
    });
    expect(pending[0].question).toBe('Q1?');
  });
});

describe('pendingAskUsersEqual', () => {
  const a = { nodeId: 'n-1', title: 'T', question: 'Q?', requestId: 1, anchorMessageId: 'm-1' };

  it('treats field-wise identical lists as equal', () => {
    expect(pendingAskUsersEqual([a], [{ ...a }])).toBe(true);
  });

  it('detects length, question and requestId changes', () => {
    expect(pendingAskUsersEqual([a], [])).toBe(false);
    expect(pendingAskUsersEqual([a], [{ ...a, question: 'other?' }])).toBe(false);
    expect(pendingAskUsersEqual([a], [{ ...a, requestId: 2 }])).toBe(false);
  });
});
