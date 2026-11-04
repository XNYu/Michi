// Long Pi tasks over the real chat routes, ChatHub, Pi SDK session and SQLite
// with a scripted model: a renderer that drops and reattaches mid-turn, and
// the 409 turn_active retry that may resend a turn ID only while that turn
// provably never began.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { parseChatStreamEvent, type ChatStreamEvent } from 'michi-shared';
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

interface Step { label: string; text?: string; askUser?: string; hold?: Promise<void> }

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

async function waitFor<T>(read: () => T | null | undefined | false, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(5);
  }
}

const seqOf = (event: ChatStreamEvent) => (event.data as { seq?: number }).seq;

/** A renderer's SSE connection; abort() is the renderer going away. */
function connection(response: Response, controller: AbortController) {
  assert.equal(response.status, 200);
  const events: ChatStreamEvent[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const name = frame.match(/^event: (.+)$/m)?.[1];
          const data = frame.match(/^data: (.+)$/m)?.[1];
          const parsed = name && data ? parseChatStreamEvent(name, data) : null;
          if (parsed) events.push(parsed);
        }
      }
    } catch { /* the renderer hung up */ } finally { ended = true; }
  })();
  return {
    events,
    ended: () => ended,
    until: (match: (event: ChatStreamEvent) => boolean, label: string) => waitFor(() => events.find(match), label),
    hangUp: () => controller.abort(),
  };
}

