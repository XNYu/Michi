import { describe, expect, it } from 'vitest';
import { hydrateSavedState, mapNodeRowScalars, mapMessageRow } from './chatHydration';

describe('turn message snapshot hydration', () => {
  it('restores plan, user metadata, and complete tool-call fields', () => {
    const user = mapMessageRow({
      id: 'u-a1', node_id: 'n1', role: 'user', content: 'hello', seq: 0, created_at: 1,
      metadata: JSON.stringify({
        quotedText: 'quote',
        attachments: [{ name: 'a.txt', absPath: '/tmp/a.txt' }],
        comments: [{ id: 'c1', quotedText: 'old', body: 'new' }],
      }),
    });
    const assistant = mapMessageRow({
      id: 'a1', node_id: 'n1', role: 'assistant', content: 'answer', seq: 1, created_at: 2,
      blocks: JSON.stringify([{ id: 'a1-b-0', kind: 'answer', rawText: 'answer', streaming: false }]),
      tool_calls: JSON.stringify([{ id: 't1', title: 'Read', status: 'completed', detail: 'why', inputJson: '{"x":1}', output: 'ok', textOffset: 0 }]),
      metadata: JSON.stringify({ plan: [{ content: 'ship', priority: 'high', status: 'completed' }] }),
    });

    expect(user.quotedText).toBe('quote');
    expect(user.attachments).toEqual([{ name: 'a.txt', absPath: '/tmp/a.txt' }]);
    expect(user.comments?.[0]?.body).toBe('new');
    expect(assistant.plan).toEqual([{ content: 'ship', priority: 'high', status: 'completed' }]);
    expect(assistant.toolCalls[0]).toMatchObject({
      detail: 'why', inputJson: '{"x":1}', output: 'ok', textOffset: 0,
    });
  });
});

describe('hydrated errors retain unknown execution semantics', () => {
  it('does not infer the failed turn from a backend row replay watermark', () => {
    const node = mapNodeRowScalars({ id: 'n1', status: 'error', last_applied_turn_id: 'older-success' });
    expect(node).toMatchObject({ status: 'error', errorKind: 'turn_outcome_unknown', lastAppliedTurnId: 'older-success' });
    expect(node.errorTurnId).toBeUndefined();
  });

  it('classifies a restart interruption from the backend-written turn receipt', () => {
    const node = mapNodeRowScalars({
      id: 'n1', status: 'error', last_applied_turn_id: 'older-success',
      last_turn_id: 'cut-short', last_turn_status: 'error', last_turn_error: 'backend_restarted', last_turn_completed_at: 600,
    });
    expect(node).toMatchObject({
      status: 'error', errorKind: 'backend_restarted', errorTurnId: 'cut-short', errorCompletedAt: 600,
      error: 'Michi restarted while this task was running. Review the partial output above, then resume.',
      lastAppliedTurnId: 'older-success',
    });
  });

  it('keeps an ordinary finalized failure as a plain error with its own message', () => {
    const node = mapNodeRowScalars({
      id: 'n1', status: 'error', last_turn_id: 'failed', last_turn_status: 'error', last_turn_error: 'unexpected status 403 Forbidden', last_turn_completed_at: 7,
    });
    expect(node).toMatchObject({ status: 'error', errorTurnId: 'failed', error: 'unexpected status 403 Forbidden', errorCompletedAt: 7 });
    expect(node.errorKind).toBeUndefined();
  });

  it('stays unknown when the receipt does not prove a failure', () => {
    for (const receipt of [
      { last_turn_id: 'done', last_turn_status: 'completed', last_turn_error: null },
      { last_turn_id: 'live', last_turn_status: 'active', last_turn_error: null },
      { last_turn_id: 'blank', last_turn_status: 'error', last_turn_error: '' },
      { last_turn_status: 'error', last_turn_error: 'backend_restarted' },
    ]) {
      const node = mapNodeRowScalars({ id: 'n1', status: 'error', ...receipt });
      expect(node.errorKind).toBe('turn_outcome_unknown');
      expect(node.errorTurnId).toBeUndefined();
    }
    expect(mapNodeRowScalars({ id: 'n1', status: 'idle', last_turn_id: 'x', last_turn_status: 'error', last_turn_error: 'backend_restarted' }).errorKind).toBeUndefined();
  });

  it('treats legacy errors as unknown and does not trust their old error kind or watermark', () => {
    const { nodes } = hydrateSavedState({ version: 6, projects: [], nodes: { n1: {
      nodeId: 'n1', projectId: 'p1', status: 'error', errorKind: 'generic', lastAppliedTurnId: 'older-success',
      messages: [{ id: 'answer', role: 'assistant', text: 'Already produced', toolCalls: [] }],
    } } });
    expect(nodes.n1).toMatchObject({ status: 'error', errorKind: 'turn_outcome_unknown', lastAppliedTurnId: 'older-success' });
    expect(nodes.n1.errorTurnId).toBeUndefined();
    expect(nodes.n1.messages[0].id).toBe('answer');
  });
});

it('round-trips snapshot provenance in saved messages and composer drafts', () => {
  const source = { type: 'artifact', filePath: 'a.md', snapshot: { hashKind: 'sha256-text-utf8', contentHash: 'abc', backendConnectionId: 'local', projectId: 'p', resolvedFilePath: '/a.md' } };
  const comment = { id: 'c', body: 'edit', quotedText: 'old', createdAt: 1, source };
  const message = mapMessageRow({ id: 'u', node_id: 'n', role: 'user', content: 'edit', seq: 0, created_at: 1, metadata: JSON.stringify({ comments: [comment], quotedText: 'old', quoteSource: source }) });
  expect(message.comments?.[0].source).toEqual(source);
  expect(message.quoteSource).toEqual(source);
  const node = mapNodeRowScalars({ id: 'n', status: 'idle', composer_draft: { value: 'edit', mentions: [], quotedText: 'old', quoteSource: source } });
  expect(node.composerDraft?.quoteSource).toEqual(source);
});
