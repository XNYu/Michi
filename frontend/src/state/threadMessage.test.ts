import { describe, expect, it } from 'vitest';
import { formatThreadMessage, parseChatStreamEvent } from 'michi-shared';
import { mapMessageRow } from './chatHydration';
import { reduceNodes } from './chatReducers';
import type { ChatNodeState } from './chatTypes';

const source = { fromNodeId: 'n-a', fromTitle: 'Research notes' };
const stored = formatThreadMessage({ fromNodeId: 'n-a', fromTitle: 'Research notes', text: 'Please review the API section.' });

function node(): ChatNodeState {
  return { nodeId: 'n-b', kind: 'chat', chatId: 'n-b', projectId: 'ws1', messages: [], followUps: [], status: 'idle' };
}

describe('cross-thread messages', () => {
  it('hydrates a relayed user message as its body plus a source marker', () => {
    const message = mapMessageRow({
      id: 'u-self-n-b-t1', node_id: 'n-b', role: 'user', content: stored, seq: 0, created_at: 1,
      metadata: JSON.stringify({ threadMessage: source }),
    });
    expect(message.text).toBe('Please review the API section.');
    expect(message.threadMessage).toEqual(source);
  });

  it('leaves ordinary messages and malformed sources untouched', () => {
    const ordinary = mapMessageRow({ id: 'u1', node_id: 'n-b', role: 'user', content: stored, seq: 0 });
    expect(ordinary.text).toBe(stored);
    expect(ordinary.threadMessage).toBeUndefined();
    const malformed = mapMessageRow({
      id: 'u2', node_id: 'n-b', role: 'user', content: stored, seq: 1,
      metadata: JSON.stringify({ threadMessage: { fromTitle: 'no id' } }),
    });
    expect(malformed.threadMessage).toBeUndefined();
    const assistant = mapMessageRow({
      id: 'a1', node_id: 'n-b', role: 'assistant', content: 'answer', seq: 2,
      metadata: JSON.stringify({ threadMessage: source }),
    });
    expect(assistant.threadMessage).toBeUndefined();
  });

  it('shows the relayed message live when a self-initiated turn carries user text', () => {
    const next = reduceNodes({ 'n-b': node() }, {
      type: 'observer-turn-start', nodeId: 'n-b', turnId: 't1', assistantId: 'self-n-b-t1',
      userText: stored, selfInitiated: true, userMetadata: { threadMessage: source }, cursor: 'background',
    });
    expect(next['n-b'].messages).toHaveLength(2);
    expect(next['n-b'].messages[0]).toMatchObject({
      id: 'u-self-n-b-t1', role: 'user', text: 'Please review the API section.', threadMessage: source,
    });
    expect(next['n-b'].messages[1]).toMatchObject({ id: 'self-n-b-t1', role: 'assistant', streaming: true });
  });

  it('keeps self-initiated turns without user text assistant-only', () => {
    const next = reduceNodes({ 'n-b': node() }, {
      type: 'observer-turn-start', nodeId: 'n-b', turnId: 't2', assistantId: 'self-n-b-t2',
      userText: '', selfInitiated: true, cursor: 'background',
    });
    expect(next['n-b'].messages.map((message) => message.role)).toEqual(['assistant']);
  });

  it('parses turn_start user metadata and ignores non-object values', () => {
    const parsed = parseChatStreamEvent('turn_start', JSON.stringify({
      turnId: 't1', assistantId: 'self-n-b-t1', nodeId: 'n-b', userText: stored, selfInitiated: true,
      userMetadata: { threadMessage: source },
    }));
    expect(parsed?.event).toBe('turn_start');
    expect(parsed?.event === 'turn_start' && parsed.data.userMetadata).toEqual({ threadMessage: source });
    const invalid = parseChatStreamEvent('turn_start', JSON.stringify({
      turnId: 't1', assistantId: 'a', nodeId: 'n-b', userText: '', userMetadata: ['x'],
    }));
    expect(invalid?.event === 'turn_start' && invalid.data.userMetadata).toBeUndefined();
  });
});
