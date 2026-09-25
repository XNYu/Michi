import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PANE_INSPECTION_LIMITS } from 'michi-shared';
import {
  chatNodeToDescriptor,
  truncateTailToCodePointUtf8,
  type ChatNodeToDescriptorInput,
} from '../src/services/paneInspectionProjection.chat';
import type { ChatObservationSnapshot } from '../src/agents/chatHub';
import type { NodeRow, TurnRow } from '../src/services/dbRepository';

// ---------------------------------------------------------------------------
// Fixture builders — plain objects only, no DB, no real ChatHub.
// ---------------------------------------------------------------------------

function node(overrides: Partial<NodeRow> = {}): NodeRow {
  return {
    id: 'node-1',
    workspace_id: 'ws-1',
    tree_id: 'tree-1',
    parent_node_id: null,
    kind: 'chat',
    title: 'Test chat',
    status: 'active',
    minimized: 0,
    spawned_by_agent: 0,
    created_at: 1_000,
    ...overrides,
  } as NodeRow;
}

function observation(overrides: Partial<ChatObservationSnapshot> = {}): ChatObservationSnapshot {
  return {
    chatId: 'node-1',
    nodeId: 'node-1',
    turnId: 'turn-1',
    assistantId: 'asst-1',
    inMemoryStatus: 'active',
    durableStatus: 'active',
    snapshot: {
      version: 1,
      turnId: 'turn-1',
      nodeId: 'node-1',
      workspaceId: 'ws-1',
      assistantId: 'asst-1',
      userMessage: null,
      assistantMessage: {
        id: 'asst-1',
        role: 'assistant',
        content: '',
        blocks: [],
        toolCalls: [],
        createdAt: 1_000,
      },
      nodeMetadata: {},
      status: 'active',
      lastAppliedSeq: 0,
      startedAt: 1_000,
    },
    cursor: { turnId: 'turn-1', seq: 0 },
    startedAt: 1_000,
    pendingInteraction: { waiting: false },
    cancelRequestedAt: null,
    lastPersistenceError: null,
    selfInitiated: false,
    ...overrides,
  } as ChatObservationSnapshot;
}

function turnRow(overrides: Partial<TurnRow> = {}): TurnRow {
  return {
    turn_id: 'turn-1',
    node_id: 'node-1',
    user_message_id: 'msg-user-1',
    assistant_message_id: 'asst-1',
    status: 'completed',
    last_seq: 5,
    stop_reason: null,
    error: null,
    started_at: 1_000,
    checkpoint_at: null,
    completed_at: 2_000,
    updated_at: 2_000,
    ...overrides,
  } as TurnRow;
}

function baseInput(overrides: Partial<ChatNodeToDescriptorInput> = {}): ChatNodeToDescriptorInput {
  return {
    node: node(),
    observation: null,
    durableTurn: null,
    counts: { total: 0, user: 0, assistant: 0 },
    turns: { count: 0, coverage: 'complete' },
    lineage: {
      parentNodeId: null,
      treeRootNodeId: 'node-1',
      childNodeIds: [],
      childrenTruncated: false,
      originMessageId: null,
    },
    runtime: { runtimeId: null, modelId: null, providerId: null, contextUsagePercentage: null },
    presence: { coverage: 'unknown', views: [] },
    backendConnectionId: 'conn-1',
    observedAt: 10_000,
    ...overrides,
  };
}

function answerBlock(id: string, rawText: string) {
  return { id, kind: 'answer' as const, rawText };
}

// ---------------------------------------------------------------------------
// §6.1 state table — one describe block per row
// ---------------------------------------------------------------------------

describe('§6.1 row: pending spawn prompt, turn not yet started', () => {
  it('reports queued / ready+null and does not invent a turnId', () => {
    const d = chatNodeToDescriptor(baseInput({ node: node({ spawned_by_agent: 1 }) }));
    assert.equal(d.activity, 'queued');
    assert.deepEqual(d.execution, { status: 'ready', value: null });
  });
});

describe('§6.1 row: ChatHub active turn', () => {
  it('reports running / commitState pending', () => {
    const d = chatNodeToDescriptor(baseInput({ observation: observation() }));
    assert.equal(d.activity, 'running');
    assert.equal(d.execution.status, 'ready');
    if (d.execution.status !== 'ready' || !d.execution.value) throw new Error('expected value');
    assert.equal(d.execution.value.status, 'running');
    assert.equal(d.execution.value.commitState, 'pending');
    assert.deepEqual(d.execution.value.ref, { kind: 'chat_turn', nodeId: 'node-1', turnId: 'turn-1' });
  });
});

