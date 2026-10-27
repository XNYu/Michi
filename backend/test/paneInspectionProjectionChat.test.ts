import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PANE_INSPECTION_LIMITS } from 'michi-shared';
import { chatNodeToDescriptor, type ChatNodeToDescriptorInput } from '../src/services/paneInspectionProjection.chat';
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

describe('§6.1 row: pending spawn prompt, turn not yet started', () => {
  it('reports queued / ready+null and does not invent a turnId', () => {
    const d = chatNodeToDescriptor(baseInput({ node: node({ spawned_by_agent: 1 }) }));
    assert.equal(d.activity, 'queued');
    assert.deepEqual(d.execution, { status: 'ready', value: null });
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
  it('exactly at the threshold does not flag CANCEL_TIMEOUT (strictly greater-than)', () => {
    const d = chatNodeToDescriptor(
      baseInput({
        observation: observation({ cancelRequestedAt: 1_000 }),
        observedAt: 1_000 + PANE_INSPECTION_LIMITS.cancelTimeoutMs,
      }),
    );
    if (d.execution.status !== 'ready' || !d.execution.value) throw new Error('expected value');
    assert.equal(d.execution.value.error, null);
  });
});

describe('§6.1 row: Chat durable turn completed/error/cancelled', () => {
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
