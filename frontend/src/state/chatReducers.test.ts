import { describe, it, expect } from 'vitest';
import { reduceNodes } from './chatReducers';
import type { ChatNodeState, ChatAction } from './chatTypes';

function makeNode(over: Partial<ChatNodeState> = {}): ChatNodeState {
  return {
    nodeId: 'n1',
    kind: 'chat',
    chatId: 'c1',
    projectId: 'p1',
    messages: [
      { id: 'a1', role: 'assistant', text: 'hi', toolCalls: [], blocks: [], streaming: true, createdAt: 1 },
    ],
    followUps: [],
    status: 'streaming',
    ...over,
  };
}

describe('reduceNodes done — unread', () => {
  it('writes lastAssistantAt when an assistant turn completes', () => {
    const before = { n1: makeNode() };
    const action: ChatAction = { type: 'done', nodeId: 'n1', assistantId: 'a1' };
    const after = reduceNodes(before, action);
    expect(after.n1.lastAssistantAt).toBeGreaterThan(0);
    expect(after.n1.lastAssistantAt).toBeLessThanOrEqual(Date.now());
  });
});

describe('reduceNodes done — branch overview', () => {
  it('prefers the structured SSE overview over fallback text parsing for the same turn', () => {
    const before = {
      n1: makeNode({
        messages: [{
          id: 'a1',
          role: 'assistant',
          text: 'Quoted format: [BRANCH-OVERVIEW: stale example]\n\n[BRANCH-OVERVIEW: final server value]',
          toolCalls: [],
          streaming: true,
          createdAt: 1,
        }],
      }),
    };
    const withStructured = reduceNodes(before, {
      type: 'set-branch-overview',
      nodeId: 'n1',
      overview: 'final server value',
      assistantId: 'a1',
    });
    const after = reduceNodes(withStructured, { type: 'done', nodeId: 'n1', assistantId: 'a1' });
    expect(after.n1.branchOverview).toBe('final server value');
  });

  it('stores a valid branch overview from assistant metadata', () => {
    const before = {
      n1: makeNode({
        messages: [{
          id: 'a1',
          role: 'assistant',
          text: 'Answer.\n\n[BRANCH-OVERVIEW: The branch compares two auth models and currently favors rotating tokens.]',
          toolCalls: [],
          streaming: true,
          createdAt: 1,
        }],
      }),
    };
    const after = reduceNodes(before, { type: 'done', nodeId: 'n1', assistantId: 'a1' });
    expect(after.n1.branchOverview).toBe(
      'The branch compares two auth models and currently favors rotating tokens.',
    );
  });

  it('preserves the previous overview when a turn omits metadata', () => {
    const before = { n1: makeNode({ branchOverview: 'Previous overview' }) };
    const after = reduceNodes(before, { type: 'done', nodeId: 'n1', assistantId: 'a1' });
    expect(after.n1.branchOverview).toBe('Previous overview');
  });
});

describe('reduceNodes node-viewed', () => {
  it('writes viewedAt to the action timestamp', () => {
    const before = { n1: makeNode({ viewedAt: 100 }) };
    const action: ChatAction = { type: 'node-viewed', nodeId: 'n1', viewedAt: 9_999 };
    const after = reduceNodes(before, action);
    expect(after.n1.viewedAt).toBe(9_999);
  });

  it('is a no-op if the node is missing', () => {
    const before = { n1: makeNode() };
    const action: ChatAction = { type: 'node-viewed', nodeId: 'missing', viewedAt: 1 };
    const after = reduceNodes(before, action);
    expect(after).toBe(before);
  });
});

describe('reduceNodes mark-all-read', () => {
  it('clears unread on every chat node whose last reply post-dates the view', () => {
    const before = {
      a: makeNode({ nodeId: 'a', status: 'idle', lastAssistantAt: 500, viewedAt: 100 }),
      b: makeNode({ nodeId: 'b', status: 'idle', lastAssistantAt: 800, viewedAt: 200 }),
    };
    const action: ChatAction = { type: 'mark-all-read', viewedAt: 9_999 };
    const after = reduceNodes(before, action);
    expect(after.a.viewedAt).toBe(9_999);
    expect(after.b.viewedAt).toBe(9_999);
  });

  it('leaves already-read chat nodes and their reference untouched', () => {
    const read = makeNode({ nodeId: 'a', status: 'idle', lastAssistantAt: 100, viewedAt: 500 });
    const before = { a: read };
    const action: ChatAction = { type: 'mark-all-read', viewedAt: 9_999 };
    const after = reduceNodes(before, action);
    // Nothing was unread → same reference back (no re-render churn).
    expect(after).toBe(before);
    expect(after.a).toBe(read);
  });

  it('does not touch digest nodes (separate read model)', () => {
    const digest = makeNode({
      nodeId: 'd',
      kind: 'digest',
      status: 'idle',
      lastAssistantAt: 800,
      viewedAt: 100,
    });
    const before = {
      d: digest,
      c: makeNode({ nodeId: 'c', status: 'idle', lastAssistantAt: 800, viewedAt: 100 }),
    };
    const action: ChatAction = { type: 'mark-all-read', viewedAt: 9_999 };
    const after = reduceNodes(before, action);
    expect(after.d).toBe(digest);
    expect(after.c.viewedAt).toBe(9_999);
  });
});

describe('reduceNodes create — unread', () => {
  it('born-read: viewedAt is set to a recent ms on create', () => {
    const before = {} as Record<string, ChatNodeState>;
    const t0 = Date.now();
    const action: ChatAction = { type: 'create', nodeId: 'n1', projectId: 'p1' };
    const after = reduceNodes(before, action);
    expect(after.n1.viewedAt).toBeDefined();
    expect(after.n1.viewedAt!).toBeGreaterThanOrEqual(t0);
  });
});

describe('reduceNodes bind-chat — currentModeId preservation', () => {
  // A resumed kiro session reports no agent, so ensure-session returns
  // currentModeId=null. bind-chat must NOT wipe the node's persisted agent
  // back to the generic "agent" chip on every message.
  it('preserves the persisted agent when the bind carries a null mode', () => {
    const before = { n1: makeNode({ currentModeId: 'gpu-dev' }) };
    const action: ChatAction = {
      type: 'bind-chat',
      nodeId: 'n1',
      chatId: 'c2',
      currentModeId: null,
      runtimeId: 'kiro',
    };
    const after = reduceNodes(before, action);
    expect(after.n1.currentModeId).toBe('gpu-dev');
    expect(after.n1.chatId).toBe('c2');
  });

  it('overwrites when the bind carries an explicit mode', () => {
    const before = { n1: makeNode({ currentModeId: 'gpu-dev' }) };
    const action: ChatAction = {
      type: 'bind-chat',
      nodeId: 'n1',
      chatId: 'c2',
      currentModeId: 'security-reviewer',
      runtimeId: 'kiro',
    };
    const after = reduceNodes(before, action);
    expect(after.n1.currentModeId).toBe('security-reviewer');
  });
});