describe('§6.1 row: waiting on permission / user input', () => {
  it('reports waiting and preserves the reason, no auto-approval', () => {
    const d = chatNodeToDescriptor(
      baseInput({
        observation: observation({ pendingInteraction: { waiting: true, reason: 'awaiting tool permission' } }),
      }),
    );
    assert.equal(d.activity, 'waiting');
    if (d.execution.status !== 'ready' || !d.execution.value) throw new Error('expected value');
    assert.equal(d.execution.value.status, 'waiting');
    assert.equal(d.execution.value.waitingReason, 'awaiting tool permission');
  });
});

describe('§6.1 row: cancel requested, not yet confirmed terminal', () => {
  it('reports cancelling before the 15s threshold, no CANCEL_TIMEOUT error', () => {
    const d = chatNodeToDescriptor(
      baseInput({
        observation: observation({ cancelRequestedAt: 9_000 }),
        observedAt: 20_000, // 11s elapsed, under 15s
      }),
    );
    assert.equal(d.activity, 'cancelling');
    if (d.execution.status !== 'ready' || !d.execution.value) throw new Error('expected value');
    assert.equal(d.execution.value.status, 'cancelling');
    assert.equal(d.execution.value.error, null);
  });

  it('flags CANCEL_TIMEOUT after 15s but keeps activity cancelling (never infers cancelled)', () => {
    const d = chatNodeToDescriptor(
      baseInput({
        observation: observation({ cancelRequestedAt: 1_000 }),
        observedAt: 1_000 + PANE_INSPECTION_LIMITS.cancelTimeoutMs + 1,
      }),
    );
    assert.equal(d.activity, 'cancelling');
    if (d.execution.status !== 'ready' || !d.execution.value) throw new Error('expected value');
    assert.equal(d.execution.value.status, 'cancelling');
    assert.deepEqual(d.execution.value.error, {
      code: 'CANCEL_TIMEOUT',
      message: 'Cancel was requested more than 15s ago and no authoritative terminal status has arrived yet.',
    });
  });
});

describe('§6.1 row: Chat durable turn completed/error/cancelled', () => {
  it('completed → idle, execution.status completed, bound to the specific turnId', () => {
    const d = chatNodeToDescriptor(
      baseInput({
        observation: observation({ durableStatus: 'completed', completedAt: 5_000 }),
        durableTurn: turnRow({ status: 'completed' }),
      }),
    );
    assert.equal(d.activity, 'idle');
    if (d.execution.status !== 'ready' || !d.execution.value) throw new Error('expected value');
    assert.equal(d.execution.value.status, 'completed');
    assert.equal(d.execution.value.commitState, 'committed');
    assert.deepEqual(d.execution.value.ref, { kind: 'chat_turn', nodeId: 'node-1', turnId: 'turn-1' });
  });

  it('error → idle, execution.status failed — idle never means success', () => {
    const d = chatNodeToDescriptor(
      baseInput({
        observation: observation({ durableStatus: 'error', error: 'boom', completedAt: 5_000 }),
        durableTurn: turnRow({ status: 'error', error: 'boom' }),
      }),
    );
    assert.equal(d.activity, 'idle');
    if (d.execution.status !== 'ready' || !d.execution.value) throw new Error('expected value');
    assert.equal(d.execution.value.status, 'failed');
    assert.deepEqual(d.execution.value.error, { code: 'TURN_ERROR', message: 'boom' });
  });

  it('cancelled → idle, execution.status cancelled', () => {
    const d = chatNodeToDescriptor(
      baseInput({
        observation: observation({ durableStatus: 'cancelled', completedAt: 5_000 }),
        durableTurn: turnRow({ status: 'cancelled' }),
      }),
    );
    assert.equal(d.activity, 'idle');
    if (d.execution.status !== 'ready' || !d.execution.value) throw new Error('expected value');
    assert.equal(d.execution.value.status, 'cancelled');
  });

  it('terminal in-memory but no matching committed durable row → commitState unknown, not failed', () => {
    const d = chatNodeToDescriptor(
      baseInput({
        observation: observation({ durableStatus: 'completed', completedAt: 5_000 }),
        durableTurn: null,
      }),
    );
    if (d.execution.status !== 'ready' || !d.execution.value) throw new Error('expected value');
    assert.equal(d.execution.value.commitState, 'unknown');
  });
});

