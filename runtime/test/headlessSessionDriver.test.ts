import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonValue } from 'michi-shared';
import type { AgentSession, SteerResult } from '../src/contract/types';
import type { NormalizedEvent, UserInputQuestion } from '../src/contract/events';
import {
  DEFAULT_HEADLESS_DRIVER_MESSAGES,
  startHeadlessSession,
  type HeadlessDriverMessages,
  type HeadlessDriverOptions,
} from '../src/core/headless/driver';
import { classifyRuntimeError, type RuntimeErrorCategory } from '../src/core/headless/errors';
import { ReportedRuntimeError } from '../src/contract/errors';

// ---------------------------------------------------------------------------
// Scripted fake session
// ---------------------------------------------------------------------------

type Script = (session: ScriptedSession, turn: number) => AsyncGenerator<NormalizedEvent, void, unknown>;

/** Records session calls and driver callbacks in one ordered log. */
class ScriptedSession implements AgentSession {
  id = 'session-1';
  runtimeId = 'fake';
  nativeSessionId: string | null = null;
  readonly log: string[] = [];
  readonly sent: string[] = [];
  cancels = 0;
  /** Calls to `return()` on the turn iterators this session handed out. */
  returns = 0;
  onCancel: () => void = () => {};
  getNativeResumeToken?(): JsonValue;
  steer?(text: string): Promise<SteerResult>;
  respondToPermission?(requestId: number, optionId: string): void;
  cancelPermission?(requestId: number): void;
  respondToUserInput?(requestId: number, answers: Array<{ question: string; answer: string }>): void;
  skipUserInput?(requestId: number): void;

  constructor(private readonly script: Script) {}
  getHistory() { return []; }
  getPendingAssistant() { return undefined; }
  send(text: string) {
    this.sent.push(text);
    this.log.push(`send:${text}`);
    const turn = this.script(this, this.sent.length);
    const close = turn.return.bind(turn);
    turn.return = (value) => { this.returns += 1; return close(value); };
    return turn;
  }
  async cancel() {
    this.cancels += 1;
    this.log.push('cancel');
    this.onCancel();
  }
}

