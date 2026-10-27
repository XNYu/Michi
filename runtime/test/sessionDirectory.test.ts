import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSessionState } from 'michi-shared';
import type { AgentSession, RuntimeSessionOwner } from '../src/contract/types';
import {
  HISTORY_STUB_TTL_MS,
  createSessionDirectory,
  type SessionDirectoryOptions,
} from '../src/core/sessionDirectory';
import { createSessionStateFeed } from '../src/core/sessionStateFeed';
import { ownerMode } from '../src/contract/host';
import { createDefaultHost } from '../src/core/defaultHost';
import { headless, interactive } from './owners';

type StatefulSession = AgentSession & { emit(): void; detached: number };

function plain(id: string, extra: Partial<AgentSession> = {}): AgentSession {
  return {
    id, runtimeId: 'pi', getHistory: () => [], getPendingAssistant: () => undefined,
    async *send() {}, cancel: () => {}, ...extra,
  };
}

function stateful(id: string, extra: Partial<AgentSession> = {}): StatefulSession {
  let notify: (() => void) | undefined;
  let version = 0;
  const session = plain(id, {
    getSessionState: (): AgentSessionState => ({ runtimeId: 'pi', version }),
    onSessionState: (fn) => {
      notify = fn;
      return () => { session.detached += 1; notify = undefined; };
    },
    ...extra,
  }) as StatefulSession;
  session.detached = 0;
  session.emit = () => { version += 1; notify?.(); };
  return session;
}

function directory(overrides: Partial<SessionDirectoryOptions> = {}) {
  return createSessionDirectory({ enforceUserOwnership: () => false, ...overrides });
}

const runOwner = headless('attempt-1');

describe('history stubs', () => {
  test('TTL eviction removes expired stubs but never live sessions', () => {
    const dir = directory();
    assert.equal(dir.insertStub(plain('child', { parentChatId: 'root' }), interactive('child')), true);
    assert.equal(dir.insertStub(plain('root'), interactive('root')), true);
    const live = plain('live-session');
    dir.register(live, 'owner-1');

    assert.equal(dir.evictStubs({ now: Date.now() + HISTORY_STUB_TTL_MS + 1 }), 2);
    assert.equal(dir.get('child'), undefined);
    assert.equal(dir.get('root'), undefined);
    assert.equal(dir.get('live-session'), live);
  });

  test('evicts least-recently-used stubs above the cap; a read refreshes LRU position', () => {
    const realNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
      const dir = directory();
      for (const id of ['first', 'second', 'third']) {
        dir.insertStub(plain(id), interactive(id));
        now += 1;
      }
      assert.ok(dir.get('first'), 'reading a stub refreshes its LRU position');
      now += 1;

      assert.equal(dir.evictStubs({ now, maxEntries: 2 }), 1);
      assert.ok(dir.peek('first'));
      assert.equal(dir.peek('second'), undefined);
      assert.ok(dir.peek('third'));
    } finally {
      Date.now = realNow;
    }
  });

  test('protected stubs survive TTL and cap but count against the cap', () => {
    const realNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
      const dir = directory({ stubMaxEntries: 2 });
      for (const id of ['a', 'b', 'c']) {
        dir.insertStub(plain(id), interactive(id));
        now += 1;
      }
      assert.equal(dir.evictStubs({ protectedIds: new Set(['a', 'b', 'c']) }), 0);
      // a, b protected: the cap of 2 leaves no room for c.
      assert.equal(dir.evictStubs({ protectedIds: new Set(['a', 'b']) }), 1);
      assert.deepEqual(['a', 'b', 'c'].map((id) => !!dir.peek(id)), [true, true, false]);
      assert.equal(dir.evictStubs({ now: now + HISTORY_STUB_TTL_MS + 1, protectedIds: new Set(['a']) }), 1);
      assert.deepEqual(['a', 'b'].map((id) => !!dir.peek(id)), [true, false]);
    } finally {
      Date.now = realNow;
    }
  });

  test('stubTtlMs and stubMaxEntries options replace the defaults', () => {
    const dir = directory({ stubTtlMs: 10, stubMaxEntries: 1 });
    dir.insertStub(plain('x'), interactive('x'));
    assert.equal(dir.evictStubs({ now: Date.now() + 5 }), 0);
    assert.equal(dir.evictStubs({ now: Date.now() + 11 }), 1);
    dir.insertStub(plain('y'), interactive('y'));
    dir.insertStub(plain('z'), interactive('z'));
    assert.equal(dir.evictStubs(), 1);
  });

  test('a stub never replaces an entry, and a live registration replaces a stub', () => {
    const dir = directory();
    const live = plain('n');
    dir.register(live, 'alice');
    assert.equal(dir.insertStub(plain('n'), interactive('n')), false);
    assert.equal(dir.peek('n')?.session, live);
    assert.equal(dir.peek('n')?.kind, 'live');

    assert.equal(dir.insertStub(plain('s'), interactive('s')), true);
    assert.equal(dir.peek('s')?.kind, 'stub');
    assert.equal(dir.peek('s')?.ownerUserId, null);
    const replacement = plain('s');
    dir.register(replacement, 'bob');
    assert.equal(dir.peek('s')?.kind, 'live');
    assert.equal(dir.peek('s')?.session, replacement);
    assert.equal(dir.evictStubs({ now: Date.now() + HISTORY_STUB_TTL_MS + 1 }), 0);
  });
});

