import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSessionState } from 'michi-shared';
import type { AgentSession } from '../src/contract/types';
import { createSessionStateFeed } from '../src/core/sessionStateFeed';

type StatefulSession = AgentSession & { emit(): void; detached: number; hooked: number };

function stateful(id: string, extra: Partial<AgentSession> = {}): StatefulSession {
  let notify: (() => void) | undefined;
  let version = 0;
  const session = {
    id, runtimeId: 'pi', getHistory: () => [], getPendingAssistant: () => undefined,
    async *send() {}, cancel: () => {},
    getSessionState: (): AgentSessionState => ({ runtimeId: 'pi', version }),
    onSessionState: (fn: () => void) => {
      session.hooked += 1;
      notify = fn;
      return () => { session.detached += 1; notify = undefined; };
    },
    ...extra,
  } as StatefulSession;
  session.detached = 0;
  session.hooked = 0;
  session.emit = () => { version += 1; notify?.(); };
  return session;
}

test('track publishes the current state at once and on every change', () => {
  const persisted: Array<[string, string | null, number | undefined]> = [];
  const feed = createSessionStateFeed({ onSessionStateChanged: (s, owner, state) => persisted.push([s.id, owner, state.version]) });
  const session = stateful('n');
  feed.track(session, 'alice');
  session.emit();
  assert.deepEqual(persisted, [['n', 'alice', 0], ['n', 'alice', 1]]);
});

test('tracking an id again detaches the earlier object, which stops publishing', () => {
  const persisted: string[] = [];
  const feed = createSessionStateFeed({ onSessionStateChanged: (_s, owner) => persisted.push(String(owner)) });
  const old = stateful('n');
  const next = stateful('n');
  feed.track(old, 'alice');
  feed.track(next, 'bob');
  assert.equal(old.detached, 1);
  old.emit();
  assert.deepEqual(persisted, ['alice', 'bob']);
});

test('an object that keeps calling notify after detach publishes nothing once replaced or untracked', () => {
  // Unlike stateful(), detach() here does not drop the callback, so only the
  // feed's own "still the tracked object" check can silence it.
  const leaky = (id: string, tag: string) => {
    const callbacks: Array<() => void> = [];
    const session = {
      id, runtimeId: 'pi', getHistory: () => [], getPendingAssistant: () => undefined,
      async *send() {}, cancel: () => {},
      getSessionState: (): AgentSessionState => ({ runtimeId: 'pi', modelId: tag }),
      onSessionState: (fn: () => void) => { callbacks.push(fn); return () => { session.detached += 1; }; },
      detached: 0,
      fire: () => { for (const fn of callbacks) fn(); },
    };
    return session;
  };
  const persisted: Array<string | null | undefined> = [];
  const received: Array<string | null | undefined> = [];
  const feed = createSessionStateFeed({ onSessionStateChanged: (_s, _owner, state) => persisted.push(state.modelId) });
  feed.subscribe((_id, state) => received.push(state.modelId));
  const old = leaky('n', 'old');
  const next = leaky('n', 'next');
  feed.track(old, 'alice');
  feed.track(next, 'bob');
  assert.equal(old.detached, 1);
  persisted.length = 0;
  received.length = 0;

  old.fire();
  assert.deepEqual(persisted, []);
  assert.deepEqual(received, []);
  next.fire();
  assert.deepEqual(received, ['next']);

  feed.untrack('n');
  assert.equal(next.detached, 1);
  next.fire();
  assert.deepEqual(persisted, ['next']);
  assert.deepEqual(received, ['next']);
});

test('Agent Run sessions and sessions without state are not tracked', () => {
  const persisted: string[] = [];
  const feed = createSessionStateFeed({ onSessionStateChanged: (s) => persisted.push(s.id) });
  const run = stateful('run', { owner: { mode: 'headless', key: 'run' } });
  feed.track(run, 'alice');
  const stateless = stateful('plain');
  delete stateless.getSessionState;
  feed.track(stateless, 'alice');
  assert.equal(run.hooked + stateless.hooked, 0);
  assert.deepEqual(persisted, []);
  const replay: string[] = [];
  feed.subscribe((id) => replay.push(id))();
  assert.deepEqual(replay, []);
});

test('untrack and clear detach; listeners stay subscribed after clear', () => {
  const feed = createSessionStateFeed();
  const a = stateful('a');
  const b = stateful('b');
  feed.track(a, null);
  feed.track(b, null);
  const seen: string[] = [];
  feed.subscribe((id) => seen.push(id));
  seen.length = 0;
  feed.untrack('a');
  assert.equal(a.detached, 1);
  feed.clear();
  assert.equal(b.detached, 1);
  a.emit();
  b.emit();
  assert.deepEqual(seen, []);
  feed.track(stateful('c'), null);
  assert.deepEqual(seen, ['c']);
});

test('subscribe filters replay and changes by ownerUserId; undefined receives everything, null only null owners', () => {
  const feed = createSessionStateFeed();
  const alice = stateful('a');
  const nobody = stateful('z');
  feed.track(alice, 'alice');
  feed.track(nobody, null);
  const forAlice: string[] = [];
  const forNull: string[] = [];
  const forAll: string[] = [];
  feed.subscribe((id) => forAlice.push(id), 'alice');
  feed.subscribe((id) => forNull.push(id), null);
  const stopAll = feed.subscribe((id) => forAll.push(id));
  alice.emit();
  nobody.emit();
  stopAll();
  alice.emit();
  assert.deepEqual(forAlice, ['a', 'a', 'a']);
  assert.deepEqual(forNull, ['z', 'z']);
  assert.deepEqual(forAll, ['a', 'z', 'a', 'z']);
});

test('a throwing persistence hook is logged once per change and listeners still receive the state', () => {
  const logs: unknown[][] = [];
  const feed = createSessionStateFeed({
    onSessionStateChanged: () => { throw new Error('disk full'); },
    log: (...args) => logs.push(args),
  });
  const received: Array<number | undefined> = [];
  feed.subscribe((_id, state) => received.push(state.version));
  const session = stateful('n');
  feed.track(session, 'alice');
  session.emit();
  assert.deepEqual(received, [0, 1]);
  assert.deepEqual(logs.map((entry) => entry.slice(0, 3)), [
    ['warn', 'session-state', 'could not persist session settings'],
    ['warn', 'session-state', 'could not persist session settings'],
  ]);
});

test('works with no options', () => {
  const feed = createSessionStateFeed();
  const received: string[] = [];
  feed.subscribe((id) => received.push(id));
  feed.track(stateful('n'), 'alice');
  assert.deepEqual(received, ['n']);
});