function drive(session: ScriptedSession, overrides: Partial<HeadlessDriverOptions<string>> = {}) {
  let releases = 0;
  const handle = startHeadlessSession<string>({
    session,
    runtimeId: 'fake',
    initialPrompt: 'task',
    steering: 'native',
    supplementalPrefix: '[more] ',
    onEvent: (event) => { session.log.push(`event:${event.kind}`); },
    onCheckpoint: (token) => { session.log.push(`checkpoint:${JSON.stringify(token)}`); },
    onSteering: ({ phase, mode, text, interrupted }) => {
      session.log.push(`steering:${phase}:${mode}:${text}${interrupted ? ':interrupted' : ''}`);
    },
    finalize: (text) => { session.log.push('finalize'); return `result:${text}`; },
    release: () => { releases += 1; session.log.push('release'); },
    answerPermission: (text) => (text === 'allow' ? 'allow_once' : 'reject_once'),
    ...overrides,
  });
  return { handle, releases: () => releases };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const chunk = (text: string): NormalizedEvent => ({ kind: 'chunk', text });
const turnEnd = (stopReason = 'end_turn'): NormalizedEvent => ({ kind: 'turn_end', stopReason });
const question = (text: string, id?: string): UserInputQuestion => ({ ...(id ? { id } : {}), question: text, options: [], multiSelect: false });

/** Turn one yields `first`, signals `started`, and waits for `gate`; later turns yield `later`. */
function gatedTurns(first: string, later: string) {
  const started = deferred();
  const gate = deferred();
  const script: Script = async function* (_session, turn) {
    if (turn === 1) {
      yield chunk(first);
      started.resolve();
      await gate.promise;
    } else {
      yield chunk(later);
    }
    yield turnEnd();
  };
  return { script, started, gate };
}

// ---------------------------------------------------------------------------
// Turn loop
// ---------------------------------------------------------------------------

test('a native session runs one turn, finalizes its text, and releases once', async () => {
  const session = new ScriptedSession(async function* () {
    yield chunk('hello ');
    yield { kind: 'thought', text: 'hm' };
    yield chunk('world');
    yield turnEnd();
  });
  const { handle, releases } = drive(session);
  assert.deepEqual(await handle.completion, { status: 'completed', result: 'result:hello world' });
  assert.deepEqual(session.log, ['send:task', 'event:chunk', 'event:thought', 'event:chunk', 'event:turn_end', 'finalize', 'release']);
  assert.equal(releases(), 1);
  assert.equal(session.returns, 1, 'the driver closes the turn iterator at turn_end');
});

test('a host can drive a session with only the required options', async () => {
  const session = new ScriptedSession(async function* () { yield chunk('done'); yield turnEnd(); });
  session.runtimeId = 'scripted';
  session.nativeSessionId = 'native-1';
  const events: string[] = [];
  let releases = 0;
  const handle = startHeadlessSession<string>({
    session,
    initialPrompt: 'task',
    steering: 'none',
    onEvent: (event) => { events.push(event.kind); },
    finalize: (text) => text,
    release: () => { releases += 1; },
    answerPermission: () => 'allow_once',
  });
  await assert.rejects(handle.input('x'), { message: 'runtime scripted does not support supplemental input' });
  assert.deepEqual(await handle.completion, { status: 'completed', result: 'done' });
  assert.deepEqual(events, ['chunk', 'turn_end']);
  assert.equal(releases, 1);
});

test('without a prefix or steering hook, queued input is sent verbatim as the next turn', async () => {
  const { script, started, gate } = gatedTurns('one', ' two');
  const session = new ScriptedSession(script);
  const handle = startHeadlessSession<string>({
    session,
    initialPrompt: 'task',
    steering: 'next_turn',
    onEvent: () => {},
    finalize: (text) => text,
    release: () => {},
    answerPermission: () => 'allow_once',
  });
  await started.promise;
  await handle.input('extra');
  gate.resolve();
  assert.deepEqual(await handle.completion, { status: 'completed', result: 'one two' });
  assert.deepEqual(session.sent, ['task', 'extra']);
});

test('the driver awaits each event write before reading the next event', async () => {
  const write = deferred();
  const session = new ScriptedSession(async function* () {
    yield chunk('a');
    session.log.push('generator resumed');
    yield turnEnd();
  });
  const { handle } = drive(session, {
    onEvent: (event) => {
      session.log.push(`event:${event.kind}`);
      return event.kind === 'chunk' ? write.promise : undefined;
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(session.log, ['send:task', 'event:chunk']);
  write.resolve();
  assert.equal((await handle.completion).status, 'completed');
  assert.deepEqual(session.log.slice(2, 4), ['generator resumed', 'event:turn_end']);
});

test('next_turn delivery sends queued input as a prefixed second turn after reporting it applied', async () => {
  const { script, started, gate } = gatedTurns('one', ' two');
  const session = new ScriptedSession(script);
  const { handle } = drive(session, { steering: 'next_turn' });
  await started.promise;
  await handle.input('extra');
  gate.resolve();
  assert.deepEqual(await handle.completion, { status: 'completed', result: 'result:one two' });
  assert.deepEqual(session.sent, ['task', '[more] extra']);
  assert.deepEqual(session.log, [
    'send:task', 'event:chunk', 'steering:queued:queued:extra', 'event:turn_end',
    'steering:applied:queued:extra', 'send:[more] extra', 'event:chunk', 'event:turn_end', 'finalize', 'release',
  ]);
});

test('a second queued input replaces the first one before delivery', async () => {
  const { script, started, gate } = gatedTurns('one', ' two');
  const session = new ScriptedSession(script);
  const { handle } = drive(session, { steering: 'next_turn' });
  await started.promise;
  await handle.input('first');
  await handle.input('second');
  gate.resolve();
  assert.equal((await handle.completion).status, 'completed');
  assert.deepEqual(session.sent, ['task', '[more] second']);
});

// ---------------------------------------------------------------------------
// Immediate input
// ---------------------------------------------------------------------------

test('immediate input cancels the turn it targets and continues as a new turn', async () => {
  const { script, started, gate } = gatedTurns('one', ' two');
  const session = new ScriptedSession(script);
  session.onCancel = () => gate.resolve();
  const { handle } = drive(session, { steering: 'next_turn' });
  await started.promise;
  await handle.input('urgent', 'immediate');
  assert.equal((await handle.completion).status, 'completed');
  assert.equal(session.cancels, 1);
  assert.deepEqual(session.sent, ['task', '[more] urgent']);
  const queued = session.log.indexOf('steering:queued:immediate:urgent:interrupted');
  assert(queued >= 0 && queued < session.log.indexOf('cancel'), 'the interruption is reported before the cancel');
  assert(session.log.indexOf('steering:applied:immediate:urgent') < session.log.indexOf('send:[more] urgent'));
});

test('immediate input never cancels a turn other than the one it targeted', async () => {
  const firstTurn = deferred();
  const writeStarted = deferred();
  const write = deferred();
  const session = new ScriptedSession(async function* (_session, turn) {
    if (turn === 1) await firstTurn.promise;
    yield turnEnd();
  });
  session.onCancel = () => firstTurn.resolve();
  const { handle } = drive(session, {
    steering: 'next_turn',
    onSteering: ({ phase }) => {
      if (phase !== 'queued') return;
      writeStarted.resolve();
      return write.promise;
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const immediate = handle.input('urgent', 'immediate');
  await writeStarted.promise;
  // The targeted turn ends on its own while the interruption is still being written.
  firstTurn.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(session.sent, ['task'], 'the next turn waits for the pending interruption');
  write.resolve();
  await immediate;
  assert.equal((await handle.completion).status, 'completed');
  assert.deepEqual(session.sent, ['task', '[more] urgent']);
  assert.equal(session.cancels, 0, 'neither the finished turn nor the new turn is cancelled');
});

test('an immediate input accepted between turns never cancels the turn opened during its write', async () => {
  const firstTurn = deferred(); const secondStarted = deferred(); const secondTurn = deferred();
  const applying = deferred(); const appliedWrite = deferred(); const interruptWrite = deferred();
  const session = new ScriptedSession(async function* (_session, turn) {
    if (turn === 1) await firstTurn.promise;
    if (turn === 2) { secondStarted.resolve(); await secondTurn.promise; }
    yield turnEnd();
  });
  session.onCancel = () => secondTurn.resolve();
  const { handle } = drive(session, {
    steering: 'next_turn',
    onSteering: ({ phase, mode, text }) => {
      if (phase === 'applied' && text === 'q1') { applying.resolve(); return appliedWrite.promise; }
      if (phase === 'queued' && mode === 'immediate') return interruptWrite.promise;
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await handle.input('q1');
  firstTurn.resolve();
  await applying.promise;
  const immediate = handle.input('urgent', 'immediate');
  appliedWrite.resolve();
  await secondStarted.promise;
  interruptWrite.resolve();
  await immediate;
  assert.equal(session.cancels, 0, 'the turn opened during the write is not interrupted');
  secondTurn.resolve();
  assert.equal((await handle.completion).status, 'completed');
  assert.deepEqual(session.sent, ['task', '[more] q1', '[more] urgent']);
});

test('a turn waits for an interruption accepted while the loop waited on an earlier one', async () => {
  const firstTurn = deferred(); const firstWriteStarted = deferred();
  const firstWrite = deferred(); const secondWrite = deferred();
  const session = new ScriptedSession(async function* (_session, turn) {
    if (turn === 1) await firstTurn.promise;
    yield turnEnd();
  });
  const { handle } = drive(session, {
    steering: 'next_turn',
    onSteering: ({ phase, text }) => {
      if (phase !== 'queued') return;
      if (text === 'u1') { firstWriteStarted.resolve(); return firstWrite.promise; }
      return secondWrite.promise;
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const first = handle.input('u1', 'immediate');
  await firstWriteStarted.promise;
  // The first turn ends on its own; the loop now waits on the first interruption.
  firstTurn.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = handle.input('u2', 'immediate');
  firstWrite.resolve();
  await first;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(session.sent, ['task'], 'the second interruption still holds the next turn');
  secondWrite.resolve();
  await second;
  assert.equal((await handle.completion).status, 'completed');
  assert.deepEqual(session.sent, ['task', '[more] u2'], 'the later immediate input replaces the earlier one');
  assert.equal(session.cancels, 0);
});

test('native steering with next_turn immediates steers queued input and interrupts for immediate input', async () => {
  for (const mode of ['queued', 'immediate'] as const) {
    const { script, started, gate } = gatedTurns('one', ' two');
    const session = new ScriptedSession(script);
    const steered: string[] = [];
    session.steer = async (text) => { steered.push(text); return { accepted: true }; };
    session.onCancel = () => gate.resolve();
    const { handle } = drive(session, { steering: 'native', immediateSteering: 'next_turn' });
    await started.promise;
    await handle.input('guidance', mode);
    gate.resolve();
    assert.equal((await handle.completion).status, 'completed');
    assert.deepEqual(steered, mode === 'queued' ? ['guidance'] : []);
    assert.deepEqual(session.sent, mode === 'queued' ? ['task'] : ['task', '[more] guidance']);
    assert.equal(session.cancels, mode === 'queued' ? 0 : 1);
  }
});

test('native steering cancels before an immediate steer and surfaces a rejected steer', async () => {
  const { script, started, gate } = gatedTurns('one', 'unused');
  const session = new ScriptedSession(script);
  const steered: string[] = [];
  session.steer = async (text) => {
    session.log.push(`steer:${text}`);
    steered.push(text);
    return text === 'refused' ? { accepted: false, reason: 'busy' } : { accepted: true };
  };
  const { handle } = drive(session);
  await started.promise;
  await handle.input('now', 'immediate');
  assert.deepEqual(session.log.slice(-2), ['cancel', 'steer:now']);
  await assert.rejects(handle.input('refused'), /busy/);
  gate.resolve();
  assert.equal((await handle.completion).status, 'completed');
  assert.deepEqual(steered, ['now', 'refused']);
});

test('input is rejected when the session cannot steer or the strategy is none', async () => {
  const noSteer = new ScriptedSession(gatedTurns('one', '').script);
  await assert.rejects(drive(noSteer).handle.input('x'), /runtime fake does not support session steering/);
  const none = new ScriptedSession(gatedTurns('one', '').script);
  await assert.rejects(drive(none, { steering: 'none' }).handle.input('x'), /runtime fake does not support supplemental input/);
});

// ---------------------------------------------------------------------------
// Terminalization barrier
// ---------------------------------------------------------------------------

test('input is rejected while finalizing and after the session is terminal', async () => {
  const session = new ScriptedSession(async function* () { yield turnEnd(); });
  let duringFinalize: Promise<void> | null = null;
  const { handle } = drive(session, {
    steering: 'next_turn',
    finalize: () => {
      duringFinalize = handle.input('late');
      return 'done';
    },
  });
  assert.deepEqual(await handle.completion, { status: 'completed', result: 'done' });
  assert(duringFinalize);
  await assert.rejects(duringFinalize, /already completed or is finalizing/);
  await assert.rejects(handle.input('later'), /already completed or is finalizing/);
  assert.deepEqual(session.sent, ['task']);
});

test('a native session rejects input while finalizing, even when it could steer', async () => {
  const session = new ScriptedSession(async function* () { yield turnEnd(); });
  session.steer = async () => ({ accepted: true });
  let duringFinalize: Promise<void> | null = null;
  const { handle } = drive(session, {
    finalize: () => {
      duringFinalize = handle.input('late');
      return 'done';
    },
  });
  assert.deepEqual(await handle.completion, { status: 'completed', result: 'done' });
  assert(duringFinalize);
  await assert.rejects(duringFinalize, /already completed or is finalizing/);
});

test('input is rejected after cancellation and after failure', async () => {
  const { script, started, gate } = gatedTurns('one', '');
  const session = new ScriptedSession(script);
  session.onCancel = () => gate.resolve();
  const cancelled = drive(session, { steering: 'next_turn' });
  await started.promise;
  await cancelled.handle.cancel();
  assert.deepEqual(await cancelled.handle.completion, { status: 'cancelled' });
  await assert.rejects(cancelled.handle.input('x'), /already completed or is finalizing/);
  const failed = drive(new ScriptedSession(async function* () { yield { kind: 'runtime_error', error: 'boom' }; }));
  assert.equal((await failed.handle.completion).status, 'failed');
  await assert.rejects(failed.handle.input('x'), /already completed or is finalizing/);
});

// ---------------------------------------------------------------------------
// Durable interactions
// ---------------------------------------------------------------------------

test('a permission pause continues on the same iterator after it is answered', async () => {
  const request: NormalizedEvent = { kind: 'permission_request', requestId: 3, title: 'Write?', options: [] };
  const session = new ScriptedSession(async function* () {
    yield chunk('before ');
    yield request;
    yield chunk('after');
    yield turnEnd();
  });
  session.respondToPermission = (requestId, optionId) => { session.log.push(`answer:${requestId}:${optionId}`); };
  const { handle, releases } = drive(session);
  assert.deepEqual(await handle.completion, { status: 'waiting', kind: 'permission', request: { ...request } });
  assert.equal(releases(), 0, 'a waiting session keeps its session');
  assert.throws(() => handle.continueAfterInput(), /has not been answered/);
  await handle.input('allow');
  assert.deepEqual(await handle.continueAfterInput(), { status: 'completed', result: 'result:before after' });
  assert.deepEqual(session.sent, ['task'], 'no new turn is sent to continue');
  assert.deepEqual(session.log, ['send:task', 'event:chunk', 'event:permission_request', 'answer:3:allow_once',
    'event:chunk', 'event:turn_end', 'finalize', 'release']);
});

test('by default a user_input answer reaches every question, keeping question ids', async () => {
  const session = new ScriptedSession(async function* () {
    yield { kind: 'user_input_request', requestId: 5, questions: [question('Which file?', 'q1'), question('Why?')] };
    yield turnEnd();
  });
  const answered: unknown[] = [];
  session.respondToUserInput = (requestId, answers) => { answered.push([requestId, answers]); };
  const { handle } = drive(session);
  const waiting = await handle.completion;
  assert.equal(waiting.status === 'waiting' && waiting.kind, 'user_input');
  await handle.input('src/a.ts');
  assert.deepEqual(answered, [[5, [{ id: 'q1', question: 'Which file?', answer: 'src/a.ts' }, { question: 'Why?', answer: 'src/a.ts' }]]]);
  assert.equal((await handle.continueAfterInput()).status, 'completed');
});

test('a host can map a user_input answer onto each question', async () => {
  const session = new ScriptedSession(async function* () {
    yield { kind: 'user_input_request', requestId: 6, questions: [question('Which file?', 'q1'), question('Why?')] };
    yield turnEnd();
  });
  const answered: unknown[] = [];
  session.respondToUserInput = (requestId, answers) => { answered.push([requestId, answers]); };
  const seen: unknown[] = [];
  const { handle } = drive(session, {
    answerUserInput: (text, questions) => {
      seen.push([text, questions.map((item) => item.question)]);
      const parts = text.split('|');
      return questions.map((item, index) => ({ ...(item.id ? { id: item.id } : {}), question: item.question, answer: parts[index] ?? '' }));
    },
  });
  assert.equal((await handle.completion).status, 'waiting');
  await handle.input('src/a.ts|it is broken');
  assert.deepEqual(seen, [['src/a.ts|it is broken', ['Which file?', 'Why?']]]);
  assert.deepEqual(answered, [[6, [{ id: 'q1', question: 'Which file?', answer: 'src/a.ts' }, { question: 'Why?', answer: 'it is broken' }]]]);
  assert.equal((await handle.continueAfterInput()).status, 'completed');
});

test('an answer the session rejects or cannot take leaves the interaction pending', async () => {
  for (const kind of ['permission', 'user_input'] as const) {
    const session = new ScriptedSession(async function* () {
      yield kind === 'permission'
        ? { kind: 'permission_request', requestId: 1, title: 'Write?', options: [] }
        : { kind: 'user_input_request', requestId: 1, questions: [question('Which?')] };
      yield turnEnd();
    });
    const { handle } = drive(session);
    assert.equal((await handle.completion).status, 'waiting');
    await assert.rejects(handle.input('allow'), new RegExp(`runtime fake cannot answer a pending ${kind} interaction`));
    assert.throws(() => handle.continueAfterInput(), /has not been answered/);

    let fail = true;
    const answer = () => { if (fail) { fail = false; throw new Error('runtime rejected the answer'); } };
    if (kind === 'permission') session.respondToPermission = answer;
    else session.respondToUserInput = answer;
    await assert.rejects(handle.input('allow'), /runtime rejected the answer/);
    assert.throws(() => handle.continueAfterInput(), /has not been answered/);
    await handle.input('allow');
    assert.equal((await handle.continueAfterInput()).status, 'completed');
  }
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

test('cancelling a waiting session cancels or skips its pending interaction and releases once', async () => {
  for (const kind of ['permission', 'user_input'] as const) {
    const session = new ScriptedSession(async function* () {
      yield kind === 'permission'
        ? { kind: 'permission_request', requestId: 9, title: 'Write?', options: [] }
        : { kind: 'user_input_request', requestId: 9, questions: [question('Which?')] };
    });
    session.cancelPermission = (requestId) => { session.log.push(`cancelPermission:${requestId}`); };
    session.skipUserInput = (requestId) => { session.log.push(`skipUserInput:${requestId}`); };
    const { handle, releases } = drive(session);
    assert.equal((await handle.completion).status, 'waiting');
    await handle.cancel();
    await handle.cancel();
    assert.equal(releases(), 1);
    assert(session.log.includes(kind === 'permission' ? 'cancelPermission:9' : 'skipUserInput:9'));
    assert(session.log.indexOf('cancel') < session.log.indexOf('release'), 'the session is cancelled before release');
  }
});

test('cancelling a running turn drops queued input and releases the session once', async () => {
  const { script, started, gate } = gatedTurns('one', ' two');
  const session = new ScriptedSession(script);
  session.onCancel = () => gate.resolve();
  const { handle, releases } = drive(session, { steering: 'next_turn' });
  await started.promise;
  await handle.input('never delivered');
  await handle.cancel();
  assert.deepEqual(await handle.completion, { status: 'cancelled' });
  assert.equal(releases(), 1);
  assert.deepEqual(session.sent, ['task']);
  assert(!session.log.includes('finalize'));
});

test('a native turn that ends normally after cancellation is cancelled, not finalized', async () => {
  const gate = deferred();
  const session = new ScriptedSession(async function* () {
    await gate.promise;
    yield turnEnd();
  });
  session.onCancel = () => gate.resolve();
  const { handle, releases } = drive(session);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await handle.cancel();
  assert.deepEqual(await handle.completion, { status: 'cancelled' });
  assert(!session.log.includes('finalize'));
  assert.equal(releases(), 1);
});

test('a stream error after cancellation is reported as a classified cancellation', async () => {
  const gate = deferred();
  const session = new ScriptedSession(async function* () {
    await gate.promise;
    yield { kind: 'runtime_error', error: 'process exited' };
  });
  session.onCancel = () => gate.resolve();
  const { handle } = drive(session);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const cancelling = handle.cancel();
  assert.deepEqual(await handle.completion, { status: 'cancelled',
    error: { category: 'transient', message: 'process exited', retryable: true } });
  await cancelling;
});

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

test('a native id known before the first turn is checkpointed up front and not repeated', async () => {
  const { script, started, gate } = gatedTurns('one', ' two');
  const session = new ScriptedSession(script);
  session.nativeSessionId = 'native-1';
  const { handle } = drive(session, { steering: 'next_turn' });
  await started.promise;
  await handle.input('extra');
  gate.resolve();
  assert.equal((await handle.completion).status, 'completed');
  assert.deepEqual(session.log.filter((line) => line.startsWith('checkpoint')), ['checkpoint:"native-1"']);
  assert.equal(session.log[0], 'checkpoint:"native-1"');
});

test('a native id learned during the first turn is checkpointed after that turn', async () => {
  const started = deferred();
  const gate = deferred();
  const session = new ScriptedSession(async function* (current, turn) {
    if (turn === 1) {
      current.nativeSessionId = 'native-late';
      yield chunk('one');
      started.resolve();
      await gate.promise;
    }
    yield turnEnd();
  });
  session.getNativeResumeToken = () => ({ engine: 'sdk', sessionId: session.nativeSessionId });
  const { handle } = drive(session, { steering: 'next_turn' });
  await started.promise;
  await handle.input('extra');
  gate.resolve();
  assert.equal((await handle.completion).status, 'completed');
  const checkpoint = 'checkpoint:{"engine":"sdk","sessionId":"native-late"}';
  assert.deepEqual(session.log.filter((line) => line.startsWith('checkpoint')), [checkpoint]);
  assert(session.log.indexOf(checkpoint) > session.log.indexOf('event:turn_end'), 'after the first turn');
  assert(session.log.indexOf(checkpoint) < session.log.indexOf('steering:applied:queued:extra'), 'before the second turn');
});

test('a changed resume token is checkpointed again after its turn', async () => {
  const { script, started, gate } = gatedTurns('one', ' two');
  const session = new ScriptedSession(async function* (current, turn) {
    if (turn === 2) current.nativeSessionId = 'native-2';
    yield* script(current, turn);
  });
  session.nativeSessionId = 'native-1';
  const { handle } = drive(session, { steering: 'next_turn' });
  await started.promise;
  await handle.input('extra');
  gate.resolve();
  assert.equal((await handle.completion).status, 'completed');
  assert.deepEqual(session.log.filter((line) => line.startsWith('checkpoint')), ['checkpoint:"native-1"', 'checkpoint:"native-2"']);
  assert(session.log.lastIndexOf('checkpoint:"native-2"') > session.log.lastIndexOf('event:turn_end'));
});

test('a cancelled session does not checkpoint a native id learned during its turn', async () => {
  const gate = deferred();
  const session = new ScriptedSession(async function* (current) {
    current.nativeSessionId = 'native-late';
    await gate.promise;
    yield turnEnd();
  });
  session.onCancel = () => gate.resolve();
  const { handle } = drive(session);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await handle.cancel();
  assert.deepEqual(await handle.completion, { status: 'cancelled' });
  assert.deepEqual(session.log.filter((line) => line.startsWith('checkpoint')), []);
});

test('a session paused on a durable interaction is checkpointed before it waits', async () => {
  const session = new ScriptedSession(async function* (current) {
    current.nativeSessionId = 'native-paused';
    yield { kind: 'permission_request', requestId: 2, title: 'Write?', options: [] };
    yield turnEnd();
  });
  session.respondToPermission = () => {};
  const { handle } = drive(session);
  assert.equal((await handle.completion).status, 'waiting');
  assert.deepEqual(session.log, ['send:task', 'event:permission_request', 'checkpoint:"native-paused"']);
  await handle.input('allow');
  assert.equal((await handle.continueAfterInput()).status, 'completed');
  assert.equal(session.log.filter((line) => line.startsWith('checkpoint')).length, 1, 'the unchanged token is not repeated');
});

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

test('a runtime_error event fails the session with a classified error and releases it', async () => {
  const session = new ScriptedSession(async function* () {
    yield chunk('partial');
    yield { kind: 'runtime_error', error: 'socket hang up' };
  });
  const { handle, releases } = drive(session);
  assert.deepEqual(await handle.completion, { status: 'failed',
    error: { category: 'transient', message: 'socket hang up', retryable: true } });
  assert.equal(releases(), 1);
  assert(!session.log.includes('finalize'));
});

test('a runtime_error event that carries its code and retryable is classified by them', async () => {
  const outcome = async (event: NormalizedEvent) =>
    drive(new ScriptedSession(async function* () { yield event; })).handle.completion;
  // The runtime's retryable wins over what the message suggests.
  assert.deepEqual(await outcome({ kind: 'runtime_error', error: 'socket hang up', code: 'connection', retryable: false }), {
    status: 'failed', error: { category: 'transient', message: 'socket hang up', retryable: false, code: 'connection' } });
  assert.deepEqual(await outcome({ kind: 'runtime_error', error: 'Model failed', retryable: true }), {
    status: 'failed', error: { category: 'terminal', message: 'Model failed', retryable: true } });
  // A code is the runtime's own name: it is passed through and never read as a category.
  assert.deepEqual(await outcome({ kind: 'runtime_error', error: 'Model failed', code: 'auth' }), {
    status: 'failed', error: { category: 'terminal', message: 'Model failed', retryable: false, code: 'auth' } });
});

test('a runtime_error event that carries a category is classified by it', async () => {
  const outcome = async (event: NormalizedEvent) =>
    drive(new ScriptedSession(async function* () { yield event; })).handle.completion;
  // The category sets the classification; retryable then follows the category.
  assert.deepEqual(await outcome({ kind: 'runtime_error', error: 'Model failed', category: 'auth' }), {
    status: 'failed', error: { category: 'auth', message: 'Model failed', retryable: false } });
  assert.deepEqual(await outcome({ kind: 'runtime_error', error: 'Model failed', category: 'capacity' }), {
    status: 'failed', error: { category: 'capacity', message: 'Model failed', retryable: true } });
  // A category the package does not know (from an untyped producer) falls back to inference.
  assert.deepEqual(await outcome({ kind: 'runtime_error', error: 'socket hang up', category: 'nonsense' as never }), {
    status: 'failed', error: { category: 'transient', message: 'socket hang up', retryable: true } });
  // Code and category each keep their own meaning when both are given.
  assert.deepEqual(await outcome({ kind: 'runtime_error', error: 'Model failed', code: 'capacity', category: 'auth', retryable: true }), {
    status: 'failed', error: { category: 'auth', message: 'Model failed', retryable: true, code: 'capacity' } });
});

test('classifyRuntimeError reads a reported error as it reads a plain one when the runtime gave no code or retryable', () => {
  for (const [error] of classifications) {
    if (!(error instanceof Error)) continue;
    const message = error.message;
    assert.deepEqual(classifyRuntimeError(new ReportedRuntimeError({ error: message })), classifyRuntimeError(new Error(message)));
  }
});

test('a reported error has only the fields the runtime gave', () => {
  const bare = new ReportedRuntimeError({ error: 'Model failed' });
  assert.deepEqual([Object.hasOwn(bare, 'code'), Object.hasOwn(bare, 'category'), Object.hasOwn(bare, 'retryable')], [false, false, false]);
  const full = new ReportedRuntimeError({ error: 'Model failed', code: 'auth', category: 'capacity', retryable: false });
  assert.deepEqual([full.message, full.code, full.category, full.retryable, full.name], ['Model failed', 'auth', 'capacity', false, 'ReportedRuntimeError']);
});

test('a turn that ends with an error fails instead of completing empty', async () => {
  const session = new ScriptedSession(async function* () { yield turnEnd('error'); });
  const { handle } = drive(session, { steering: 'next_turn' });
  assert.deepEqual(await handle.completion, { status: 'failed',
    error: { category: 'terminal', message: 'Runtime turn ended with an error', retryable: false } });
});

test('a failed release replaces a completed outcome with a failure', async () => {
  const session = new ScriptedSession(async function* () { yield turnEnd(); });
  const { handle } = drive(session, { release: () => { throw new Error('release timed out'); } });
  assert.deepEqual(await handle.completion, { status: 'failed',
    error: { category: 'transient', message: 'release timed out', retryable: true } });
});

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Triggers every message the driver produces and returns what each one said. */
async function observedMessages(messages?: Partial<HeadlessDriverMessages>): Promise<Record<keyof HeadlessDriverMessages, string>> {
  const options = messages ? { messages } : {};
  const rejection = async (promise: Promise<unknown>) => {
    try { await promise; } catch (error) { return (error as Error).message; }
    assert.fail('expected a rejection');
  };

  const done = drive(new ScriptedSession(async function* () { yield turnEnd(); }), options);
  await done.handle.completion;
  const inputRejected = await rejection(done.handle.input('x'));

  const none = drive(new ScriptedSession(gatedTurns('a', '').script), { ...options, steering: 'none' });
  const steeringUnsupported = await rejection(none.handle.input('x'));

  const steerUnavailable = await rejection(drive(new ScriptedSession(gatedTurns('a', '').script), options).handle.input('x'));

  const refusing = new ScriptedSession(gatedTurns('a', '').script);
  refusing.steer = async () => ({ accepted: false });
  const steerRejected = await rejection(drive(refusing, options).handle.input('x'));

  const waiting = drive(new ScriptedSession(async function* () {
    yield { kind: 'permission_request', requestId: 1, title: 'Write?', options: [] };
  }), options);
  await waiting.handle.completion;
  const interactionUnanswered = (() => {
    try { waiting.handle.continueAfterInput(); } catch (error) { return (error as Error).message; }
    assert.fail('expected a synchronous throw');
  })();
  const cannotAnswerInteraction = await rejection(waiting.handle.input('allow'));

  const failed = await drive(new ScriptedSession(async function* () { yield turnEnd('error'); }), options).handle.completion;
  assert.equal(failed.status, 'failed');
  const turnFailed = failed.status === 'failed' ? failed.error.message : '';

  return { inputRejected, steeringUnsupported, steerUnavailable, steerRejected, interactionUnanswered, cannotAnswerInteraction, turnFailed };
}

test('driver messages default to neutral wording', async () => {
  assert.deepEqual(await observedMessages(), {
    inputRejected: 'session has already completed or is finalizing; supplemental input rejected',
    steeringUnsupported: 'runtime fake does not support supplemental input',
    steerUnavailable: 'runtime fake does not support session steering',
    steerRejected: 'runtime rejected session steering',
    interactionUnanswered: 'session interaction has not been answered',
    cannotAnswerInteraction: 'runtime fake cannot answer a pending permission interaction',
    turnFailed: 'Runtime turn ended with an error',
  });
});

test('host messages replace the defaults they name and keep the rest', async () => {
  const messages: HeadlessDriverMessages = {
    inputRejected: 'too late',
    steeringUnsupported: (runtimeId) => `${runtimeId}: no input`,
    steerUnavailable: (runtimeId) => `${runtimeId}: no steer`,
    steerRejected: 'steer refused',
    interactionUnanswered: 'answer first',
    cannotAnswerInteraction: (runtimeId, kind) => `${runtimeId} cannot take ${kind}`,
    turnFailed: 'turn broke',
  };
  assert.deepEqual(await observedMessages(messages), {
    inputRejected: 'too late',
    steeringUnsupported: 'fake: no input',
    steerUnavailable: 'fake: no steer',
    steerRejected: 'steer refused',
    interactionUnanswered: 'answer first',
    cannotAnswerInteraction: 'fake cannot take permission',
    turnFailed: 'turn broke',
  });
  const partial = await observedMessages({ inputRejected: 'too late' });
  assert.equal(partial.inputRejected, 'too late');
  assert.equal(partial.steerRejected, 'runtime rejected session steering');
});

test('a message override set to undefined keeps the default, and the defaults are frozen', async () => {
  const observed = await observedMessages({ inputRejected: undefined, steeringUnsupported: undefined });
  assert.equal(observed.inputRejected, 'session has already completed or is finalizing; supplemental input rejected');
  assert.equal(observed.steeringUnsupported, 'runtime fake does not support supplemental input');
  assert(Object.isFrozen(DEFAULT_HEADLESS_DRIVER_MESSAGES));
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

const classifications: Array<[unknown, RuntimeErrorCategory, boolean]> = [
  [new Error('missing API key'), 'auth', false],
  [new Error('bad api_key'), 'auth', false],
  [new Error('apikey rejected'), 'auth', false],
  [new Error('no credentials found'), 'auth', false],
  [new Error('401 Unauthorized'), 'auth', false],
  [new Error('request unauthorised'), 'auth', false],
  [new Error('403 Forbidden'), 'auth', false],
  [new Error('please re-auth'), 'auth', false],
  [Object.assign(new Error('nope'), { name: 'AuthError' }), 'auth', false],
  [new Error('unsupported mode'), 'incompatible', false],
  [new Error('feature not supported'), 'incompatible', false],
  [new Error('unknown model x'), 'incompatible', false],
  [new Error('invalid model y'), 'incompatible', false],
  [new Error('incompatible profile'), 'incompatible', false],
  [new Error('at capacity'), 'capacity', true],
  [new Error('concurrency limit reached'), 'capacity', true],
  [new Error('concurrent sessions exceeded'), 'capacity', true],
  [new Error('rate limit hit'), 'capacity', true],
  [new Error('ratelimited'), 'capacity', true],
  [new Error('too many requests'), 'capacity', true],
  [new Error('request timeout'), 'transient', true],
  [new Error('process timed out'), 'transient', true],
  [new Error('connect ECONNREFUSED'), 'transient', true],
  [new Error('socket hang up'), 'transient', true],
  [new Error('process exited with code 1'), 'transient', true],
  [new Error('temporarily unavailable'), 'transient', true],
  [new Error('temporary failure'), 'transient', true],
  [new Error('something else'), 'terminal', false],
  ['plain string timeout', 'transient', true],
  [42, 'terminal', false],
  // First match wins, in the order auth, incompatible, capacity, transient.
  [new Error('unsupported auth flow'), 'auth', false],
  [new Error('unsupported: too many'), 'incompatible', false],
  [new Error('rate limit timeout'), 'capacity', true],
];

for (const [error, category, retryable] of classifications) {
  const label = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  test(`classifyRuntimeError: ${label} -> ${category}`, () => {
    const message = error instanceof Error ? error.message : String(error);
    assert.deepEqual(classifyRuntimeError(error), { category, message, retryable });
  });
}