describe('registration and lookup', () => {
  test('the last registration wins and owner defaults to session.owner, then the interactive owner of its id', () => {
    const dir = directory();
    const first = plain('id-1');
    const second = plain('id-1', { owner: runOwner });
    dir.register(first, 'alice');
    assert.deepEqual(dir.peek('id-1')?.owner, { mode: 'interactive', key: 'id-1' }, 'a mode and a key, nothing else');
    dir.register(second, 'bob');
    const entry = dir.peek('id-1');
    assert.equal(entry?.session, second);
    assert.equal(entry?.ownerUserId, 'bob');
    assert.deepEqual(entry?.owner, runOwner);
    dir.register(second);
    assert.equal(dir.peek('id-1')?.ownerUserId, null);
  });

  test('entries() lists snapshots in insertion order; re-registering keeps the position', () => {
    const dir = directory();
    dir.register(plain('a'), 'alice');
    dir.insertStub(plain('b'), interactive('b'));
    dir.register(plain('c'), 'carol');
    const replacement = plain('a');
    dir.register(replacement, 'dave');
    const listed = dir.entries();
    assert.deepEqual(listed.map((entry) => [entry.session.id, entry.kind, entry.ownerUserId]), [
      ['a', 'live', 'dave'], ['b', 'stub', null], ['c', 'live', 'carol'],
    ]);
    assert.equal(listed[0].session, replacement);
    listed.length = 0;
    assert.equal(dir.entries().length, 3);
  });

  test('get and getForUser refresh live sessions through touch(); peek does not', () => {
    let touched = 0;
    const dir = directory();
    dir.register(plain('n', { touch: () => { touched += 1; } }), 'alice');
    dir.peek('n');
    dir.entries();
    assert.equal(touched, 0);
    dir.get('n');
    dir.getForUser('n', 'alice');
    dir.getForOwner('n', interactive('n'), 'alice');
    assert.equal(touched, 3);
    assert.equal(dir.matchesOwner('n', interactive('n')), true);
    assert.equal(touched, 3);
  });

  test('enforceUserOwnership is read on every lookup, and null owners are rejected while it holds', () => {
    let cloud = false;
    const dir = directory({ enforceUserOwnership: () => cloud });
    const owned = plain('owned');
    const unowned = plain('unowned');
    dir.register(owned, 'alice');
    dir.register(unowned);
    const chat = interactive;

    assert.equal(dir.getForUser('owned', 'bob'), owned);
    assert.equal(dir.getForUser('unowned', 'bob'), unowned);
    assert.equal(dir.getForOwner('owned', chat('owned'), null), owned);

    cloud = true;
    assert.equal(dir.getForUser('owned', 'bob'), null);
    assert.equal(dir.getForUser('owned', null), null);
    assert.equal(dir.getForUser('owned', 'alice'), owned);
    assert.equal(dir.getForUser('unowned', 'bob'), null);
    assert.equal(dir.getForUser('unowned', null), unowned, 'ownership is strict equality, so a null user matches a null owner');
    assert.equal(dir.getForOwner('owned', chat('owned'), 'bob'), null);
    assert.equal(dir.getForOwner('owned', chat('owned'), 'alice'), owned);
    assert.equal(dir.getForUser('missing', 'alice'), null);
    assert.equal(dir.get('owned'), owned, 'get() is the trusted lookup and never checks the user');

    cloud = false;
    assert.equal(dir.getForUser('owned', 'bob'), owned);
  });

  test('while enforced, a null-owner entry is rejected for every real user', () => {
    const dir = directory({ enforceUserOwnership: () => true });
    const session = plain('n');
    dir.register(session, null);
    assert.equal(dir.getForUser('n', 'alice'), null);
    assert.equal(dir.getForOwner('n', interactive('n'), 'alice'), null);
    assert.equal(dir.getForUser('n', null), session);
  });

  test('while enforced, a null user never reaches a user-owned session, even with the exact owner', () => {
    const dir = directory({ enforceUserOwnership: () => true });
    const session = plain(runOwner.key, { owner: runOwner });
    dir.register(session, 'alice', runOwner);
    dir.register(plain('chat'), 'alice');
    const chatOwner = interactive('chat');

    assert.equal(dir.getForOwner(session.id, { ...runOwner }, null), null);
    assert.equal(dir.getForOwner('chat', chatOwner, null), null);
    assert.equal(dir.getForUser('chat', null), null);
    assert.equal(dir.getForOwner(session.id, { ...runOwner }, 'alice'), session);
  });

  test('owner-scoped lookup and release require the same owner key and mode', () => {
    const dir = directory({ enforceUserOwnership: () => true });
    const session = plain(runOwner.key, { owner: runOwner });
    dir.register(session, 'user-1', runOwner);
    for (const wrongOwner of [
      headless('attempt-2'),
      interactive(runOwner.key),
    ]) {
      assert.equal(dir.getForOwner(session.id, wrongOwner, 'user-1'), null);
      assert.equal(dir.matchesOwner(session.id, wrongOwner), false);
      assert.equal(dir.dropForOwner(session.id, wrongOwner), false);
      assert.equal(dir.get(session.id), session);
    }
    assert.equal(dir.getForOwner(session.id, { ...runOwner }, 'user-2'), null);
    assert.equal(dir.getForOwner(session.id, { ...runOwner }, 'user-1'), session);
    assert.equal(dir.dropForOwner(session.id, { ...runOwner }), true);
    assert.equal(dir.get(session.id), undefined);
    assert.equal(dir.dropForOwner(session.id, { ...runOwner }), false);
  });

  test('two directories never see each other', () => {
    const left = directory();
    const right = directory();
    const session = stateful('shared-id');
    left.register(session, 'alice');
    const seen: string[] = [];
    right.subscribeStates((id) => seen.push(id));
    session.emit();

    assert.equal(left.get('shared-id'), session);
    assert.equal(right.get('shared-id'), undefined);
    assert.equal(right.peek('shared-id'), undefined);
    assert.deepEqual(seen, []);
    right.clear();
    assert.equal(left.get('shared-id'), session);
    right.insertStub(plain('stub'), interactive('stub'));
    assert.equal(left.peek('stub'), undefined);
  });

  test('clear drops every entry and state tracking but keeps subscribers', () => {
    const dir = directory();
    const first = stateful('a');
    dir.register(first, 'alice');
    dir.insertStub(plain('stub'), interactive('stub'));
    const seen: string[] = [];
    dir.subscribeStates((id) => seen.push(id));
    seen.length = 0;

    dir.clear();
    assert.equal(dir.get('a'), undefined);
    assert.equal(dir.get('stub'), undefined);
    assert.equal(first.detached, 1);
    first.emit();
    assert.deepEqual(seen, []);

    dir.register(stateful('b'), 'alice');
    assert.deepEqual(seen, ['b']);
  });

  test('rejects a missing ownership predicate and a state feed combined with its hooks', () => {
    assert.throws(() => createSessionDirectory({} as SessionDirectoryOptions), TypeError);
    assert.throws(() => createSessionDirectory({ enforceUserOwnership: true } as unknown as SessionDirectoryOptions), TypeError);
    assert.throws(() => createSessionDirectory({
      enforceUserOwnership: () => false,
      stateFeed: createSessionStateFeed(),
      onSessionStateChanged: () => {},
    }), TypeError);
    assert.throws(() => createSessionDirectory({
      enforceUserOwnership: () => false,
      stateFeed: createSessionStateFeed(),
      log: () => {},
    }), TypeError);
    assert.throws(() => createSessionDirectory({
      enforceUserOwnership: () => false,
      stateFeed: createSessionStateFeed(),
      onSessionStateChanged: () => {},
      log: () => {},
    }), TypeError);
  });
});

