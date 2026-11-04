import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { parseChatStreamEvent, type ChatStreamEvent, type DurableAssistantBlock } from 'michi-shared';
import { closeDb, initDb } from '../src/services/db';
import { getNode, getWorkspace, getWorkspaceInstructions, listMessages, saveNode, saveWorkspace } from '../src/services/dbRepository';
import { clearAllSessions } from '../src/agents/sessionRegistry';
import { chatHub } from '../src/agents/chatHub';
import { setupMichiRoutes } from '../src/routes/michi';
import { PiRuntime } from '../src/agents/pi/PiRuntime';
import { loadPiAi } from '../src/agents/pi/piAi';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import type { ChatManager } from '../src/services/chatManager';
import { chatOwner } from './helpers/owners';

async function waitFor<T>(read: () => T | null | undefined, label: string): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const value = read();
    if (value) return value;
    await delay(5);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function parseSse(text: string): ChatStreamEvent[] {
  const complete = text.slice(0, text.lastIndexOf('\n\n') + 2);
  return complete.split('\n\n').flatMap(frame => {
    const event = frame.match(/^event: (.+)$/m)?.[1];
    const data = frame.match(/^data: (.+)$/m)?.[1];
    const parsed = event && data ? parseChatStreamEvent(event, data) : null;
    return parsed ? [parsed] : [];
  });
}

/** A renderer reconnecting after a refresh: replay the turn until a frame matches, then hang up. */
async function reconnect(url: string, headers: Record<string, string>, match: (event: ChatStreamEvent) => boolean) {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('replay ended before the expected frame');
      text += decoder.decode(value, { stream: true });
      const events = parseSse(text);
      if (events.some(match)) return events;
    }
  } finally { controller.abort(); }
}

type Step = 'ask' | 'reply' | 'summary' | 'final';

