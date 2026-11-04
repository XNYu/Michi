import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PiSession } from '../src/agents/pi/PiSession';
import { buildPiTools } from '../src/agents/pi/piTools';
import { buildPiAskUserTool, PI_ASK_USER_INSTRUCTION } from '../src/agents/pi/piAskUser';
import { loadPiAi, loadPiTypebox } from '../src/agents/pi/piAi';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { makeTurnImageQuota } from '../src/agents/tools/read';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { chatOwner, runOwner } from './helpers/owners';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const bridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null };
const model = { id: 'pi-model', provider: 'deepseek', contextWindow: 1000 };
const QUESTIONS = [
  { question: 'Which color?', header: 'Color', options: [{ label: 'Blue', description: 'Calm' }, { label: 'Red' }] },
  { question: 'Which sizes?', options: [{ label: 'S' }, { label: 'M' }, { label: 'L' }], multiSelect: true },
];

type Script = (agent: StubAgent, text: string) => Promise<void>;
interface StubAgent {
  options: any;
  state: any;
  controller: AbortController;
  emit(event: any): void;
}

async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Runs one tool call the way pi-agent-core does: host gate, start, execute, end. */
async function callTool(agent: StubAgent, name: string, args: unknown, id = 'call-1') {
  const tool = agent.state.tools.find((candidate: { name: string }) => candidate.name === name);
  assert(tool, `${name} is registered`);
  const gate = await agent.options.beforeToolCall({ toolCall: { name, id }, args }, agent.controller.signal);
  if (gate?.block) return { blocked: gate.reason as string };
  agent.emit({ type: 'tool_execution_start', toolCallId: id, toolName: name, args });
  try {
    const result = await tool.execute(id, args, agent.controller.signal);
    agent.emit({ type: 'tool_execution_end', toolCallId: id, toolName: name, result, isError: !!result.isError });
    return { result };
  } catch (error) {
    agent.emit({ type: 'tool_execution_end', toolCallId: id, toolName: name, result: { content: [] }, isError: true });
    return { error };
  }
}

async function fixture(t: TestContext, script: Script, sessionOverrides: Record<string, unknown> = {}) {
  const realAi: any = await loadPiAi();
  configureRuntimeDeps({
    dataDir: process.env.MICHI_DATA_DIR,
    historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null },
    providerKeys: { getProviderApiKey: () => 'fake-key' },
    agentConfig: { getAgentConfig: () => ({ provider: 'deepseek' } as any), resolveModel: () => 'pi-model', resolveReasoning: () => undefined },
  });
  t.after(__resetRuntimeDeps);
  t.mock.method(require('../src/services/piMcpConfig'), 'readPiMcpServers', () => []);
  t.mock.method(require('../src/agents/pi/piAi'), 'loadPiAi', async () => ({ ...realAi, clampThinkingLevel: () => 'off' }));
  t.mock.method(require('../src/agents/pi/piProviders'), 'resolvePiModel', async () => model);
  const agents: StubAgent[] = [];
  class Agent implements StubAgent {
    state: any;
    controller = new AbortController();
    subscriber: ((event: any) => void) | undefined;
    constructor(public options: any) { this.state = { ...options.initialState }; agents.push(this); }
    subscribe(fn: (event: any) => void) { this.subscriber = fn; return () => { this.subscriber = undefined; }; }
    emit(event: any) { this.subscriber?.(event); }
    abort() { this.controller.abort(); }
    async prompt(text: string) {
      this.controller = new AbortController();
      await script(this, text);
      this.emit({ type: 'agent_end' });
    }
  }
  t.mock.method(require('../src/agents/pi/piAi'), 'loadPiAgentCore', async () => ({ Agent }));
  const session = new PiSession('pi-ask-node', {
    bridge, preamble: 'Host prompt.', cwd: '/tmp', workspaceId: null, ownerUserId: null, enableFollowUps: false,
    requestedProvider: 'deepseek', requestedModel: 'pi-model', owner: chatOwner('pi-ask-node'), ...sessionOverrides,
  });
  t.after(() => session.dispose().catch(() => {}));
  return { session, agents };
}

/** Collects a turn's events in the background so the test can answer mid-turn. */
function run(session: PiSession, text: string) {
  const events: NormalizedEvent[] = [];
  const done = (async () => {
    for await (const event of session.send(text)) events.push(event);
    return events;
  })();
  const request = () => waitFor(() => events.find((event): event is Extract<NormalizedEvent, { kind: 'user_input_request' }> =>
    event.kind === 'user_input_request'), 'user_input_request');
  return { events, done, request };
}

