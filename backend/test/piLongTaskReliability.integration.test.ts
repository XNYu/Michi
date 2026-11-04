// Long Pi tasks across interruptions, against the real Pi SDK session, ChatHub
// and SQLite with a scripted model (no provider calls): stop then continue,
// close and reopen (session release and a crash mid-tool), compaction mid
// session (manual and automatic), and tool calls whose outcome is unknown.
// Disconnect/reconnect replay and the 409 turn_active retry are covered over
// HTTP in piLongTaskReliability.http.integration.test.ts.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import type { ChatStreamEvent, DurableToolCall, PlanEntry } from 'michi-shared';
import { ChatHub } from '../src/agents/chatHub';
import { PiRuntime } from '../src/agents/pi/PiRuntime';
import { loadPiAi } from '../src/agents/pi/piAi';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { clearAllSessions } from '../src/agents/sessionRegistry';
import type { AgentSession } from '../src/agents/types';
import { piSdkSessionDirectory } from '../src/agents/pi/piSdkHarness';
import { closeDb, getDb, initDb } from '../src/services/db';
import {
  getNode, getWorkspace, getWorkspaceInstructions, listMessages, recoverInterruptedTurns, saveMessage, saveNode, saveTree, saveWorkspace,
} from '../src/services/dbRepository';
import { sessionPlanSnapshot } from '../src/services/planSnapshot';
import { chatOwner } from './helpers/owners';

type ToolCall = { name: string; arguments: Record<string, unknown> };
/** One scripted model response. */
interface Step {
  label: string;
  text?: string;
  tools?: ToolCall[];
  /** Prompt tokens the response reports; drives the SDK's threshold compaction. */
  inputTokens?: number;
  /** Keep the response open after its text until this settles or the request is aborted. */
  hold?: Promise<void>;
}
interface Request { label: string; messages: any[] }

const nativeImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;
const entry = (content: string, status: PlanEntry['status']): PlanEntry => ({ content, priority: 'medium', status });
const todo = (args: Record<string, unknown>): ToolCall => ({ name: 'todo', arguments: { __tool_use_purpose: 'Track the work', ...args } });
const bash = (command: string): ToolCall => ({ name: 'bash', arguments: { __tool_use_purpose: 'Run it', command } });
/** About 25k tokens by the SDK's chars/4 estimate, above its 20k keep-recent window. */
const bulk = (marker: string) => `${marker} ` + 'harmless context '.repeat(6000);

async function waitFor<T>(read: () => T | null | undefined | false, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(10);
  }
}

function text(message: any): string {
  return typeof message.content === 'string' ? message.content
    : (message.content ?? []).map((block: any) => block.text ?? block.thinking ?? '').join('');
}