test('Pi ask_user survives a refresh, continues after the answer, cancels cleanly and /compact succeeds over HTTP', async (t) => {
  const originalDir = process.env.MICHI_DATA_DIR;
  const originalCloud = process.env.MICHI_CLOUD;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-pi-interactions-'));
  process.env.MICHI_DATA_DIR = dir;
  process.env.MICHI_CLOUD = '1';
  closeDb(); initDb();
  const workspaceId = 'ws-pi-interactions';
  const nodeId = 'node-pi-interactions';
  saveWorkspace({ id: workspaceId, name: 'Pi interactions', owner_user_id: 'alice', created_at: 1, updated_at: 1 });
  saveNode({ id: nodeId, workspace_id: workspaceId, kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 });
  configureRuntimeDeps({
    dataDir: dir,
    historyStore: { getNode, listMessages, getWorkspace, getWorkspaceInstructions },
    providerKeys: { getProviderApiKey: () => 'synthetic-host-key' },
    agentConfig: { getAgentConfig: () => ({ runtime: 'pi', provider: 'openai', modelByRuntime: {}, reasoningByRuntime: {} } as any),
      resolveModel: () => 'gpt-4.1-mini', resolveReasoning: () => undefined },
  });

  const ai: any = await loadPiAi();
  const model = ai.getModel('openai', 'gpt-4.1-mini');
  const steps: Step[] = [];
  const contexts: any[] = [];
  const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  t.mock.method(require('../src/agents/pi/piProviders'), 'resolvePiModel', async () => model);
  t.mock.method(require('../src/agents/pi/piAi'), 'loadPiAi', async () => ({ ...ai, streamSimple: (m: any, context: any) => {
    const step = steps.shift();
    assert(step, 'unexpected provider request');
    contexts.push({ step, context });
    const content: any[] = step === 'ask'
      ? [{ type: 'toolCall', id: `ask-${contexts.length}`, name: 'ask_user', arguments: { questions: [
        { question: 'Which color?', header: 'Color', options: [{ label: 'Blue' }, { label: 'Red' }] }] } }]
      : [{ type: 'text', text: step === 'summary' ? 'SYNTHETIC SUMMARY: the user chose teal.' : step === 'reply' ? 'Teal it is.' : 'Final answer.' }];
    const message: any = { role: 'assistant', api: m.api, provider: m.provider, model: m.id, content, usage,
      stopReason: step === 'ask' ? 'toolUse' : 'stop', timestamp: Date.now() };
    const stream = ai.createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: message });
      if (step !== 'ask') stream.push({ type: 'text_delta', delta: content[0].text, contentIndex: 0, partial: message });
      stream.push({ type: 'done', reason: message.stopReason, message });
    });
    return stream;
  } }));

  const runtime = new PiRuntime({ spawnBranches: async () => [], saveContext: () => null, updateContext: () => null });
  const session = await runtime.newSession({ sessionId: nodeId, owner: chatOwner(nodeId), ownerUserId: 'alice', workspaceId,
    cwd: dir, provider: 'openai', model: 'gpt-4.1-mini', enableFollowUps: false });
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = { id: req.headers['x-user'] }; next(); });
  app.use('/api', setupMichiRoutes({} as ChatManager));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/chats/${nodeId}`;
  const headers = { 'Content-Type': 'application/json', 'x-user': 'alice' };
  const post = (route: string, body: unknown) => fetch(`${base}/${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await runtime.shutdown(); clearAllSessions(); __resetRuntimeDeps(); closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
    if (originalDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = originalDir;
    if (originalCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = originalCloud;
  });

  // Turn 1: a long brief (so there is something to compact later), a question, a typed answer.
  steps.push('ask', 'reply');
  const brief = 'Project brief: ' + 'harmless context '.repeat(6000);
  const first = await chatHub.startTurn({ chatId: nodeId, nodeId, text: brief, displayText: 'Project brief', session, turnId: 'pi-ask-turn', ownerUserId: 'alice' });
  const pending = await waitFor(() => chatHub.getPendingUserInput(nodeId), 'pending question');
  assert.equal(pending.questions[0].question, 'Which color?');
  assert.deepEqual(pending.questions[0].options, [{ label: 'Blue' }, { label: 'Red' }]);

  // Refresh: the reconnecting renderer replays the same pending interaction.
  const replay = await reconnect(`${base}/stream?fromTurnId=pi-ask-turn&fromSeq=0`, { 'x-user': 'alice' },
    event => event.event === 'user_input_request');
  const replayed = replay.find(event => event.event === 'user_input_request');
  assert.equal(replayed?.event === 'user_input_request' && replayed.data.requestId, pending.requestId);
  assert.equal(replayed?.event === 'user_input_request' && replayed.data.interactionId, pending.interactionId);
  assert.equal(replay.some(event => event.event === 'permission_request'), false);

  const questionId = pending.questions[0].id;
  assert.equal((await post('user-input-response', { requestId: pending.requestId, interactionId: pending.interactionId,
    answers: [{ id: questionId, question: 'Which color?', answer: 'Teal (typed)' }] })).status, 200);
  await first.done;
  assert.equal(contexts[1].step, 'reply');
  const toolResult = contexts[1].context.messages.find((message: any) => message.role === 'toolResult');
  assert.deepEqual(JSON.parse(toolResult.content[0].text), { answers: { 'Which color?': 'Teal (typed)' } }, 'the model continues with the answer');
  await delay(20);
  const answered = listMessages(nodeId).filter(message => message.role === 'assistant').at(-1)!;
  assert.match(answered.content ?? '', /Teal it is\./);
  const firstBlocks = JSON.parse(answered.blocks ?? '[]') as DurableAssistantBlock[];
  const interaction = firstBlocks.flatMap(block => block.kind === 'user-input' && block.interaction ? [block.interaction] : [])[0];
  assert.equal(interaction.status, 'answered');
  assert.equal(interaction.answers[0].answer, 'Teal (typed)');

  // Turn 2: compaction is refused while a question waits; cancel then closes the question.
  // Its long prompt becomes the recent tail the SDK keeps; the brief is summarized.
  steps.push('ask');
  const second = await chatHub.startTurn({ chatId: nodeId, nodeId, text: 'Ask again: ' + 'more context '.repeat(8000),
    displayText: 'Ask again', session, turnId: 'pi-cancel-turn', ownerUserId: 'alice' });
  const waiting = await waitFor(() => chatHub.getPendingUserInput(nodeId), 'second question');
  const busy = await post('compact', {});
  assert.equal(busy.status, 409);
  assert.equal(((await busy.json()) as { started: boolean }).started, false);
  assert.equal((await post('cancel', { turnId: 'pi-cancel-turn' })).status, 200);
  await second.done;
  assert.equal(chatHub.getPendingUserInput(nodeId), null);
  assert.equal((await post('user-input-response', { requestId: waiting.requestId, answers: [{ question: 'Which color?', answer: 'late' }] })).status, 409);
  assert.equal(steps.length, 0, 'no provider request after the cancelled question');
  await delay(20);
  const cancelled = JSON.parse(listMessages(nodeId).filter(message => message.role === 'assistant').at(-1)!.blocks ?? '[]') as DurableAssistantBlock[];
  assert.equal(cancelled.find(block => block.kind === 'user-input')?.kind === 'user-input'
    && (cancelled.find(block => block.kind === 'user-input') as any).interaction.status, 'interrupted');

  // Idle /compact through ChatHub and the SDK, then a turn that starts from the summary.
  steps.push('summary');
  const compacted = await post('compact', { instructions: 'Keep the color decision' });
  const result = await compacted.json() as { started: boolean; completed?: boolean; detail?: string };
  assert.equal(compacted.status, 200, JSON.stringify(result));
  assert.equal(result.started, true);
  assert.equal(result.completed, true);
  assert.match(result.detail ?? '', /^Compacted the conversation/);
  assert(JSON.stringify(contexts.at(-1).context).includes('Keep the color decision'));
  steps.push('final');
  const third = await chatHub.startTurn({ chatId: nodeId, nodeId, text: 'Continue', displayText: 'Continue', session, turnId: 'pi-after-compact', ownerUserId: 'alice' });
  await third.done;
  const after = JSON.stringify(contexts.at(-1).context.messages);
  assert(after.includes('SYNTHETIC SUMMARY'));
  assert.equal(after.includes('Project brief'), false, 'the compacted brief left the model context');
});