test('Pi ask_user is registered with its instruction and needs no permission card in Ask mode', async (t) => {
  let outcome: any;
  const { session, agents } = await fixture(t, async (agent) => {
    outcome = await callTool(agent, 'ask_user', { questions: QUESTIONS });
    agent.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Thanks.' } });
  });
  const turn = run(session, 'Help me pick');
  const request = await turn.request();
  const agent = agents[0];
  assert(agent.state.tools.some((tool: { name: string }) => tool.name === 'ask_user'));
  assert(agent.state.systemPrompt.endsWith(PI_ASK_USER_INSTRUCTION));
  assert.equal(turn.events.some((event) => event.kind === 'permission_request'), false, 'no approval before a question');
  assert(Number.isSafeInteger(request.requestId) && request.requestId > Date.now(), 'IDs never repeat across sessions');
  assert.deepEqual(request.questions, [
    { question: 'Which color?', header: 'Color', options: [{ label: 'Blue', description: 'Calm' }, { label: 'Red' }], multiSelect: false },
    { question: 'Which sizes?', options: [{ label: 'S' }, { label: 'M' }, { label: 'L' }], multiSelect: true },
  ]);
  // One option, one multi-select, one free-text "Other" answer pass through unchanged.
  const answers = [{ question: 'Which color?', answer: 'Blue' }, { question: 'Which sizes?', answer: 'S, L — and a custom XL' }];
  session.respondToUserInput(request.requestId, answers);
  const events = await turn.done;
  assert.deepEqual(JSON.parse(outcome.result.content[0].text), { answers: { 'Which color?': 'Blue', 'Which sizes?': 'S, L — and a custom XL' } });
  assert.deepEqual(outcome.result.details, { answered: true, answers });
  const resolved = events.find((event) => event.kind === 'user_input_resolved');
  assert.deepEqual(resolved, { kind: 'user_input_resolved', requestId: request.requestId, answers, outcome: 'answered' });
  assert(events.some((event) => event.kind === 'tool_call_update' && event.title === 'ask_user' && event.status === 'completed'));
  assert(events.some((event) => event.kind === 'chunk' && event.text === 'Thanks.'), 'the turn continues after the answer');
  assert.deepEqual(events.at(-1), { kind: 'turn_end' });
  assert.equal((session as any).pendingUserInputs.size, 0);
});

test('Pi ask_user skip and timeout continue the turn without an answer', async (t) => {
  const outcomes: any[] = [];
  const { session } = await fixture(t, async (agent) => {
    outcomes.push(await callTool(agent, 'ask_user', { questions: QUESTIONS.slice(0, 1) }));
  });
  const skipped = run(session, 'Skip this');
  const request = await skipped.request();
  session.skipUserInput(request.requestId);
  session.respondToUserInput(request.requestId, [{ question: 'Which color?', answer: 'late' }]);
  const events = await skipped.done;
  assert.equal(outcomes[0].result.content[0].text, 'The user did not answer the questions (skipped or timed out).');
  assert.deepEqual(events.find((event) => event.kind === 'user_input_resolved'),
    { kind: 'user_input_resolved', requestId: request.requestId, answers: [], outcome: 'skipped' });
  assert.deepEqual(events.at(-1), { kind: 'turn_end' });

  const previous = process.env.MICHI_APPROVE_TIMEOUT_MS;
  process.env.MICHI_APPROVE_TIMEOUT_MS = '20';
  t.after(() => { if (previous === undefined) delete process.env.MICHI_APPROVE_TIMEOUT_MS; else process.env.MICHI_APPROVE_TIMEOUT_MS = previous; });
  const timedOut = await run(session, 'Nobody answers').done;
  assert.equal(outcomes[1].result.content[0].text, 'The user did not answer the questions (skipped or timed out).');
  assert(timedOut.some((event) => event.kind === 'user_input_resolved' && event.outcome === 'skipped'));
  assert.deepEqual(timedOut.at(-1), { kind: 'turn_end' });
  assert.equal((session as any).pendingUserInputs.size, 0);
});