describe('Pi long tasks survive stops, restarts and compaction', () => {
  let dir: string;
  let work: string;
  let ai: any;
  let baseModel: any;
  let contextWindow = 1_000_000;
  let transformMessages: (messages: any[], model: any) => any[];
  const script: Step[] = [];
  const requests: Request[] = [];
  const unexpected: string[] = [];
  const restores: Array<() => void> = [];
  const runtimes: PiRuntime[] = [];
  const oldDataDir = process.env.MICHI_DATA_DIR;

  function patch(modulePath: string, key: string, value: unknown) {
    const mod = require(modulePath);
    const original = mod[key];
    mod[key] = value;
    restores.push(() => { mod[key] = original; });
  }

  function chatNode(id: string) {
    saveNode({ id, workspace_id: 'ws-1', tree_id: 'tree-1', parent_node_id: null,
      kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: Date.now() });
  }

  const allowTools = { requestPermission: async () => 'allow_once' as const };
  function options(nodeId: string) {
    return { sessionId: nodeId, owner: chatOwner(nodeId), ownerUserId: null, workspaceId: 'ws-1', cwd: work,
      provider: 'openai', model: 'gpt-4.1-mini', enableFollowUps: false, permissionBroker: allowTools };
  }

  /** A fresh backend: its own runtime and ChatHub over the same SQLite and Pi session files. */
  function backend() {
    const runtime = new PiRuntime({ spawnBranches: async () => [], saveContext: () => null, updateContext: () => null });
    runtimes.push(runtime);
    return { runtime, hub: new ChatHub({ retentionMs: 60_000, titleGenerator: null, pageManifestBuilder: () => '' }) };
  }

  /** Start a turn and collect the frames a subscriber sees for it. */
  async function start(hub: ChatHub, session: AgentSession, turnId: string, steps: Step[], userText = `run ${turnId}`) {
    script.push(...steps);
    const received: ChatStreamEvent[] = [];
    const detach = hub.subscribe(session.id, { send: (event) => received.push(event), close: () => {} });
    const started = await hub.startTurn({ chatId: session.id, nodeId: session.id, text: userText, session, turnId });
    const events = () => {
      const first = received.findIndex((event) => event.event === 'turn_start' && event.data.turnId === turnId);
      return first < 0 ? [] : received.slice(first);
    };
    return { started, events, done: started.done.then(() => { detach(); return events(); }) };
  }

  async function turn(hub: ChatHub, session: AgentSession, turnId: string, steps: Step[], userText?: string) {
    const events = await (await start(hub, session, turnId, steps, userText)).done;
    assert.equal(script.length, 0, `${turnId}: the model consumed its whole script`);
    return events;
  }

  /** What the provider receives for a request: pi-ai drops aborted replies and fills tool results. */
  const seen = (request: Request) => transformMessages(request.messages, baseModel);
  const requestFor = (label: string) => {
    const request = requests.find((candidate) => candidate.label === label);
    assert.ok(request, `${label} reached the model`);
    return request;
  };
  const toolResult = (messages: any[], toolName: string) => messages.filter((message) => message.role === 'toolResult' && message.toolName === toolName);
  const plans = (events: ChatStreamEvent[]) => events
    .filter((event): event is Extract<ChatStreamEvent, { event: 'plan' }> => event.event === 'plan')
    .map((event) => event.data.entries);
  const assistantRow = (nodeId: string, turnId: string) => listMessages(nodeId).find((row) => row.id === `a-${nodeId}-${turnId}`);
  const storedTools = (nodeId: string, turnId: string) => JSON.parse(assistantRow(nodeId, turnId)?.tool_calls ?? '[]') as DurableToolCall[];

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-pi-long-task-'));
    work = path.join(dir, 'work');
    fs.mkdirSync(work, { recursive: true });
    process.env.MICHI_DATA_DIR = dir;
    closeDb();
    initDb();
    saveWorkspace({ id: 'ws-1', name: 'Workspace', created_at: 1, updated_at: 1, active_tree_id: 'tree-1' });
    saveTree({ id: 'tree-1', workspace_id: 'ws-1', root_node_id: 'stop-node', last_active_at: 1, created_at: 1 });
    configureRuntimeDeps({
      dataDir: dir,
      historyStore: { getNode, listMessages, getWorkspace, getWorkspaceInstructions, getPlanSnapshot: sessionPlanSnapshot },
      providerKeys: { getProviderApiKey: () => 'synthetic-key' },
      agentConfig: { getAgentConfig: () => ({ runtime: 'pi', provider: 'openai', modelByRuntime: {}, reasoningByRuntime: {} }),
        resolveModel: () => 'gpt-4.1-mini', resolveReasoning: () => undefined },
    });
    ai = await loadPiAi();
    baseModel = ai.getModel('openai', 'gpt-4.1-mini');
    transformMessages = (await nativeImport(pathToFileURL(path.resolve(__dirname,
      '../../node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js')).href)).transformMessages;
    patch(require.resolve('../src/services/piMcpConfig'), 'readPiMcpServers', () => []);
    patch(require.resolve('../src/agents/pi/piProviders'), 'resolvePiModel', async () => ({ ...baseModel, contextWindow }));
    let calls = 0;
    patch(require.resolve('../src/agents/pi/piAi'), 'loadPiAi', async () => ({ ...ai, streamSimple: (model: any, context: any, opts: any) => {
      const stream = ai.createAssistantMessageEventStream();
      const step = script.shift();
      const usage = { input: step?.inputTokens ?? 10, output: 10, cacheRead: 0, cacheWrite: 0,
        totalTokens: (step?.inputTokens ?? 10) + 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      const base = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now() };
      if (!step) {
        unexpected.push(text(context.messages.at(-1) ?? {}).slice(0, 80));
        queueMicrotask(() => stream.push({ type: 'error', reason: 'error',
          error: { ...base, content: [], stopReason: 'error', errorMessage: 'unexpected provider request' } }));
        return stream;
      }
      requests.push({ label: step.label, messages: JSON.parse(JSON.stringify(context.messages)) });
      calls += 1;
      const tools = step.tools ?? [];
      const message: any = { ...base,
        content: [...(step.text ? [{ type: 'text', text: step.text }] : []),
          ...tools.map((call, index) => ({ type: 'toolCall', id: `call-${calls}-${index}`, name: call.name, arguments: call.arguments }))],
        stopReason: tools.length > 0 ? 'toolUse' : 'stop' };
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
  });

  after(async () => {
    for (const runtime of runtimes) await runtime.shutdown().catch(() => {});
    clearAllSessions();
    __resetRuntimeDeps();
    while (restores.length > 0) restores.pop()!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
    if (oldDataDir === undefined) delete process.env.MICHI_DATA_DIR;
    else process.env.MICHI_DATA_DIR = oldDataDir;
  });

  test('stop mid tool call, then continue: context is intact, nothing leaks and the plan carries on', async () => {
    chatNode('stop-node');
    const { runtime, hub } = backend();
    const session = await runtime.newSession(options('stop-node'));
    const log = path.join(work, 'stop-runs.log');

    // Turn 1: plan two items, then start a slow command and press Stop while it runs.
    const first = await start(hub, session, 'stop-1', [
      { label: 'stop-1/plan', tools: [todo({ action: 'add', items: [{ content: 'Prepare' }, { content: 'Ship' }] })] },
      { label: 'stop-1/run', tools: [bash(`echo started >> ${log}; sleep 30; echo finished >> ${log}`)] },
    ]);
    await waitFor(() => fs.existsSync(log), 'the command to start');
    assert.equal(hub.cancel('stop-node', 'stop-1'), true);
    const stopped = await first.done;
    assert.equal(stopped.at(-1)?.event, 'done');
    assert.equal((stopped.at(-1)?.data as { stopReason?: string }).stopReason, 'cancelled');
    assert.equal(fs.readFileSync(log, 'utf8'), 'started\n', 'Stop killed the command; it was not completed or repeated');
    assert.equal(storedTools('stop-node', 'stop-1').find((tool) => tool.title === 'bash')?.status, 'interrupted');
    assert.deepEqual(plans(stopped), [[entry('Prepare', 'pending'), entry('Ship', 'pending')]]);

    // Turn 2 continues from the cancelled turn with its tool history.
    const second = await turn(hub, session, 'stop-2', [
      { label: 'stop-2/continue', tools: [todo({ action: 'update', id: 1, status: 'completed' })] },
      { label: 'stop-2/answer', text: 'Prepared; the command was interrupted, so I will check before rerunning it.' },
    ], 'Please continue');
    const context = seen(requestFor('stop-2/continue'));
    assert.match(text(context.find((message) => message.role === 'user')), /run stop-1/);
    assert.equal(toolResult(context, 'todo').length, 1, 'the completed todo call stays in context');
    const interrupted = toolResult(context, 'bash');
    assert.equal(interrupted.length, 1);
    assert.equal(interrupted[0].isError, true);
    assert.match(text(interrupted[0]), /outcome is unknown/i, 'the model is told the stopped command may have taken effect');
    assert.equal(context.some((message) => message.role === 'assistant' && message.stopReason === 'aborted'), false);
    assert.equal(text(context.at(-1)), 'Please continue');
    assert.deepEqual(plans(second), [[entry('Prepare', 'completed'), entry('Ship', 'pending')]], 'the plan continues from turn 1');
    assert.equal(fs.readFileSync(log, 'utf8'), 'started\n', 'continuing never reran the stopped command');

    // Turn 3 is stopped mid-answer; its partial text must not reach turn 4.
    const third = await start(hub, session, 'stop-3', [{ label: 'stop-3/partial', text: 'PARTIAL-STOPPED-ANSWER', hold: new Promise(() => {}) }]);
    await waitFor(() => third.events().some((event) => event.event === 'chunk'), 'the partial answer');
    hub.cancel('stop-node', 'stop-3');
    await third.done;
    const fourth = await turn(hub, session, 'stop-4', [{ label: 'stop-4/answer', text: 'Fresh answer.' }], 'Next question');
    const chunks = fourth.filter((event) => event.event === 'chunk').map((event) => (event.data as { text: string }).text).join('');
    assert.equal(chunks, 'Fresh answer.', 'no chunk from the stopped turn leaks into the next one');
    assert.match(assistantRow('stop-node', 'stop-3')?.content ?? '', /PARTIAL-STOPPED-ANSWER/, 'the stopped turn keeps its partial output');
    assert.equal(assistantRow('stop-node', 'stop-4')?.content, 'Fresh answer.');
    assert.equal(text(seen(requestFor('stop-4/answer')).at(-1)), 'Next question');
    assert.deepEqual(unexpected, []);
  });

  test('automatic and manual compaction mid session keep the summary, recent tool results and the plan, also after reopening', async () => {
    chatNode('compact-node');
    let { runtime, hub } = backend();
    let session = await runtime.newSession(options('compact-node'));
    contextWindow = 60_000;
    try {
      await turn(hub, session, 'compact-1', [{ label: 'compact-1/answer', text: 'Noted the brief.' }], bulk('EARLY-BRIEF'));
      // Turn 2 reports a context near the window: the SDK compacts after the run, inside the same turn.
      const second = await turn(hub, session, 'compact-2', [
        { label: 'compact-2/plan', tools: [todo({ action: 'add', items: [{ content: 'Draft' }, { content: 'Review' }] })] },
        { label: 'compact-2/probe', tools: [bash('echo PROBE-OUTPUT-4417')] },
        { label: 'compact-2/answer', text: 'Working on the draft.', inputTokens: 50_000 },
        { label: 'compact-2/summary', text: 'AUTO-SUMMARY: the user shared EARLY context; the draft is in progress.' },
      ], bulk('RECENT-WORK'));
      assert.ok(second.some((event) => event.event === 'compaction_start'), 'auto compaction ran inside the turn');
      assert.ok(second.some((event) => event.event === 'compaction_end'));
      assert.equal(second.at(-1)?.event, 'done');

      const third = await turn(hub, session, 'compact-3', [
        { label: 'compact-3/next', tools: [todo({ action: 'update', id: 1, status: 'completed' })] },
        { label: 'compact-3/answer', text: 'Draft done.' },
      ], bulk('LATER-WORK'));
      const afterAuto = JSON.stringify(seen(requestFor('compact-3/next')));
      assert.match(afterAuto, /AUTO-SUMMARY/, 'the summary reaches the next request');
      assert.equal(afterAuto.includes('EARLY-BRIEF'), false, 'the compacted turn left the context');
      assert.match(afterAuto, /PROBE-OUTPUT-4417/, 'tool results in the kept recent part survive');
      assert.deepEqual(plans(third), [[entry('Draft', 'completed'), entry('Review', 'pending')]]);

      // Manual compaction between turns, then close and reopen the session.
      script.push({ label: 'compact-manual/summary', text: 'MANUAL-SUMMARY: draft done, review pending.' });
      const compacted = await (session as AgentSession & { compact(i?: string): Promise<{ started: boolean }> }).compact('Keep the plan');
      assert.equal(compacted.started, true);
      await runtime.releaseSession('compact-node', chatOwner('compact-node'));
      ({ runtime, hub } = backend());
      session = await runtime.loadSession(options('compact-node'));
      const reopened = await turn(hub, session, 'compact-4', [
        { label: 'compact-4/next', tools: [todo({ action: 'update', id: 2, status: 'completed' })] },
        { label: 'compact-4/answer', text: 'Reviewed.' },
      ], 'Finish');
      const afterReopen = JSON.stringify(seen(requestFor('compact-4/next')));
      assert.match(afterReopen, /MANUAL-SUMMARY/, 'the reopened session starts from the manual summary');
      assert.equal(afterReopen.includes('RECENT-WORK'), false, 'not from the text-only history');
      assert.match(afterReopen, /LATER-WORK/, 'the kept recent turn is still there');
      assert.deepEqual(plans(reopened), [[entry('Draft', 'completed'), entry('Review', 'completed')]]);
      assert.deepEqual(unexpected, []);
    } finally {
      contextWindow = 1_000_000;
    }
  });

  test('a crash mid tool call reopens with the prior native context and tells the model the outcome is unknown', async () => {
    chatNode('crash-node');
    const crashed = backend();
    let session = await crashed.runtime.newSession(options('crash-node'));
    const log = path.join(work, 'crash-runs.log');
    await turn(crashed.hub, session, 'crash-1', [{ label: 'crash-1/answer', text: 'Read the early notes.' }], bulk('CRASH-EARLY'));
    await turn(crashed.hub, session, 'crash-2', [
      { label: 'crash-2/probe', tools: [bash('echo NATIVE-RESULT-9031')] },
      { label: 'crash-2/answer', text: 'Probed.' },
    ], bulk('CRASH-RECENT'));
    script.push({ label: 'crash-manual/summary', text: 'CRASH-SUMMARY: early notes read.' });
    assert.equal((await (session as any).compact()).started, true);

    // Turn 3 is mid-command when the backend dies: nothing finalizes the turn
    // or the Pi checkpoint. The old backend is abandoned, not shut down.
    await start(crashed.hub, session, 'crash-3', [
      { label: 'crash-3/write', tools: [bash(`echo started >> ${log}; sleep 120; echo finished >> ${log}`)] },
    ], 'Write the report');
    await waitFor(() => fs.existsSync(log), 'the command to start');
    // The next process start marks the turn interrupted (server.ts boot).
    assert.equal(recoverInterruptedTurns(Date.now()), 1);

    const reopened = backend();
    session = await reopened.runtime.loadSession(options('crash-node'));
    await turn(reopened.hub, session, 'crash-4', [{ label: 'crash-4/answer', text: 'I will check the report before writing again.' }], 'Continue please');
    const context = seen(requestFor('crash-4/answer'));
    const serialized = JSON.stringify(context);
    assert.match(serialized, /CRASH-SUMMARY/, 'the compaction summary from before the crash is kept');
    assert.equal(serialized.includes('CRASH-EARLY'), false, 'the compacted turn stays compacted');
    assert.match(serialized, /NATIVE-RESULT-9031/, 'tool results from before the crash are kept');
    assert.match(serialized, /Write the report/, 'the interrupted request is in context');
    const pending = toolResult(context, 'bash').filter((message) => !text(message).includes('NATIVE-RESULT-9031'));
    assert.equal(pending.length, 1, 'the in-flight command has exactly one result');
    assert.match(text(pending[0]), /outcome is unknown/i, 'the model is told the in-flight command may have taken effect');
    assert.equal(text(context.at(-1)), 'Continue please');
    assert.equal(fs.readFileSync(log, 'utf8'), 'started\n', 'recovery did not run the command again');
    assert.deepEqual(unexpected, []);
  });

  test('a backend shutdown mid tool call settles the turn and the reopened session knows the call was cut off', async () => {
    chatNode('shutdown-node');
    const closing = backend();
    let session = await closing.runtime.newSession(options('shutdown-node'));
    const log = path.join(work, 'shutdown-runs.log');
    const running = await start(closing.hub, session, 'shutdown-1', [
      { label: 'shutdown-1/write', tools: [bash(`echo started >> ${log}; sleep 30; echo finished >> ${log}`)] },
    ], 'Write the summary');
    await waitFor(() => fs.existsSync(log), 'the command to start');
    closing.hub.prepareForShutdown();
    await closing.runtime.shutdown();
    await running.done;
    assert.notEqual(closing.hub.requestedTurnStatus('shutdown-1'), 'active', 'the interrupted turn has a terminal receipt');

    const reopened = backend();
    session = await reopened.runtime.loadSession(options('shutdown-node'));
    await turn(reopened.hub, session, 'shutdown-2', [{ label: 'shutdown-2/answer', text: 'Checking the summary file first.' }], 'Continue');
    const context = seen(requestFor('shutdown-2/answer'));
    assert.match(JSON.stringify(context), /Write the summary/);
    const stopped = toolResult(context, 'bash');
    assert.equal(stopped.length, 1);
    assert.match(text(stopped[0]), /outcome is unknown/i);
    assert.doesNotMatch(text(stopped[0]), /The user stopped/, 'a shutdown is not reported as the user pressing Stop');
    assert.equal(fs.readFileSync(log, 'utf8'), 'started\n');
    assert.deepEqual(unexpected, []);
  });

  test('the native transcript is reused only while it lines up with the SQLite history', async () => {
    chatNode('align-node');
    const directory = piSdkSessionDirectory('align-node', { ownerUserId: null, workspaceId: 'ws-1', owner: chatOwner('align-node'), profileHash: null } as any);
    const checkpoint = path.join(directory, 'host-history.sha256');
    let { runtime, hub } = backend();
    let session = await runtime.newSession(options('align-node'));
    await turn(hub, session, 'align-1', [
      { label: 'align-1/probe', tools: [bash('echo ALIGN-NATIVE-5521')] },
      { label: 'align-1/answer', text: 'Probed.' },
    ]);
    const reopen = async (label: string) => {
      await runtime.releaseSession('align-node', chatOwner('align-node'));
      ({ runtime, hub } = backend());
      session = await runtime.loadSession(options('align-node'));
      await turn(hub, session, label, [{ label: `${label}/answer`, text: 'OK.' }], `ask ${label}`);
      return JSON.stringify(seen(requestFor(`${label}/answer`)));
    };

    // A checkpoint in the original hash-only format still restores an exact match.
    fs.writeFileSync(checkpoint, JSON.parse(fs.readFileSync(checkpoint, 'utf8')).hash);
    assert.match(await reopen('align-2'), /ALIGN-NATIVE-5521/);

    // Turns another runtime ran on this node after the checkpoint join as text.
    const seq = listMessages('align-node').length;
    saveMessage({ id: 'other-user', node_id: 'align-node', role: 'user', content: 'OTHER-RUNTIME-QUESTION', seq, created_at: Date.now() } as any);
    saveMessage({ id: 'other-answer', node_id: 'align-node', role: 'assistant', content: 'OTHER-RUNTIME-ANSWER', seq: seq + 1, created_at: Date.now() } as any);
    const joined = await reopen('align-3');
    assert.match(joined, /ALIGN-NATIVE-5521/, 'the native context is kept');
    assert.match(joined, /OTHER-RUNTIME-QUESTION/);
    assert.match(joined, /OTHER-RUNTIME-ANSWER/);

    // An edited history no longer matches: the transcript is retired, not resumed.
    getDb().prepare('DELETE FROM messages WHERE id = ?').run('other-user');
    const edited = await reopen('align-4');
    assert.equal(edited.includes('ALIGN-NATIVE-5521'), false, 'tool results are not resurrected from a stale transcript');
    assert.match(edited, /OTHER-RUNTIME-ANSWER/, 'the text history comes from SQLite');
    assert.ok(fs.readdirSync(directory).some((name) => name.startsWith('retired-')), 'the old transcript is kept for recovery');
    assert.deepEqual(unexpected, []);
  });

  // Known gap. When the native transcript cannot be reused (the agent-core
  // engine, MICHI_PI_SESSION_SDK=0; a cut, retried or edited history; an
  // interrupted turn followed by more user rows, e.g. steering or another
  // runtime's turns), Pi restarts from SQLite text only: rowsToAgentMessages
  // keeps each row's content, so earlier tool results and compaction summaries
  // are gone and an interrupted turn's in-flight calls are not mentioned unless
  // the user presses Resume (the renderer's buildResumePrompt lists them).
  // Fix: seed that fallback with a note per assistant row built from its stored
  // tool_calls (title, status, short input; `interrupted` = outcome unknown),
  // kept out of the checkpoint hash input. It needs the rows' tool calls carried
  // through PiRuntime.restoreSession, the seed messages and collectSeed.
  test.todo('a text-only restore tells the model which tool calls of an interrupted turn may have run');
});