describe('session state', () => {
  test('only chat-node owners track state; re-registering as an Agent Run stops tracking', () => {
    const persisted: string[] = [];
    const dir = directory({ onSessionStateChanged: (session) => persisted.push(session.id) });
    const session = stateful('n');
    dir.register(session, 'alice');
    assert.deepEqual(persisted, ['n'], 'registration publishes the current state');
    session.emit();
    assert.deepEqual(persisted, ['n', 'n']);

    dir.register(session, 'alice', runOwner);
    assert.equal(session.detached, 1);
    session.emit();
    assert.deepEqual(persisted, ['n', 'n']);
    const replay: string[] = [];
    dir.subscribeStates((id) => replay.push(id))();
    assert.deepEqual(replay, []);
  });

  test('a session whose own owner is an Agent Run is not tracked even under a chat-node owner', () => {
    const persisted: string[] = [];
    const dir = directory({ onSessionStateChanged: (session) => persisted.push(session.id) });
    const session = stateful('a', { owner: runOwner });
    dir.register(session, 'alice', interactive('a'));
    session.emit();
    assert.deepEqual(persisted, []);
  });

  test('re-registering replaces the tracked object; the old object stops publishing', () => {
    const persisted: Array<[string, string | null]> = [];
    const dir = directory({ onSessionStateChanged: (session, owner) => persisted.push([session.id, owner]) });
    const old = stateful('n');
    const next = stateful('n');
    dir.register(old, 'alice');
    dir.register(next, 'bob');
    assert.equal(old.detached, 1);
    old.emit();
    next.emit();
    assert.deepEqual(persisted, [['n', 'alice'], ['n', 'bob'], ['n', 'bob']]);
  });

  test('drop and dropForOwner detach state listeners', () => {
    const dir = directory();
    const first = stateful('a');
    const second = stateful('b');
    dir.register(first, 'alice');
    dir.register(second, 'alice');
    dir.drop('a');
    assert.equal(first.detached, 1);
    assert.equal(dir.dropForOwner('b', interactive('other')), false);
    assert.equal(second.detached, 0);
    assert.equal(dir.dropForOwner('b', interactive('b')), true);
    assert.equal(second.detached, 1);
  });

  test('a throwing persistence hook is logged and listeners are still notified', () => {
    const logs: unknown[][] = [];
    const dir = directory({
      onSessionStateChanged: () => { throw new Error('disk full'); },
      log: (...args) => logs.push(args),
    });
    const received: string[] = [];
    dir.subscribeStates((id) => received.push(id));
    const session = stateful('n');
    dir.register(session, 'alice');
    session.emit();

    assert.deepEqual(received, ['n', 'n']);
    assert.equal(logs.length, 2);
    assert.deepEqual(logs[0], ['warn', 'session-state', 'could not persist session settings', { sessionId: 'n', error: 'Error: disk full' }]);
  });

  test('a throwing log sink or listener does not stop other listeners', () => {
    const dir = directory({
      onSessionStateChanged: () => { throw new Error('disk full'); },
      log: () => { throw new Error('log down'); },
    });
    const received: string[] = [];
    dir.subscribeStates(() => { throw new Error('closed socket'); });
    dir.subscribeStates((id) => received.push(id));
    dir.register(stateful('n'), 'alice');
    assert.deepEqual(received, ['n']);
  });

  test('subscribeStates replays current state filtered by ownerUserId, then delivers later changes', () => {
    const dir = directory();
    const alice = stateful('a');
    const bob = stateful('b');
    const nobody = stateful('c');
    dir.register(alice, 'alice');
    dir.register(bob, 'bob');
    dir.register(nobody, null);

    const forAlice: Array<[string, number | undefined]> = [];
    const forNull: string[] = [];
    const forAll: string[] = [];
    const stopAlice = dir.subscribeStates((id, state) => forAlice.push([id, state.version]), 'alice');
    dir.subscribeStates((id) => forNull.push(id), null);
    dir.subscribeStates((id) => forAll.push(id));
    assert.deepEqual(forAlice, [['a', 0]]);
    assert.deepEqual(forNull, ['c']);
    assert.deepEqual(forAll, ['a', 'b', 'c']);

    alice.emit();
    bob.emit();
    assert.deepEqual(forAlice, [['a', 0], ['a', 1]]);
    assert.deepEqual(forAll, ['a', 'b', 'c', 'a', 'b']);

    stopAlice();
    alice.emit();
    assert.equal(forAlice.length, 2);
  });
});

