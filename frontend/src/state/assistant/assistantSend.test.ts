import { describe, expect, it, vi } from 'vitest';
import { reduceNodes } from '../chatReducers';
import type { ChatNodeState } from '../chatTypes';
import { joinMessageQuotes } from '../../lib/commentFormat';
import { ATTACHED_QUOTE_SOURCE } from '../../lib/quoteFormat';

vi.mock('../../services/api', () => ({}));

function node(extra: Partial<ChatNodeState> = {}): ChatNodeState {
  return { nodeId: 'n1', projectId: 'w1', title: '', status: 'idle', messages: [], ...extra } as ChatNodeState;
}

describe('user-send and the composer draft', () => {
  const draft = { value: 'still typing', mentions: [] };

  it('consumes the draft for a composer send', () => {
    const next = reduceNodes({ n1: node({ composerDraft: draft }) }, {
      type: 'user-send', nodeId: 'n1', userText: 'hi', assistantId: 'a1',
    });
    expect(next.n1.composerDraft).toBeUndefined();
    expect(next.n1.status).toBe('streaming');
  });

  it('leaves the draft untouched for a send that is not the composer’s', () => {
    const before = node({ composerDraft: draft });
    const next = reduceNodes({ n1: before }, {
      type: 'user-send', nodeId: 'n1', userText: 'Archive them', assistantId: 'a1',
      quotedText: 'On screen: Home', quoteSource: ATTACHED_QUOTE_SOURCE, keepDraft: true,
    });
    expect(next.n1.composerDraft).toBe(draft);
    expect(next.n1.status).toBe('streaming');
    const sent = next.n1.messages.find((m) => m.role === 'user')!;
    expect(sent.quotedText).toBe('On screen: Home');
    expect(sent.quoteSource).toEqual({ type: 'attached' });
  });
});

describe('joinMessageQuotes', () => {
  it('frames each quote by its own source, in order', () => {
    const wire = joinMessageQuotes(null, [
      { text: 'On screen: Home', source: ATTACHED_QUOTE_SOURCE },
      { text: 'the third one' },
    ], 'and then?');
    const attached = wire.indexOf('Attached context:\n> On screen: Home');
    const selected = wire.indexOf('Selected assistant passage:\n> the third one');
    expect(attached).toBeGreaterThanOrEqual(0);
    expect(selected).toBeGreaterThan(attached);
    expect(wire.endsWith("User's reply:\nand then?")).toBe(true);
  });
});