describe('Pi long tasks over the chat routes', () => {
  const originalDir = process.env.MICHI_DATA_DIR;
  const originalCloud = process.env.MICHI_CLOUD;
  const workspaceId = 'ws-long-task-http';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-pi-long-task-http-'));
  const script: Step[] = [];
  const requests: Array<{ label: string; context: any }> = [];
  const unexpected: string[] = [];
  const restores: Array<() => void> = [];
  let runtime: PiRuntime;
  let server: Server;
  let api: string;
  const headers = { 'Content-Type': 'application/json', 'x-user': 'alice' };

  function patch(modulePath: string, key: string, value: unknown) {
    const mod = require(modulePath);
    const original = mod[key];
    mod[key] = value;
    restores.push(() => { mod[key] = original; });
  }

  async function chat(nodeId: string) {
    saveNode({ id: nodeId, workspace_id: workspaceId, kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: Date.now() });
    await runtime.newSession({ sessionId: nodeId, owner: chatOwner(nodeId), ownerUserId: 'alice', workspaceId,
      cwd: dir, provider: 'openai', model: 'gpt-4.1-mini', enableFollowUps: false });
  }

  const post = (nodeId: string, route: string, body: unknown, signal?: AbortSignal) =>
    fetch(`${api}/chats/${nodeId}/${route}`, { method: 'POST', headers, body: JSON.stringify(body), signal });

  /** POST a message and attach to its stream. */
  async function send(nodeId: string, turnId: string, text: string) {
    const controller = new AbortController();
    const response = await post(nodeId, 'message', { text, turnId }, controller.signal);
    return { response, open: () => connection(response, controller) };
  }

  /** The renderer's own handoff: the same request, repeated while the answer is 409 turn_active. */
  async function sendWhenFree(nodeId: string, turnId: string, text: string) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const sent = await send(nodeId, turnId, text);
      if (sent.response.status !== 409) return sent;
      const body = await sent.response.clone().json() as { code?: string };
      if (body.code !== 'turn_active') return sent;
      await sent.response.body?.cancel().catch(() => {});
      await delay(10);
    }
    throw new Error('the chat stayed busy');
  }

  function reattach(nodeId: string, turnId: string, fromSeq: number) {
    const controller = new AbortController();
    return fetch(`${api}/chats/${nodeId}/stream?fromTurnId=${turnId}&fromSeq=${fromSeq}`, { headers: { 'x-user': 'alice' }, signal: controller.signal })
      .then((response) => connection(response, controller));
  }

  before(async () => {
    process.env.MICHI_DATA_DIR = dir;
    process.env.MICHI_CLOUD = '1';
    closeDb(); initDb();
    saveWorkspace({ id: workspaceId, name: 'Long tasks', owner_user_id: 'alice', created_at: 1, updated_at: 1 });
    configureRuntimeDeps({
      dataDir: dir,
      historyStore: { getNode, listMessages, getWorkspace, getWorkspaceInstructions },
      providerKeys: { getProviderApiKey: () => 'synthetic-host-key' },
      agentConfig: { getAgentConfig: () => ({ runtime: 'pi', provider: 'openai', modelByRuntime: {}, reasoningByRuntime: {} } as any),
        resolveModel: () => 'gpt-4.1-mini', resolveReasoning: () => undefined },
    });
    const ai: any = await loadPiAi();
    const model = ai.getModel('openai', 'gpt-4.1-mini');
    const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    patch(require.resolve('../src/agents/pi/piProviders'), 'resolvePiModel', async () => model);
    patch(require.resolve('../src/agents/pi/piAi'), 'loadPiAi', async () => ({ ...ai, streamSimple: (m: any, context: any, opts: any) => {
      const stream = ai.createAssistantMessageEventStream();
      const step = script.shift();
      const base = { role: 'assistant', api: m.api, provider: m.provider, model: m.id, usage, timestamp: Date.now() };
      if (!step) {
        const last = context.messages.at(-1);
        unexpected.push(JSON.stringify(last?.content ?? '').slice(0, 80));
        queueMicrotask(() => stream.push({ type: 'error', reason: 'error',
          error: { ...base, content: [], stopReason: 'error', errorMessage: 'unexpected provider request' } }));
        return stream;
      }
      requests.push({ label: step.label, context });
      const message: any = { ...base,
        content: [...(step.text ? [{ type: 'text', text: step.text }] : []),
          ...(step.askUser ? [{ type: 'toolCall', id: `ask-${requests.length}`, name: 'ask_user',
            arguments: { questions: [{ question: step.askUser, header: 'Choice', options: [{ label: 'Yes' }, { label: 'No' }] }] } }] : [])],
        stopReason: step.askUser ? 'toolUse' : 'stop' };
      void (async () => {
        await Promise.resolve();
        stream.push({ type: 'start', partial: message });
        if (step.text) stream.push({ type: 'text_delta', delta: step.text, contentIndex: 0, partial: message });
        if (step.hold) {
          await Promise.race([step.hold, new Promise<void>((resolve) => {
            if (opts?.signal?.aborted) resolve();
            opts?.signal?.addEventListener('abort', () => resolve(), { once: true });
          })]);
        }
        if (opts?.signal?.aborted) {
          stream.push({ type: 'error', reason: 'aborted', error: { ...message, stopReason: 'aborted' } });
          return;
        }
        stream.push({ type: 'done', reason: message.stopReason, message });
      })();
      return stream;
    } }));
    runtime = new PiRuntime({ spawnBranches: async () => [], saveContext: () => null, updateContext: () => null });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { (req as any).user = { id: req.headers['x-user'] }; next(); });
    app.use('/api', setupMichiRoutes({} as ChatManager));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.shutdown(); clearAllSessions(); __resetRuntimeDeps();
    while (restores.length > 0) restores.pop()!();
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
    if (originalDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = originalDir;
    if (originalCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = originalCloud;
  });

  test('a renderer that drops mid-turn leaves the turn running and reattaches from its watermark without gaps or duplicates', async () => {
    const nodeId = 'reconnect-node';
    const turnId = 'reconnect-1';
    await chat(nodeId);
    const working = gate();
    script.push(
      { label: 'reconnect/one', text: 'PART-ONE. ', askUser: 'Publish now?', hold: working.promise },
      { label: 'reconnect/two', text: 'PART-TWO after the answer.' },
    );
    const sent = await send(nodeId, turnId, 'Do the long task');
    const first = sent.open();
    await first.until((event) => event.event === 'chunk', 'the first chunk');
    first.hangUp();
    await waitFor(() => first.ended(), 'the first connection to close');
    const watermark = Math.max(...first.events.map(seqOf).filter((seq): seq is number => typeof seq === 'number'));

    // Disconnection is not cancellation: the durable turn keeps working and asks its question.
    await delay(50);
    assert.equal(chatHub.isActive(nodeId), true, 'the turn outlives its renderer');
    working.open();
    const pending = await waitFor(() => chatHub.getPendingUserInput(nodeId), 'the question asked while detached');

    // Reattach from the watermark: the next frames in order, the question included.
    const second = await reattach(nodeId, turnId, watermark + 1);
    const question = await second.until((event) => event.event === 'user_input_request', 'the replayed question');
    assert.equal(question.event === 'user_input_request' && question.data.requestId, pending.requestId);
    second.hangUp();
    await waitFor(() => second.ended(), 'the second connection to close');
    const secondSeqs = second.events.map(seqOf);
    assert.equal(secondSeqs[0], watermark + 1, 'replay resumes right after the watermark');
    const watermark2 = secondSeqs.at(-1)!;

    // A refreshed renderer whose cursor is already past the question still gets it back.
    const recovered: ChatStreamEvent[] = [];
    const detach = chatHub.subscribeBackground({ includeForeground: true, ownerUserId: 'alice',
      send: (_chatId: string, event: ChatStreamEvent) => { recovered.push(event); }, close: () => {} },
    { cursors: { [nodeId]: { turnId, seq: watermark2 } } });
    detach();
    const restored = recovered.find((event) => event.event === 'user_input_request');
    assert.equal(restored?.event === 'user_input_request' && restored.data.requestId, pending.requestId,
      'the pending question replays after a refresh');
    assert.equal(seqOf(restored!), undefined, 'the recovery frame does not move the watermark');

    const answered = await post(nodeId, 'user-input-response', { requestId: pending.requestId, interactionId: pending.interactionId,
      answers: [{ id: pending.questions[0].id, question: 'Publish now?', answer: 'Yes' }] });
    assert.equal(answered.status, 200);
    await waitFor(() => !chatHub.isActive(nodeId), 'the turn to finish');

    const third = await reattach(nodeId, turnId, watermark2 + 1);
    await third.until((event) => event.event === 'done', 'the terminal frame');
    await waitFor(() => third.ended(), 'the replay to end');
    const all = [...first.events, ...second.events, ...third.events].map(seqOf);
    assert.deepEqual(all, all.map((_, index) => index), 'every frame arrives exactly once, in order');

    const answer = listMessages(nodeId).find((row) => row.id === `a-${nodeId}-${turnId}`);
    assert.match(answer?.content ?? '', /PART-ONE\.[\s\S]*PART-TWO after the answer\./);
    const toolResult = requests.find((request) => request.label === 'reconnect/two')!.context.messages
      .find((message: any) => message.role === 'toolResult' && message.toolName === 'ask_user');
    assert.match(JSON.stringify(toolResult.content), /Yes/, 'the model continues with the answer given after reattaching');
    assert.deepEqual(unexpected, []);
  });

  test('409 turn_active is resent with the same turn ID only while that turn never began', async () => {
    const nodeId = 'busy-node';
    await chat(nodeId);
    const working = gate();
    script.push({ label: 'busy/first', text: 'FIRST ', hold: working.promise });
    const first = (await send(nodeId, 'busy-1', 'First task')).open();
    await first.until((event) => event.event === 'chunk', 'the first turn to stream');
    const requestCount = requests.length;

    // A send while the chat is busy is refused before anything is stored or sent to the model.
    const busy = await send(nodeId, 'busy-2', 'Second task');
    assert.equal(busy.response.status, 409);
    assert.equal(((await busy.response.json()) as { code?: string }).code, 'turn_active');
    assert.equal(chatHub.requestedTurnStatus('busy-2'), null, 'no receipt for the refused turn');
    assert.equal(listMessages(nodeId).some((row) => row.content === 'Second task'), false);
    assert.equal(requests.length, requestCount, 'the model was not called');

    // Stopping the refused send must not stop the running turn.
    assert.equal((await post(nodeId, 'cancel', { turnId: 'busy-2' })).status, 200);
    await delay(30);
    assert.equal(chatHub.isActive(nodeId), true);
    assert.equal(first.events.some((event) => event.event === 'cancel_phase'), false, 'the first turn saw no cancellation');

    // The silent retry: the same turn ID, repeated while busy, runs once when the chat frees up.
    script.push({ label: 'busy/third', text: 'THIRD ANSWER' });
    const retry = sendWhenFree(nodeId, 'busy-3', 'Third task');
    await delay(50);
    working.open();
    await first.until((event) => event.event === 'done', 'the first turn to finish');
    const third = (await retry).open();
    await third.until((event) => event.event === 'done', 'the retried turn to finish');
    assert.equal(requests.filter((request) => request.label === 'busy/third').length, 1);
    assert.equal(chatHub.requestedTurnStatus('busy-3'), 'completed');

    // A retry the user stopped while it waited never starts.
    const stopped = await sendWhenFree(nodeId, 'busy-2', 'Second task');
    assert.equal(stopped.response.status, 409);
    assert.equal(((await stopped.response.json()) as { code?: string }).code, 'turn_begin_failed');
    assert.equal(chatHub.requestedTurnStatus('busy-2'), null);

    // Resending a turn that already ran never runs it again or replaces its answer.
    const before = listMessages(nodeId);
    const duplicate = await sendWhenFree(nodeId, 'busy-3', 'Third task');
    assert.equal(duplicate.response.status, 409, 'a turn ID that has a receipt is not run again');
    assert.equal(((await duplicate.response.json()) as { code?: string }).code, 'turn_begin_failed');
    assert.equal(requests.filter((request) => request.label === 'busy/third').length, 1);
    assert.deepEqual(listMessages(nodeId), before, 'the saved turn is unchanged');
    assert.deepEqual(unexpected, [], 'no extra model request was made');
  });
});
