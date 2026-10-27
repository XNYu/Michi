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
  it('is a no-op when the same id is added twice (idempotent)', () => {
    const c = comment('c1');
    const state = { n1: node({ pendingComments: [c] }) };
    const next = reduceNodes(state, { type: 'add-comment', nodeId: 'n1', comment: c });
    // Identity preserved so referential checks still work downstream.
    expect(next).toBe(state);
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
});

describe('reduceNodes: set-composer-draft', () => {
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
});

describe('file feedback metadata', () => {
  const source = { type: 'artifact' as const, filePath: 'a.md', snapshot: { hashKind: 'sha256-text-utf8' as const, contentHash: 'abc123', backendConnectionId: 'local', projectId: 'p1', resolvedFilePath: '/a.md' } };
  it('preserves the complete source in pending comments and quote drafts, including source-only updates', () => {
    let state: Record<string, ChatNodeState> = { n1: node() };
    state = reduceNodes(state, { type: 'add-comment', nodeId: 'n1', comment: { ...comment('c1'), source } });
    expect(state.n1.pendingComments?.[0].source).toEqual(source);
    state = reduceNodes(state, { type: 'set-composer-draft', nodeId: 'n1', draft: { value: '', mentions: [], quotedText: 'old quote', quoteSource: source } });
    expect(state.n1.composerDraft?.quoteSource).toEqual(source);
    const changed = { ...source, snapshot: { ...source.snapshot, contentHash: 'def456' } };
    state = reduceNodes(state, { type: 'set-composer-draft', nodeId: 'n1', draft: { value: '', mentions: [], quotedText: 'old quote', quoteSource: changed } });
    expect(state.n1.composerDraft?.quoteSource).toEqual(changed);
  });
});

it('restores a rejected quote from a different read version without misattributing either quote or shifting mentions', () => {
  const source = { type: 'artifact' as const, filePath: 'a.md', snapshot: { hashKind: 'sha256-text-utf8' as const, contentHash: 'old-hash', backendConnectionId: 'local', projectId: 'p1', resolvedFilePath: '/a.md' } };
  const currentSource = { ...source, snapshot: { ...source.snapshot, contentHash: 'new-hash' } };
  const mention = { start: 0, end: 2, kind: 'node' as const, refId: 'n1', label: 'n' };
  const state = { n1: node({ composerDraft: { value: '@n current', mentions: [mention], quotedText: 'new selection', quoteSource: currentSource } }) };
  const next = reduceNodes(state, { type: 'set-composer-draft', nodeId: 'n1', preserveExisting: true, draft: { value: '@n failed', mentions: [mention], quotedText: 'old selection', quoteSource: source } });
  const draft = next.n1.composerDraft!;
  expect(draft.quotedText).toBe('new selection');
  expect(draft.quoteSource).toEqual(currentSource);
  expect(draft.value).toContain('sha256-text-utf8 old-hash');
  expect(draft.value).toContain('old selection');
  for (const m of draft.mentions) expect(draft.value.slice(m.start, m.end)).toBe('@n');
});
