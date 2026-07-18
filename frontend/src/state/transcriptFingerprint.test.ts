import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from './chatTypes';

const { assistantPersistenceContent } = vi.hoisted(() => ({
  assistantPersistenceContent: vi.fn((message?: ChatMessage) => message?.text ?? ''),
}));

vi.mock('./assistantBlocks', () => ({ assistantPersistenceContent }));

import { computeTranscriptFingerprint } from './transcriptFingerprint';

function assistant(text: string): ChatMessage {
  return {
    id: `assistant-${text}`,
    role: 'assistant',
    text,
    blocks: [],
    toolCalls: [],
    createdAt: 1,
  } as ChatMessage;
}

describe('computeTranscriptFingerprint', () => {
  beforeEach(() => assistantPersistenceContent.mockClear());

  it('preserves the existing wire-compatible golden vectors', () => {
    expect(computeTranscriptFingerprint([])).toBe('811c9dc5');
    expect(computeTranscriptFingerprint([
      { id: 'u1', role: 'user', text: 'hello', createdAt: 1 } as ChatMessage,
    ])).toBe('529ed6b6');
    expect(computeTranscriptFingerprint([
      { id: 'u1', role: 'user', text: 'hello', createdAt: 1 } as ChatMessage,
      assistant('hi'),
    ])).toBe('02ae81e1');
    expect(computeTranscriptFingerprint([
      { id: 'u2', role: 'user', text: '你好 👋', createdAt: 1 } as ChatMessage,
      assistant('line1\nline2\u0000x'),
    ])).toBe('f54f9ce6');
  });

  it('reuses finalized assistant content for the same immutable message object', () => {
    const message = assistant('cached answer');

    const first = computeTranscriptFingerprint([message]);
    const second = computeTranscriptFingerprint([message]);

    expect(second).toBe(first);
    expect(assistantPersistenceContent).toHaveBeenCalledTimes(1);
  });

  it('invalidates the finalized-content cache when the message object changes', () => {
    const firstMessage = assistant('answer one');
    const replacement = assistant('answer two');

    const first = computeTranscriptFingerprint([firstMessage]);
    const second = computeTranscriptFingerprint([replacement]);

    expect(second).not.toBe(first);
    expect(assistantPersistenceContent).toHaveBeenCalledTimes(2);
  });
});
