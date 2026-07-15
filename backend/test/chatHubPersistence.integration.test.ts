import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ChatStreamEvent } from 'michi-shared';
import { ChatHub } from '../src/agents/chatHub';
import type { AgentSession } from '../src/agents/types';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { closeDb, initDb } from '../src/services/db';
import { getNode, listMessages, saveNode, saveTree, saveWorkspace } from '../src/services/dbRepository';

function iterator(events: NormalizedEvent[]): AsyncIterableIterator<NormalizedEvent> {
  let index = 0;
  return {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      return index < events.length
        ? { done: false, value: events[index++] }
        : { done: true, value: undefined };
    },
  };
}

describe('ChatHub authoritative persistence integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-chat-hub-persist-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
    saveWorkspace({ id: 'ws-1', name: 'Workspace', created_at: 1, updated_at: 1, active_tree_id: 'tree-1' });
    saveTree({ id: 'tree-1', workspace_id: 'ws-1', root_node_id: 'node-1', last_active_at: 1, created_at: 1 });
    saveNode({
      id: 'node-1', workspace_id: 'ws-1', tree_id: 'tree-1', parent_node_id: null,
      kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1,
    });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('persists the full projected turn even after the only subscriber disconnects', async () => {
    let wirePrompt = '';
    const session: AgentSession = {
      id: 'chat-1', runtimeId: 'kiro', getHistory: () => [], getPendingAssistant: () => undefined,
      send: (prompt) => {
        wirePrompt = prompt;
        return iterator([
          { kind: 'thought', text: 'thinking' },
          { kind: 'tool_call', toolCallId: 'tool-1', title: 'Read', status: 'running' },
          { kind: 'chunk', text: 'answer' },
          { kind: 'plan', entries: [{ content: 'persist', priority: 'high', status: 'completed' }] },
          { kind: 'tool_call_update', toolCallId: 'tool-1', title: '', status: 'completed', output: 'ok' },
          { kind: 'title', title: 'Durable title' },
          { kind: 'follow_ups', followUps: ['Next?'] },
          { kind: 'turn_end', stopReason: 'end_turn' },
        ]);
      },
      cancel: () => {},
    };
    const hub = new ChatHub({ retentionMs: 100 });
    const received: ChatStreamEvent[] = [];
    const detach = hub.subscribe('chat-1', { send: (event) => received.push(event), close: () => {} });
    const started = hub.startTurn({
      chatId: 'chat-1', nodeId: 'node-1', text: 'wire with injected context',
      displayText: 'visible user text', userMetadata: { quotedText: 'quote' }, session,
      turnId: 'turn-1',
    });
    detach();
    await started.done;

    assert.equal(wirePrompt, 'wire with injected context');
    const messages = listMessages('node-1');
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.content, 'visible user text');
    assert.equal(JSON.parse(messages[0]?.metadata ?? '{}').quotedText, 'quote');
    assert.equal(messages[1]?.content, 'answer');
    assert.equal(JSON.parse(messages[1]?.blocks ?? '[]').some((block: { kind: string }) => block.kind === 'thinking'), true);
    assert.equal(JSON.parse(messages[1]?.tool_calls ?? '[]')[0].output, 'ok');
    assert.deepEqual(JSON.parse(messages[1]?.metadata ?? '{}').plan, [
      { content: 'persist', priority: 'high', status: 'completed' },
    ]);
    assert.equal(getNode('node-1')?.title, 'Durable title');
    assert.deepEqual(JSON.parse(getNode('node-1')?.follow_ups ?? '[]'), ['Next?']);

    // Subscriber disconnected before terminal, so it never saw done; the DB
    // still completed and a late replay can observe the truthful boundary.
    assert.equal(received.some((event) => event.event === 'done'), false);
    const replay: ChatStreamEvent[] = [];
    hub.subscribe('chat-1', { send: (event) => replay.push(event), close: () => {} });
    const terminal = replay.find((event) => event.event === 'done');
    assert.equal(terminal?.data.persisted, true);
  });

  test('finalizes ten branches concurrently without cross-node metadata loss', async () => {
    for (let index = 2; index <= 10; index += 1) {
      saveNode({
        id: `node-${index}`, workspace_id: 'ws-1', tree_id: 'tree-1', parent_node_id: 'node-1',
        kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: index,
      });
    }
    const hub = new ChatHub({ retentionMs: 100 });
    const turns = Array.from({ length: 10 }, (_, offset) => {
      const index = offset + 1;
      const session: AgentSession = {
        id: `chat-${index}`, runtimeId: 'kiro', getHistory: () => [], getPendingAssistant: () => undefined,
        send: () => iterator([
          { kind: 'chunk', text: `answer-${index}` },
          { kind: 'title', title: `Title ${index}` },
          { kind: 'follow_ups', followUps: [`Next ${index}?`] },
          { kind: 'turn_end', stopReason: 'end_turn' },
        ]),
        cancel: () => {},
      };
      return hub.startTurn({
        chatId: `chat-${index}`, nodeId: `node-${index}`,
        text: `wire-${index}`, displayText: `user-${index}`,
        session, turnId: `turn-${index}`,
      }).done;
    });
    await Promise.all(turns);

    for (let index = 1; index <= 10; index += 1) {
      const messages = listMessages(`node-${index}`);
      assert.deepEqual(messages.map((message) => message.content), [`user-${index}`, `answer-${index}`]);
      const row = getNode(`node-${index}`);
      assert.equal(row?.title, `Title ${index}`);
      assert.deepEqual(JSON.parse(row?.follow_ups ?? '[]'), [`Next ${index}?`]);
    }
  });
});