describe('state feed port', () => {
  test('without stateFeed the directory builds its own feed from onSessionStateChanged and log', () => {
    const persisted: Array<[string, string | null, number | undefined]> = [];
    const logs: unknown[][] = [];
    let fail = false;
    const dir = directory({
      onSessionStateChanged: (session, ownerUserId, state) => {
        persisted.push([session.id, ownerUserId, state.version]);
        if (fail) throw new Error('disk full');
      },
      log: (...args) => logs.push(args),
    });
    const received: Array<[string, number | undefined]> = [];
    dir.subscribeStates((id, state) => received.push([id, state.version]), 'alice');
    const session = stateful('n');
    dir.register(session, 'alice');
    fail = true;
    session.emit();

    assert.deepEqual(persisted, [['n', 'alice', 0], ['n', 'alice', 1]]);
    assert.deepEqual(received, [['n', 0], ['n', 1]], 'a failed persist still reaches listeners');
    assert.deepEqual(logs, [['warn', 'session-state', 'could not persist session settings', { sessionId: 'n', error: 'Error: disk full' }]]);
  });

  test('with stateFeed the directory drives state only through its four methods and builds no feed of its own', () => {
    const calls: unknown[][] = [];
    const unsubscribe = () => {};
    const port = {
      track: (session: AgentSession, ownerUserId: string | null) => { calls.push(['track', session.id, ownerUserId]); },
      untrack: (sessionId: string) => { calls.push(['untrack', sessionId]); },
      clear: () => { calls.push(['clear']); },
      subscribe: (receive: unknown, ownerUserId?: string | null) => {
        calls.push(['subscribe', typeof receive, ownerUserId]);
        return unsubscribe;
      },
    };
    const dir = directory({ stateFeed: port });
    let stateReads = 0;
    let stateHooks = 0;
    const watched = (id: string, extra: Partial<AgentSession> = {}) => plain(id, {
      getSessionState: () => { stateReads += 1; return { runtimeId: 'pi' }; },
      onSessionState: () => { stateHooks += 1; return () => {}; },
      ...extra,
    });

    dir.register(watched('chat'), 'alice');
    dir.register(watched('chat'));
    dir.register(watched('run', { owner: runOwner }), 'alice', runOwner);
    dir.insertStub(watched('stub'), interactive('stub'));
    dir.get('chat');
    dir.getForUser('chat', 'alice');
    dir.evictStubs({ now: Date.now() + HISTORY_STUB_TTL_MS + 1 });
    assert.equal(dir.subscribeStates(() => {}, 'alice'), unsubscribe);
    dir.subscribeStates(() => {});
    dir.drop('chat');
    assert.equal(dir.dropForOwner('run', headless('other')), false);
    assert.equal(dir.dropForOwner('run', runOwner), true);
    dir.clear();

    assert.deepEqual(calls, [
      ['track', 'chat', 'alice'],
      ['track', 'chat', null],
      ['untrack', 'run'],
      ['subscribe', 'function', 'alice'],
      ['subscribe', 'function', undefined],
      ['untrack', 'chat'],
      ['untrack', 'run'],
      ['clear'],
    ]);
    assert.equal(stateReads, 0, 'no internal feed read session state');
    assert.equal(stateHooks, 0, 'no internal feed attached to onSessionState');
  });

  test('a host-supplied real feed sees the directory registrations', () => {
    const feed = createSessionStateFeed();
    const dir = directory({ stateFeed: feed });
    const seen: string[] = [];
    feed.subscribe((id) => seen.push(id));
    dir.register(stateful('n'), 'alice');
    assert.deepEqual(seen, ['n']);
    dir.drop('n');
    const replay: string[] = [];
    feed.subscribe((id) => replay.push(id))();
    assert.deepEqual(replay, []);
  });
});

