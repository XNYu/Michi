import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { applyTurnEvent, createDurableTurn, parseChatStreamEvent, type ChatStreamEvent, type DurableAssistantBlock } from 'michi-shared';
import { closeDb, initDb } from '../src/services/db';
import { listMessages, saveNode, saveWorkspace } from '../src/services/dbRepository';
import { registerSession, clearAllSessions } from '../src/agents/sessionRegistry';
import { chatHub } from '../src/agents/chatHub';
import { setupMichiRoutes } from '../src/routes/michi';
import type { ChatManager } from '../src/services/chatManager';
import type { AgentSession } from '../src/agents/types';

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error('Interaction did not become pending');
}

function parseSse(text: string): ChatStreamEvent[] {
  return text.split('\n\n').flatMap(frame => {
    const event = frame.match(/^event: (.+)$/m)?.[1];
    const data = frame.match(/^data: (.+)$/m)?.[1];
    const parsed = event && data ? parseChatStreamEvent(event, data) : null;
    return parsed ? [parsed] : [];
  });
}

test('real HTTP and SQLite retain consecutive answers/skip with stable IDs and delayed replay times', async (t) => {
  const originalDir = process.env.MICHI_DATA_DIR;
  const originalCloud = process.env.MICHI_CLOUD;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-protocol-http-'));
  process.env.MICHI_DATA_DIR = dir;
  process.env.MICHI_CLOUD = '1';
  closeDb(); initDb();
  saveWorkspace({ id: 'ws-protocol-http', name: 'Protocol HTTP', owner_user_id: 'alice', created_at: 1, updated_at: 1 });
  saveNode({ id: 'node-protocol-http', workspace_id: 'ws-protocol-http', kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 });
  let continueQuestion: (() => void) | undefined;
  const session: AgentSession = {
    id: 'node-protocol-http', runtimeId: 'claude', getHistory: () => [], getPendingAssistant: () => undefined,
    send: async function* () {
      yield { kind: 'tool_call', toolCallId: 'read-http', title: 'Read', status: 'in_progress' };
      await delay(20);
      yield { kind: 'tool_call_update', toolCallId: 'read-http', title: '', status: 'completed', output: 'ok' };
      for (const requestId of [11, 12]) {
        const resumed = new Promise<void>(resolve => { continueQuestion = resolve; });
        yield { kind: 'user_input_request', requestId, questions: [{ question: `Question ${requestId}?`, options: [{ label: 'Yes' }], multiSelect: false }] };
        await resumed;
        // Deliberately no runtime user_input_resolved: the HTTP receipt must
        // persist the response itself, independent of provider adapters.
      }
      yield { kind: 'usage_summary', charge: { amount: 0.0123, unit: 'USD', provenance: 'sdk_estimate' }, source: 'estimated' };
      yield { kind: 'warning', source: 'anthropic-api', category: 'provider', message: 'Provider retried once' };
      yield { kind: 'chunk', text: 'All done.' };
      yield { kind: 'turn_end', stopReason: 'end_turn' };
    },
    cancel: () => { continueQuestion?.(); },
    respondToUserInput: () => { continueQuestion?.(); },
    skipUserInput: () => { continueQuestion?.(); },
  };
  registerSession(session, 'alice');
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = { id: req.headers['x-user'] }; next(); });
  app.use('/api', setupMichiRoutes({} as ChatManager));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/chats/node-protocol-http`;
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    clearAllSessions(); closeDb(); fs.rmSync(dir, { recursive: true, force: true });
    if (originalDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = originalDir;
    if (originalCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = originalCloud;
  });
  const started = await chatHub.startTurn({ chatId: session.id, nodeId: session.id, text: 'Ask two questions', displayText: 'Ask two questions', session, turnId: 'protocol-http-turn', ownerUserId: 'alice' });
  const post = (body: unknown, user = 'alice') => fetch(`${base}/user-input-response`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user': user }, body: JSON.stringify(body) });
  await waitFor(() => chatHub.getPendingUserInput(session.id)?.requestId === 11);
  assert.equal((await post({ requestId: 11, answers: [{ question: 'Question 11?', answer: 'Yes' }] }, 'bob')).status, 404);
  assert.equal((await post({ requestId: 10, skip: true })).status, 409);
  assert.equal((await post({ requestId: 11, interactionId: 'stale-recreated-session', skip: true })).status, 409);
  const firstInteractionId = chatHub.getPendingUserInput(session.id)!.interactionId;
  assert.equal((await post({ requestId: 11, interactionId: firstInteractionId, answers: [{ question: 'Question 11?', answer: 'Yes' }] })).status, 200);
  await waitFor(() => chatHub.getPendingUserInput(session.id)?.requestId === 12);
  assert.equal((await post({ requestId: 11, skip: true })).status, 409, 'stale answer must not resolve the next question');
  assert.equal((await post({ requestId: 12, skip: true })).status, 200);
  await started.done;
  await delay(20); // Flush the deferred persistence checkpoints before reopening SQLite.
  const row = listMessages(session.id).find(message => message.role === 'assistant')!;
  const blocks = JSON.parse(row.blocks ?? '[]') as DurableAssistantBlock[];
  const interactions = blocks.flatMap(block => block.kind === 'user-input' && block.interaction ? [block.interaction] : []);
  assert.equal(interactions.length, 2);
  assert.notEqual(interactions[0].interactionId, interactions[1].interactionId);
  assert.equal(interactions[0].status, 'answered');
  assert.equal(interactions[1].status, 'skipped');
  assert.equal(interactions[0].answers[0].id, interactions[0].questions[0].id);
  assert.equal(interactions[0].answers[0].answer, 'Yes');
  assert.equal(JSON.parse(row.metadata ?? '{}').usageSummary.charge.unit, 'USD');
  assert.equal(JSON.parse(row.metadata ?? '{}').warnings[0].source, 'anthropic-api');
  const storedTools = JSON.parse(row.tool_calls ?? '[]');
  assert.ok(storedTools[0].endedAt - storedTools[0].startedAt >= 10);
  await delay(30);
  const replayResponse = await fetch(`${base}/stream?fromTurnId=protocol-http-turn&fromSeq=0`, { headers: { 'x-user': 'alice' } });
  assert.equal(replayResponse.status, 200);
  const events = parseSse(await replayResponse.text());
  assert.ok(events.every(event => Number.isFinite(event.data.observedAt)));
  const replay = events.reduce(applyTurnEvent, createDurableTurn({ turnId: started.turnId, assistantId: started.assistantId, nodeId: session.id, workspaceId: 'ws-protocol-http', displayUserText: 'Ask two questions', startedAt: 1 }));
  assert.deepEqual(replay.assistantMessage.blocks, blocks);
  assert.deepEqual(replay.assistantMessage.toolCalls, storedTools);
  assert.equal(events.at(-1)?.event, 'done');
  // Simulate an evicted memory ring and disposed provider session. The live
  // replay is gone; the stream says so instead of hanging.
  const noMemoryReplay = t.mock.method(chatHub, 'subscribeTurn', () => null);
  clearAllSessions();
  const goneResponse = await fetch(`${base}/stream?fromTurnId=protocol-http-turn&fromSeq=0`, { headers: { 'x-user': 'alice' } });
  assert.equal(goneResponse.status, 410);
  assert.equal((await goneResponse.json() as { code?: string }).code, 'turn_replay_unavailable');
  const forbidden = await fetch(`${base}/stream?fromTurnId=protocol-http-turn&fromSeq=0`, { headers: { 'x-user': 'bob' } });
  assert.equal(forbidden.status, 404);
  // The saved turn still answers from SQLite alone.
  const savedResponse = await fetch(`${base}/turns/protocol-http-turn`, { headers: { 'x-user': 'alice' } });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json() as { status: string; completedAt: number | null; lastSeq: number; message: { id: string; blocks: string } };
  assert.equal(saved.status, 'completed');
  assert.equal(typeof saved.completedAt, 'number');
  assert.equal(saved.lastSeq, events.at(-1)!.data.seq);
  assert.equal(saved.message.id, started.assistantId);
  assert.equal(saved.message.blocks, row.blocks);
  assert.equal((await fetch(`${base}/turns/protocol-http-turn`, { headers: { 'x-user': 'bob' } })).status, 404);
  noMemoryReplay.mock.restore();
  closeDb(); initDb();
  assert.equal(listMessages(session.id).find(message => message.role === 'assistant')?.blocks, row.blocks, 'SQLite reopen must retain both interactions');
});
