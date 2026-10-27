import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSessionState } from 'michi-shared';
import type { AgentRuntime, AgentSession } from '../src/contract/types';
import type { RuntimeHost, SessionRegistryPort } from '../src/contract/host';
import { createRuntimeManager, type RuntimeManager, type RuntimeManagerOptions } from '../src/core/runtimeManager';
import { createSessionDirectory, type SessionDirectory } from '../src/core/sessionDirectory';
import { createDefaultHost } from '../src/core/defaultHost';
import { UNKNOWN_RUNTIME_DESCRIPTOR } from '../src/core/descriptors';

function runtime(id: string, label = id): AgentRuntime {
  return {
    descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
    id,
    label,
    capabilities: {
      modes: false,
      permissions: false,
      models: false,
      providerModels: false,
      reasoning: false,
      supportedReasoningLevels: [],
      apiKeys: false,
      warmSessions: false,
      saveContext: false,
      spawnBranches: false,
      nativeResume: false,
    },
    warm: async () => {},
    newSession: async () => { throw new Error('unused'); },
    releaseSession: async () => {},
    shutdown: async () => {},
  };
}

function manager() {
  return createRuntimeManager({ sessions: createSessionDirectory({ enforceUserOwnership: () => false }) });
}

test('register, get and list in first-registration order', () => {
  const m = manager();
  const kiro = runtime('kiro');
  const codex = runtime('codex');
  m.register(kiro);
  m.register(codex);
  assert.equal(m.get('kiro'), kiro);
  assert.equal(m.get('codex'), codex);
  assert.equal(m.get('claude'), undefined);
  assert.deepEqual(m.list(), [kiro, codex]);
});

test('re-registering an id replaces the runtime and keeps its list position', () => {
  const m = manager();
  const first = runtime('kiro', 'first');
  const codex = runtime('codex');
  const second = runtime('kiro', 'second');
  m.register(first);
  m.register(codex);
  m.register(second);
  assert.equal(m.get('kiro'), second);
  assert.deepEqual(m.list(), [second, codex]);
});

test('list returns a copy', () => {
  const m = manager();
  m.register(runtime('kiro'));
  m.list().length = 0;
  assert.equal(m.list().length, 1);
});

test('two managers are isolated, including their session directories', () => {
  const left = manager();
  const right = manager();
  left.register(runtime('kiro'));
  assert.equal(right.get('kiro'), undefined);
  assert.deepEqual(right.list(), []);
  assert.notEqual(left.sessions, right.sessions);

  left.sessions.register({
    id: 'n', runtimeId: 'kiro', getHistory: () => [], getPendingAssistant: () => undefined,
    async *send() {}, cancel: () => {},
  }, 'alice');
  assert.ok(left.sessions.get('n'));
  assert.equal(right.sessions.get('n'), undefined);
});

test('the manager exposes the directory it was given', () => {
  const sessions = createSessionDirectory({ enforceUserOwnership: () => false });
  assert.equal(createRuntimeManager({ sessions }).sessions, sessions);
});

function stateful(id: string): AgentSession {
  return {
    id, runtimeId: 'kiro', getHistory: () => [], getPendingAssistant: () => undefined,
    async *send() {}, cancel: () => {},
    getSessionState: () => ({ runtimeId: 'kiro' }), onSessionState: () => () => {},
  };
}

/** A host's own sessions port over `directory()`, read when called, as an adapter calls it. */
function delegatingSessions(directory: () => SessionDirectory): SessionRegistryPort {
  return {
    ensureAncestorChainLoaded: () => {},
    getSession: (chatId) => directory().get(chatId),
    getAncestors: () => [],
    registerSession: (session, ownerUserId, owner) => directory().register(session, ownerUserId, owner),
    dropSession: (chatId) => directory().drop(chatId),
  };
}