describe('§6.1 row: Chat output cannot be committed (lastPersistenceError)', () => {
  it('reports unknown activity, failed execution, commitState failed — never success', () => {
    const d = chatNodeToDescriptor(
      baseInput({
        observation: observation({
          lastPersistenceError: { message: 'disk full', recoverable: false, occurredAt: 6_000 },
        }),
      }),
    );
    assert.equal(d.activity, 'unknown');
    if (d.execution.status !== 'ready' || !d.execution.value) throw new Error('expected value');
    assert.equal(d.execution.value.status, 'failed');
    assert.equal(d.execution.value.commitState, 'failed');
  });
});

// ---------------------------------------------------------------------------
// Additional acceptance bullets
// ---------------------------------------------------------------------------

describe('preview truncation on a multi-byte / emoji string', () => {
  it('truncates on a whole code-point boundary, never splitting a surrogate pair', () => {
    const emoji = '\u{1F600}'; // U+1F600, 4 UTF-8 bytes, surrogate pair in UTF-16
    const text = emoji.repeat(2000); // far larger than the 1 KiB limit
    const { text: out, truncated } = truncateTailToCodePointUtf8(text, PANE_INSPECTION_LIMITS.outputPreviewBytes);
    assert.equal(truncated, true);
    assert.ok(Buffer.byteLength(out, 'utf8') <= PANE_INSPECTION_LIMITS.outputPreviewBytes);
    // Every code point in the output must be a complete emoji — Array.from re-splits correctly
    // on code points, so every entry must equal the full emoji string, never half of it.
    for (const cp of Array.from(out)) assert.equal(cp, emoji);
  });

  it('end-to-end via chatNodeToDescriptor: latestOutput.truncated is true for an oversized answer', () => {
    const big = 'x'.repeat(PANE_INSPECTION_LIMITS.outputPreviewBytes + 500);
    const d = chatNodeToDescriptor(
      baseInput({
        observation: observation({
          durableStatus: 'active',
          snapshot: {
            ...observation().snapshot,
            assistantMessage: { ...observation().snapshot.assistantMessage, blocks: [answerBlock('b1', big)] },
          },
        }),
      }),
    );
    assert.equal(d.latestOutput.status, 'ready');
    if (d.latestOutput.status !== 'ready' || !d.latestOutput.value) throw new Error('expected value');
    assert.equal(d.latestOutput.value.truncated, true);
    assert.ok(Buffer.byteLength(d.latestOutput.value.text, 'utf8') <= PANE_INSPECTION_LIMITS.outputPreviewBytes);
  });
});

describe('sentinel stripping in the answer text', () => {
  it('a [TITLE: ...] sentinel does not appear in the preview', () => {
    const d = chatNodeToDescriptor(
      baseInput({
        observation: observation({
          durableStatus: 'active',
          snapshot: {
            ...observation().snapshot,
            assistantMessage: {
              ...observation().snapshot.assistantMessage,
              blocks: [answerBlock('b1', '[TITLE: My chat]\nHere is the answer body.')],
            },
          },
        }),
      }),
    );
    assert.equal(d.latestOutput.status, 'ready');
    if (d.latestOutput.status !== 'ready' || !d.latestOutput.value) throw new Error('expected value');
    assert.ok(!d.latestOutput.value.text.includes('[TITLE:'));
    assert.ok(d.latestOutput.value.text.includes('Here is the answer body.'));
  });
});

describe('Section states are never collapsed', () => {
  it('old-data-with-messages row keeps execution as a proper unknown Section with a reason', () => {
    const d = chatNodeToDescriptor(
      baseInput({ observation: null, durableTurn: null, counts: { total: 1, user: 1, assistant: 0 } }),
    );
    assert.equal(d.execution.status, 'unknown');
    if (d.execution.status === 'unknown') {
      assert.ok(d.execution.reason.length > 0);
    }
  });

  it('conversation / lineage / runtime sections are ready with their fetched values, never invented', () => {
    const d = chatNodeToDescriptor(
      baseInput({
        counts: { total: 3, user: 2, assistant: 1 },
        turns: { count: null, coverage: 'partial' },
      }),
    );
    assert.equal(d.conversation.status, 'ready');
    if (d.conversation.status === 'ready') {
      assert.equal(d.conversation.value.messageCount, 3);
      assert.equal(d.conversation.value.completedTurnCount, null);
      assert.equal(d.conversation.value.turnHistoryCoverage, 'partial');
    }
  });
});
