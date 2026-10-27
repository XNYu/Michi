import { describe, expect, it } from 'vitest';
import { formatThreadMessage, parseChatStreamEvent } from 'michi-shared';

import { reduceNodes } from './chatReducers';
import type { ChatNodeState } from './chatTypes';

const source = { fromNodeId: 'n-a', fromTitle: 'Research notes' };
const stored = formatThreadMessage({ fromNodeId: 'n-a', fromTitle: 'Research notes', text: 'Please review the API section.' });

function node(): ChatNodeState {
  return { nodeId: 'n-b', kind: 'chat', chatId: 'n-b', projectId: 'ws1', messages: [], followUps: [], status: 'idle' };
}

describe('cross-thread messages', () => {
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