test('Pi cancel while ask_user waits ends the turn, drops late answers and the next question works', async (t) => {
  const outcomes: any[] = [];
  const { session, agents } = await fixture(t, async (agent) => {
    outcomes.push(await callTool(agent, 'ask_user', { questions: QUESTIONS.slice(0, 1) }));
  });
  const first = run(session, 'Ask then stop');
  const request = await first.request();
  session.cancel();
  const events = await first.done;
  assert.deepEqual(events.at(-1), { kind: 'turn_end', stopReason: 'cancelled' });
  assert.equal((session as any).pendingUserInputs.size, 0);
  assert.equal(outcomes[0].error?.name, 'AbortError', 'the model never receives an answer after cancel');
  session.respondToUserInput(request.requestId, [{ question: 'Which color?', answer: 'too late' }]);
  assert.equal(events.some((event) => event.kind === 'user_input_resolved'), false, 'ChatHub closes a cancelled card');

  const second = run(session, 'Ask again');
  const next = await second.request();
  assert.notEqual(next.requestId, request.requestId);
  session.respondToUserInput(next.requestId, [{ question: 'Which color?', answer: 'Red' }]);
  assert.deepEqual((await second.done).at(-1), { kind: 'turn_end' });
  assert.deepEqual(JSON.parse(outcomes[1].result.content[0].text), { answers: { 'Which color?': 'Red' } });
  assert.equal(agents.length, 1);
});

test('Pi dispose releases a waiting question', async (t) => {
  let outcome: any;
  const { session } = await fixture(t, async (agent) => { outcome = await callTool(agent, 'ask_user', { questions: QUESTIONS.slice(0, 1) }); });
  const turn = run(session, 'Ask then close');
  await turn.request();
  await session.dispose();
  await turn.done.catch(() => {});
  assert.equal((session as any).pendingUserInputs.size, 0);
  assert.ok(outcome.error || outcome.result, 'the tool settled');
});

test('Pi Run broker: deny blocks ask_user, and ask opens no extra permission card', async (t) => {
  let decision: 'deny' | 'ask' = 'deny';
  const outcomes: any[] = [];
  const { session } = await fixture(t, async (agent) => {
    outcomes.push(await callTool(agent, 'ask_user', { questions: QUESTIONS.slice(0, 1) }));
  }, {
    owner: runOwner('run-1', 'pi-ask-node'),
    toolProfile: { allowedToolNames: ['ask_user'] },
    permissionBroker: { requestPermission: async () => decision },
  });
  const denied = await run(session, 'Denied').done;
  assert.equal(outcomes[0].blocked, 'denied by Run permission policy');
  assert.equal(denied.some((event) => event.kind === 'user_input_request' || event.kind === 'permission_request'), false);
  decision = 'ask';
  const asked = run(session, 'Allowed');
  const request = await asked.request();
  assert.equal(asked.events.some((event) => event.kind === 'permission_request'), false);
  session.respondToUserInput(request.requestId, [{ question: 'Which color?', answer: 'Blue' }]);
  await asked.done;
  assert.deepEqual(JSON.parse(outcomes[1].result.content[0].text), { answers: { 'Which color?': 'Blue' } });
});

test('Pi ask_user rejects malformed questions as a tool error without asking', async () => {
  const { Type } = await loadPiTypebox();
  let asked = 0;
  const tool = buildPiAskUserTool(Type, async () => { asked++; return []; });
  assert.equal(tool.executionMode, 'sequential', 'one pending question per turn');
  for (const [questions, error] of [
    [[], 'questions must be an array of 1-4 questions.'],
    [[{ question: ' ', options: [{ label: 'A' }, { label: 'B' }] }], 'questions[0].question must be a non-empty string.'],
    [[{ question: 'Q?', options: [{ label: 'Only' }] }], 'questions[0].options must list 2-4 options.'],
    [[{ question: 'Q?', options: [{ label: 'A' }, { label: '' }] }], 'questions[0].options[1].label must be a non-empty string.'],
  ] as const) {
    const result = await tool.execute('call', { questions });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, error);
  }
  assert.equal(asked, 0);
});

test('only catalogs given the session channel offer ask_user', async () => {
  const { Type } = await loadPiTypebox();
  configureRuntimeDeps({
    dataDir: process.env.MICHI_DATA_DIR,
    historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null },
    agentConfig: { getAgentConfig: () => ({ provider: 'deepseek' } as any), resolveModel: () => 'pi-model', resolveReasoning: () => undefined },
  });
  try {
    const base = { bridge, cwd: '/tmp', parentChatId: 'n', workspaceId: null, enableFollowUps: false,
      imageQuota: makeTurnImageQuota(), seenPaths: new Set<string>(), Type, owner: chatOwner('n') };
    const requestUserInput = async () => null;
    const names = (opts: object) => buildPiTools({ ...base, ...opts }).map((tool) => tool.name);
    assert.equal(names({}).includes('ask_user'), false, 'maintenance access and internal catalogs have no question channel');
    assert.equal(names({ requestUserInput }).filter((name) => name === 'ask_user').length, 1);
    assert.deepEqual(names({ requestUserInput, toolProfile: { restricted: true, allowedToolNames: ['ask_user'] } }), [],
      'a restricted profile outside the assistant home still gets no tools');
  } finally { __resetRuntimeDeps(); }
});
