import { describe, expect, it } from 'vitest';
import { reduceNodes } from './chatReducers';
import type { ChatNodeState, PendingComment } from './chatTypes';

/**
 * Factory for a minimal chat node used as the reducer's starting state.
 * Only the fields the comment actions actually read/write matter; everything
 * else is filler that keeps the ChatNodeState type happy.
 */
function node(overrides: Partial<ChatNodeState> = {}): ChatNodeState {
  return {
    nodeId: 'n1',
    kind: 'chat',
    chatId: null,
    projectId: 'p1',
    messages: [],
    followUps: [],
    status: 'idle',
    ...overrides,
  };
}

function comment(
  id: string,
  body = `body-${id}`,
  quoted = `quote-${id}`,
): PendingComment {
  return {
    id,
    quotedText: quoted,
    body,
    createdAt: Number.parseInt(id.replace(/\D/g, ''), 10) || 0,
  };
}

describe('reduceNodes: add-comment', () => {
  it('adds a comment to a node with no pending comments', () => {
    const state = { n1: node() };
    const c = comment('c1');
    const next = reduceNodes(state, { type: 'add-comment', nodeId: 'n1', comment: c });
    expect(next.n1.pendingComments).toEqual([c]);
  });

  it('appends to existing pending comments in order', () => {
    const c1 = comment('c1');
    const c2 = comment('c2');
    const state = { n1: node({ pendingComments: [c1] }) };
    const next = reduceNodes(state, { type: 'add-comment', nodeId: 'n1', comment: c2 });
    expect(next.n1.pendingComments).toEqual([c1, c2]);
  });

  it('is a no-op when the same id is added twice (idempotent)', () => {
    const c = comment('c1');
    const state = { n1: node({ pendingComments: [c] }) };
    const next = reduceNodes(state, { type: 'add-comment', nodeId: 'n1', comment: c });
    // Identity preserved so referential checks still work downstream.
    expect(next).toBe(state);
  });

  it('does not mutate the input node', () => {
    const state = { n1: node() };
    const before = state.n1;
    reduceNodes(state, { type: 'add-comment', nodeId: 'n1', comment: comment('c1') });
    expect(before.pendingComments).toBeUndefined();
  });

  it('leaves other nodes untouched', () => {
    const state = { n1: node(), n2: node({ nodeId: 'n2' }) };
    const before = state.n2;
    const next = reduceNodes(state, {
      type: 'add-comment',
      nodeId: 'n1',
      comment: comment('c1'),
    });
    expect(next.n2).toBe(before);
  });

  it('is a no-op when the node does not exist', () => {
    const state = { n1: node() };
    const next = reduceNodes(state, {
      type: 'add-comment',
      nodeId: 'missing',
      comment: comment('c1'),
    });
    expect(next).toBe(state);
  });
});

describe('reduceNodes: remove-comment', () => {
  it('removes by id and keeps the rest in order', () => {
    const c1 = comment('c1');
    const c2 = comment('c2');
    const c3 = comment('c3');
    const state = { n1: node({ pendingComments: [c1, c2, c3] }) };
    const next = reduceNodes(state, {
      type: 'remove-comment',
      nodeId: 'n1',
      commentId: 'c2',
    });
    expect(next.n1.pendingComments).toEqual([c1, c3]);
  });

  it('deletes the pendingComments key when the last comment is removed', () => {
    const c = comment('c1');
    const state = { n1: node({ pendingComments: [c] }) };
    const next = reduceNodes(state, {
      type: 'remove-comment',
      nodeId: 'n1',
      commentId: 'c1',
    });
    expect(next.n1.pendingComments).toBeUndefined();
    // Explicitly verify the key is gone (not just undefined) so persistence
    // doesn't write an empty array into localStorage forever.
    expect('pendingComments' in next.n1).toBe(false);
  });

  it('is a no-op when the id is unknown', () => {
    const state = { n1: node({ pendingComments: [comment('c1')] }) };
    const next = reduceNodes(state, {
      type: 'remove-comment',
      nodeId: 'n1',
      commentId: 'missing',
    });
    expect(next).toBe(state);
  });

  it('is a no-op when there are no pending comments', () => {
    const state = { n1: node() };
    const next = reduceNodes(state, {
      type: 'remove-comment',
      nodeId: 'n1',
      commentId: 'c1',
    });
    expect(next).toBe(state);
  });
});

describe('reduceNodes: clear-comments', () => {
  it('clears all pending comments on the target node', () => {
    const state = {
      n1: node({ pendingComments: [comment('c1'), comment('c2')] }),
    };
    const next = reduceNodes(state, { type: 'clear-comments', nodeId: 'n1' });
    expect(next.n1.pendingComments).toBeUndefined();
    expect('pendingComments' in next.n1).toBe(false);
  });

  it('does not affect pendingComments on other nodes', () => {
    const state = {
      n1: node({ pendingComments: [comment('c1')] }),
      n2: node({ nodeId: 'n2', pendingComments: [comment('c2')] }),
    };
    const next = reduceNodes(state, { type: 'clear-comments', nodeId: 'n1' });
    expect(next.n2.pendingComments).toEqual([comment('c2')]);
  });

  it('is a no-op when the node has no pending comments', () => {
    const state = { n1: node() };
    const next = reduceNodes(state, { type: 'clear-comments', nodeId: 'n1' });
    expect(next).toBe(state);
  });

  it('is a no-op when the node does not exist', () => {
    const state = { n1: node() };
    const next = reduceNodes(state, { type: 'clear-comments', nodeId: 'missing' });
    expect(next).toBe(state);
  });
});

describe('reduceNodes: set-composer-draft', () => {
  it('saves text, mention chips, and quote context on the node', () => {
    const state = { n1: node() };
    const draft = {
      value: 'compare @Notes with @Thread ',
      mentions: [
        { start: 8, end: 14, kind: 'context' as const, refId: 'ctx1', label: 'Notes' },
        { start: 20, end: 27, kind: 'node' as const, refId: 'n2', label: 'Thread' },
      ],
      quotedText: 'selected passage',
    };
    const next = reduceNodes(state, { type: 'set-composer-draft', nodeId: 'n1', draft });
    expect(next.n1.composerDraft).toEqual(draft);
  });

  it('deletes the composerDraft key when the draft is empty', () => {
    const state = {
      n1: node({
        composerDraft: {
          value: 'unfinished',
          mentions: [],
        },
      }),
    };
    const next = reduceNodes(state, {
      type: 'set-composer-draft',
      nodeId: 'n1',
      draft: { value: '', mentions: [] },
    });
    expect(next.n1.composerDraft).toBeUndefined();
    expect('composerDraft' in next.n1).toBe(false);
  });

  it('clears a saved draft when a message is sent', () => {
    const state = {
      n1: node({
        composerDraft: {
          value: 'send me',
          mentions: [],
          quotedText: 'old quote',
        },
      }),
    };
    const next = reduceNodes(state, {
      type: 'user-send',
      nodeId: 'n1',
      userText: 'send me',
      assistantId: 'a1',
    });
    expect(next.n1.composerDraft).toBeUndefined();
  });
});