test('createDefaultHost and createRuntimeManager({ host }) share one session directory', () => {
  const host = createDefaultHost();
  const m = createRuntimeManager({ host });
  const viaHost = stateful('via-host');
  // As an adapter registers: through the host's sessions port.
  host.sessions.registerSession(viaHost, 'alice');
  assert.equal(m.sessions.get('via-host'), viaHost);
  assert.equal(m.sessions.peek('via-host')?.ownerUserId, 'alice');

  const viaManager = stateful('via-manager');
  m.sessions.register(viaManager, 'bob');
  assert.equal(host.sessions.getSession('via-manager'), viaManager);
  host.sessions.dropSession('via-manager');
  assert.equal(m.sessions.get('via-manager'), undefined);

  // Every manager of the same host object reads the same directory; another host has its own.
  assert.equal(createRuntimeManager({ host }).sessions, m.sessions);
  assert.equal(createRuntimeManager({ host: createDefaultHost() }).sessions.get('via-host'), undefined);
});

test('a copy of a createDefaultHost host that replaces principal, onSessionStateChanged or observability is refused', () => {
  const base = createDefaultHost();
  base.sessions.registerSession(stateful('bobs'), 'bob');
  // The copy enforces ownership; the directory behind its sessions port reads base's principal, which does not.
  const enforcing: RuntimeHost = { ...base, principal: { ...base.principal, enforceUserOwnership: () => true } };
  assert.throws(() => createRuntimeManager({ host: enforcing }), /reads another host's principal \(a copy of that host.*createDefaultHost\(\{ ports \}\) that built the port/);
  assert.throws(() => createRuntimeManager({ host: { ...base, onSessionStateChanged: () => {} } }), /another host's onSessionStateChanged /);
  assert.throws(
    () => createRuntimeManager({ host: { ...base, observability: { ...base.observability, log: () => {} } } }),
    /another host's observability /,
  );
  const behind = createRuntimeManager({ host: base }).sessions;
  assert.throws(() => createRuntimeManager({ sessions: behind, host: enforcing }), /another host's principal /);
  // A copy that replaces only ports the directory does not read is the same host to it.
  assert.equal(createRuntimeManager({ host: { ...base, title: { ...base.title, enabled: () => true } } }).sessions, behind);

  // Through createDefaultHost's ports the replacement reaches the directory, so ownership holds.
  const host = createDefaultHost({ ports: { principal: { enforceUserOwnership: () => true } } });
  host.sessions.registerSession(stateful('bobs'), 'bob');
  const m = createRuntimeManager({ host });
  assert.equal(m.sessions.getForUser('bobs', 'alice'), null);
  assert.equal(m.sessions.getForUser('bobs', 'bob')?.id, 'bobs');
});

test('with createDefaultHost the shared directory reads ownership from the principal and reports state and logs to the host', () => {
  let enforce = false;
  let fail = false;
  const persisted: Array<[string, string | null]> = [];
  const logged: unknown[][] = [];
  const host = createDefaultHost({
    ports: {
      principal: { enforceUserOwnership: () => enforce },
      onSessionStateChanged: (session, ownerUserId) => {
        if (fail) throw new Error('disk full');
        persisted.push([session.id, ownerUserId]);
      },
      observability: { log: (...args) => { logged.push(args); } },
    },
  });
  const m = createRuntimeManager({ host });
  host.sessions.registerSession(stateful('n'), null);
  assert.deepEqual(persisted, [['n', null]]);
  assert.ok(m.sessions.getForUser('n', 'alice'));
  enforce = true;
  assert.equal(m.sessions.getForUser('n', 'alice'), null, 'read on every lookup');

  fail = true;
  host.sessions.registerSession(stateful('m'), 'alice');
  assert.deepEqual(logged, [['warn', 'session-state', 'could not persist session settings', { sessionId: 'm', error: 'Error: disk full' }]]);
});

test('with the host\'s own sessions port the manager builds its directory from the host, which the port must register into', () => {
  let enforce = false;
  const persisted: string[] = [];
  const logged: string[] = [];
  let m: RuntimeManager | undefined;
  const host = createDefaultHost({
    ports: {
      sessions: delegatingSessions(() => m!.sessions),
      principal: { enforceUserOwnership: () => enforce },
      onSessionStateChanged: (session) => {
        if (session.id === 'bad') throw new Error('disk full');
        persisted.push(session.id);
      },
      observability: { log: (_level, scope, msg) => { logged.push(`${scope}: ${msg}`); } },
    },
  });
  m = createRuntimeManager({ host });
  const session = stateful('n');
  host.sessions.registerSession(session, null);
  assert.equal(m.sessions.get('n'), session);
  assert.deepEqual(persisted, ['n']);
  enforce = true;
  assert.equal(m.sessions.getForUser('n', 'alice'), null, 'ownership read from the principal on every lookup');
  host.sessions.registerSession(stateful('bad'), null);
  assert.deepEqual(logged, ['session-state: could not persist session settings']);

  // A port that keeps sessions elsewhere is never read: the manager's directory stays empty.
  const own = createSessionDirectory({ enforceUserOwnership: () => false });
  const elsewhere = createDefaultHost({ ports: { sessions: delegatingSessions(() => own) } });
  const isolated = createRuntimeManager({ host: elsewhere });
  elsewhere.sessions.registerSession(stateful('x'), null);
  assert.equal(own.get('x')?.id, 'x');
  assert.equal(isolated.sessions.get('x'), undefined);
  assert.notEqual(isolated.sessions, own);
});

test("a sessions port that mixes createDefaultHost's methods with replaced ones is refused", () => {
  // The kept defaults still write and read the default directory, so a manager could see neither half.
  const partial = createDefaultHost({ ports: { sessions: { ensureAncestorChainLoaded: () => {} } } });
  assert.throws(
    () => createRuntimeManager({ host: partial }),
    /keeps getSession, getAncestors, registerSession, dropSession.*Replace all five/,
  );
  const base = createDefaultHost();
  const mixed: RuntimeHost = { ...base, sessions: { ...base.sessions, registerSession: () => {} } };
  assert.throws(() => createRuntimeManager({ host: mixed }), /keeps ensureAncestorChainLoaded, getSession, getAncestors, dropSession/);
  const sessions = createSessionDirectory({ enforceUserOwnership: () => false });
  assert.throws(() => createRuntimeManager({ sessions, host: mixed }), /keeps ensureAncestorChainLoaded/);
  // Methods from two createDefaultHost ports mix two directories.
  const other = createDefaultHost();
  assert.throws(
    () => createRuntimeManager({ host: { ...base, sessions: { ...base.sessions, registerSession: other.sessions.registerSession } } }),
    /keeps ensureAncestorChainLoaded, getSession, getAncestors, registerSession, dropSession from createDefaultHost's sessions ports, but not all five methods of one port/,
  );
  // Replacing all five makes the port the host's own: see "with the host's own sessions port ..." above.
});

test('methods are recognized by identity, so a wrapped default method counts as the host\'s own', () => {
  const base = createDefaultHost();
  const s = base.sessions;
  // Wrapping some: the rest are kept defaults, so the port is refused.
  const forwarding: RuntimeHost = { ...base, sessions: { ...s, registerSession: (...args) => s.registerSession(...args) } };
  assert.throws(
    () => createRuntimeManager({ host: forwarding }),
    /keeps ensureAncestorChainLoaded, getSession, getAncestors, dropSession .*may split \(the package cannot see through a method that was replaced or wrapped\)/,
  );
  // Wrapping all five: the host's own port, which registers into the default directory, not the manager's (fail-closed).
  const bound: SessionRegistryPort = {
    ensureAncestorChainLoaded: s.ensureAncestorChainLoaded.bind(s),
    getSession: s.getSession.bind(s),
    getAncestors: s.getAncestors.bind(s),
    registerSession: s.registerSession.bind(s),
    dropSession: s.dropSession.bind(s),
  };
  const m = createRuntimeManager({ host: { ...base, sessions: bound } });
  bound.registerSession(stateful('w'), 'bob');
  assert.equal(s.getSession('w')?.id, 'w');
  assert.equal(m.sessions.get('w'), undefined);
  assert.equal(m.sessions.getForUser('w', 'alice'), null);
});

test('a copy of all five methods of a createDefaultHost sessions port is that port', () => {
  const b = createDefaultHost();
  const behind = createRuntimeManager({ host: b }).sessions;
  const clone: RuntimeHost = { ...b, sessions: { ...b.sessions } };
  const m = createRuntimeManager({ host: clone });
  assert.equal(m.sessions, behind);
  const session = stateful('n');
  clone.sessions.registerSession(session, null);
  assert.equal(m.sessions.get('n'), session);

  // Another host given that port: the directory still reads the first host's ports, which the I-1 check catches.
  const a = createDefaultHost();
  const q = createDefaultHost({ ports: { sessions: a.sessions } });
  assert.throws(() => createRuntimeManager({ host: q }), /another host's principal, observability \(.*or another host given its port.*or do not share the port\.$/);
});

test('a given directory is used as is; with createDefaultHost it must be the one behind host.sessions', () => {
  const sessions = createSessionDirectory({ enforceUserOwnership: () => false });
  assert.equal(createRuntimeManager({ sessions }).sessions, sessions);
  // A host's own sessions port cannot be checked: the host vouches for it.
  const own = createDefaultHost({ ports: { sessions: delegatingSessions(() => sessions) } });
  assert.equal(createRuntimeManager({ sessions, host: own }).sessions, sessions);

  const host = createDefaultHost();
  assert.throws(() => createRuntimeManager({ sessions, host }), /not the directory that host\.sessions registers into.*Pass only \{ host \}/);
  const behind = createRuntimeManager({ host }).sessions;
  assert.equal(createRuntimeManager({ sessions: behind, host }).sessions, behind);
  assert.throws(() => createRuntimeManager({} as RuntimeManagerOptions), /pass sessions or host/);
});

/** A runtime that keeps its sessions in host.sessions, as the adapters do; emit() changes a session's state. */
function hostBackedRuntime(host: RuntimeHost) {
  const live = new Map<string, { modelId: string; notify?: () => void; detached: number }>();
  const adapter: AgentRuntime & { emit(id: string, modelId: string): void; detached(id: string): number } = {
    ...runtime('host-backed'),
    async newSession(opts) {
      const id = opts.sessionId!;
      const entry: { modelId: string; notify?: () => void; detached: number } = { modelId: 'm0', detached: 0 };
      live.set(id, entry);
      const session: AgentSession = {
        id, runtimeId: 'host-backed', getHistory: () => [], getPendingAssistant: () => undefined,
        async *send() {}, cancel: () => {},
        getSessionState: (): AgentSessionState => ({ runtimeId: 'host-backed', modelId: entry.modelId }),
        // The notifier is kept after detach, so only the directory's own untracking can silence it.
        onSessionState: (notify) => { entry.notify = notify; return () => { entry.detached += 1; }; },
      };
      host.sessions.registerSession(session, opts.ownerUserId ?? null);
      return session;
    },
    releaseSession(sessionId) {
      host.sessions.dropSession(sessionId);
    },
    emit(id, modelId) {
      const entry = live.get(id)!;
      entry.modelId = modelId;
      entry.notify?.();
    },
    detached: (id) => live.get(id)!.detached,
  };
  return adapter;
}

test("an adapter's session reports state to the default host's onSessionStateChanged and log until the adapter drops it", async () => {
  const changes: Array<[string, string | null, string | null | undefined]> = [];
  const warnings: unknown[][] = [];
  let failNext = false;
  const host = createDefaultHost({
    // The default observability port, writing to this sink.
    logSink: { debug: () => {}, info: () => {}, warn: (...line: unknown[]) => { warnings.push(line); }, error: () => {} },
    ports: {
      onSessionStateChanged: (session, ownerUserId, state) => {
        if (failNext) {
          failNext = false;
          throw new Error('disk full');
        }
        changes.push([session.id, ownerUserId, state.modelId]);
      },
    },
  });
  const m = createRuntimeManager({ host });
  const adapter = hostBackedRuntime(host);
  m.register(adapter);

  const session = await adapter.newSession({ cwd: '/tmp', sessionId: 'n', ownerUserId: 'alice' });
  assert.equal(m.sessions.get('n'), session);
  assert.deepEqual(changes, [['n', 'alice', 'm0']], 'registering reports the current state');

  adapter.emit('n', 'm1');
  assert.deepEqual(changes, [['n', 'alice', 'm0'], ['n', 'alice', 'm1']]);

  failNext = true;
  adapter.emit('n', 'm2');
  assert.deepEqual(warnings, [['[session-state] could not persist session settings', { sessionId: 'n', error: 'Error: disk full' }]]);
  assert.equal(changes.length, 2);

  await adapter.releaseSession('n');
  assert.equal(m.sessions.get('n'), undefined);
  assert.equal(adapter.detached('n'), 1);
  adapter.emit('n', 'm3');
  assert.equal(changes.length, 2, 'a dropped session reports nothing more');
  assert.equal(warnings.length, 1);
});