describe('owner modes and host hooks', () => {
  test('state tracking follows ownerMode: interactive owners are tracked, headless ones are not', () => {
    const owners: RuntimeSessionOwner[] = [interactive('n'), runOwner];
    for (const owner of owners) {
      const isInteractive = ownerMode(owner) === 'interactive';
      const persisted: string[] = [];
      const dir = directory({ onSessionStateChanged: (session) => persisted.push(session.id) });
      dir.register(stateful('registered'), 'alice', owner);
      // The session's own owner decides too, whatever owner it is registered under.
      dir.register(stateful('own', { owner }), 'alice', interactive('own'));
      assert.deepEqual(persisted, isInteractive ? ['registered', 'own'] : [], owner.mode);
    }
  });

  test('an owner mode outside the contract throws before register changes anything', () => {
    const persisted: string[] = [];
    const dir = directory({ onSessionStateChanged: (session) => persisted.push(session.id) });
    const first = stateful('n');
    dir.register(first, 'alice');
    const bogus = { mode: 'bogus', key: 'n' } as unknown as RuntimeSessionOwner;
    assert.throws(() => dir.register(stateful('n'), 'bob', bogus), /Unknown runtime session owner/);
    const entry = dir.peek('n');
    assert.equal(entry?.session, first, 'the earlier entry stays');
    assert.equal(entry?.ownerUserId, 'alice');
    first.emit();
    assert.deepEqual(persisted, ['n', 'n'], 'and so does its state tracking');
  });

  test('with a host, the directory\'s feed persists through host.onSessionStateChanged and logs to host.observability.log', () => {
    const persisted: Array<[string, string | null, number | undefined]> = [];
    const logs: unknown[][] = [];
    let fail = false;
    const host = createDefaultHost({
      ports: {
        onSessionStateChanged: (session, ownerUserId, state) => {
          persisted.push([session.id, ownerUserId, state.version]);
          if (fail) throw new Error('disk full');
        },
        observability: { log: (...args) => { logs.push(args); } },
      },
    });
    const dir = directory({ host });
    const session = stateful('n');
    dir.register(session, 'alice');
    fail = true;
    session.emit();

    assert.deepEqual(persisted, [['n', 'alice', 0], ['n', 'alice', 1]]);
    assert.deepEqual(logs, [['warn', 'session-state', 'could not persist session settings', { sessionId: 'n', error: 'Error: disk full' }]]);

    // Read at call time: a host without the hook persists nothing and still works.
    const bare = createDefaultHost({ logLevel: 'silent' });
    const plainDir = directory({ host: bare });
    const other = stateful('m');
    plainDir.register(other, 'alice');
    other.emit();
    const replay: string[] = [];
    plainDir.subscribeStates((id) => replay.push(id))();
    assert.deepEqual(replay, ['m']);
  });

  test('explicit hooks take precedence over the host; with a stateFeed the host hooks are unused', () => {
    const hostCalls: string[] = [];
    const host = createDefaultHost({
      ports: {
        onSessionStateChanged: (session) => { hostCalls.push(`persist ${session.id}`); },
        observability: { log: (_level, _scope, msg) => { hostCalls.push(`log ${msg}`); } },
      },
    });
    const persisted: string[] = [];
    const logs: string[] = [];
    const dir = directory({
      host,
      onSessionStateChanged: (session) => { persisted.push(session.id); throw new Error('disk full'); },
      log: (_level, _scope, msg) => { logs.push(msg); },
    });
    dir.register(stateful('n'), 'alice');
    assert.deepEqual(persisted, ['n']);
    assert.deepEqual(logs, ['could not persist session settings']);

    const onlyLog = directory({ host, log: (_level, _scope, msg) => { logs.push(`own ${msg}`); } });
    onlyLog.register(stateful('p'), 'alice');
    assert.deepEqual(hostCalls, ['persist p'], 'the host still persists when only log is explicit');

    const feed = createSessionStateFeed();
    const fed = directory({ host, stateFeed: feed });
    fed.register(stateful('q'), 'alice');
    assert.deepEqual(hostCalls, ['persist p']);
  });
});
