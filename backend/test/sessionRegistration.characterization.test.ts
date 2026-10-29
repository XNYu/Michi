// Characterizes registration through the app accessors (agents/registry,
// agents/sessionRegistry, agents/sessionStateFeed) after they moved onto the
// package's RuntimeManager/SessionDirectory: each lifecycle step re-registers
// ids the way the runtimes and routes do, and the directory must end up with
// exactly one live entry per id, holding the last registration.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSessionState } from 'michi-shared';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { getRuntime, listRuntimes, registerRuntime } from '../src/agents/registry';
import {
  clearAllSessions, dropSession, ensureAncestorChainLoaded, evictHistoryStubs, getAncestors, getSession,
  getRuntimeManager, getSessionForOwner, getSessionForUser, registerSession, sessionMatchesOwner,
  HISTORY_STUB_MAX_ENTRIES, HISTORY_STUB_TTL_MS,
} from '../src/agents/sessionRegistry';
import { subscribeSessionStates } from '../src/agents/sessionStateFeed';
import { log } from '../src/services/logger';
import type { AgentRuntime, AgentSession, RuntimeSessionOwner } from '../src/agents/types';
import type { HistoryStore } from '../src/agents/ports';
import { chatOwner, hostOwner, runOwner } from './helpers/owners';

type Fake = AgentSession & { label: string; detached: number };

function fake(id: string, label: string, extra: Partial<AgentSession> = {}): Fake {
  const session = {
    id, runtimeId: 'kiro', getHistory: () => [], getPendingAssistant: () => undefined,
    async *send() {}, cancel: () => {},
    getSessionState: (): AgentSessionState => ({ runtimeId: 'kiro', modelId: label }),
    onSessionState: () => () => { session.detached += 1; },
    ...extra,
    label, detached: 0,
  } as Fake;
  return session;
}

function store(nodes: Record<string, { parent: string | null }>): HistoryStore {
  return {
    getNode: (id) => (nodes[id] ? { parent_node_id: nodes[id].parent, workspace_id: null } : null),
    listMessages: (id) => (nodes[id] ? [{ role: 'user', content: `history of ${id}`, created_at: 0 }] : []),
    getWorkspace: () => null, getWorkspaceInstructions: () => null,
  };
}

function configure(nodes: Record<string, { parent: string | null }>, extra: { onSessionStateChanged?: () => void } = {}): void {
  configureRuntimeDeps({
    historyStore: store(nodes),
    agentConfig: {
      getAgentConfig: () => ({ runtime: 'kiro', provider: 'x', modelByRuntime: {}, reasoningByRuntime: {} }),
      resolveModel: () => '', resolveReasoning: () => undefined,
    },
    dataDir: '/tmp/agent-runtime-test',
    ...extra,
  });
}

const stubIds = () => getRuntimeManager().sessions.entries().filter((entry) => entry.kind === 'stub').map((entry) => entry.session.id);

const originalCloud = process.env.MICHI_CLOUD;
afterEach(() => {
  clearAllSessions();
  __resetRuntimeDeps();
  if (originalCloud === undefined) delete process.env.MICHI_CLOUD;
  else process.env.MICHI_CLOUD = originalCloud;
});

test('new, load, fork, /clear, spawn and stub-to-live leave one live entry per id holding the last registration', () => {
  configure({ restored: { parent: 'root' }, root: { parent: null } });
  const chat = chatOwner;
  const attemptId = 'attempt-1';
  const run = runOwner('run-1', attemptId);
  const created: Fake[] = [];
  const expected = new Map<string, { session: Fake; ownerUserId: string | null; owner: RuntimeSessionOwner }>();
  const register = (session: Fake, ownerUserId: string | null | undefined, owner?: RuntimeSessionOwner) => {
    created.push(session);
    if (owner) registerSession(session, ownerUserId, owner);
    else registerSession(session, ownerUserId);
    expected.set(session.id, {
      session, ownerUserId: ownerUserId ?? null, owner: owner ?? session.owner ?? chat(session.id),
    });
  };

  // new: the first send creates the chat session.
  register(fake('root', 'root-new'), 'alice');
  // load: native resume re-registers the same id with a new object.
  register(fake('root', 'root-loaded'), 'alice', chat('root'));
  // fork: a child chat with its own id.
  register(fake('fork', 'fork', { parentChatId: 'root' }), 'alice');
  // /clear: the context reset swaps in a replacement under the same id.
  register(fake('root', 'root-cleared'), 'alice');
  // spawn: a child branch registered for the workspace owner.
  register(fake('branch', 'branch', { parentChatId: 'fork' }), 'alice');
  // An Agent Run attempt, registered under its explicit owner.
  register(fake(attemptId, 'attempt', { owner: run }), 'alice', run);

  // ensureAncestorChainLoaded fills the missing parent chain with history stubs...
  ensureAncestorChainLoaded('restored');
  assert.equal(getRuntimeManager().sessions.peek('restored')?.kind, 'stub');
  assert.equal(getSession('root')?.getHistory().length, 0, 'a live session is never replaced by a stub');
  assert.deepEqual(getAncestors('restored').map((session) => session.id), ['root']);
  // ...and a later live registration replaces the stub.
  register(fake('restored', 'restored-live', { parentChatId: 'root' }), 'bob');

  const entries = getRuntimeManager().sessions.entries();
  assert.deepEqual(entries.map((entry) => entry.session.id), ['root', 'fork', 'branch', attemptId, 'restored']);
  for (const entry of entries) {
    const want = expected.get(entry.session.id)!;
    assert.equal(entry.kind, 'live', entry.session.id);
    assert.equal(entry.session, want.session, entry.session.id);
    assert.equal(entry.ownerUserId, want.ownerUserId, entry.session.id);
    assert.deepEqual(entry.owner, want.owner, entry.session.id);
  }

  // The public accessors agree with the directory.
  process.env.MICHI_CLOUD = '1';
  for (const [id, want] of expected) {
    assert.equal(getSession(id), want.session, id);
    assert.equal(sessionMatchesOwner(id, want.owner), true, id);
    assert.equal(getSessionForOwner(id, want.owner, want.ownerUserId), want.session, id);
    assert.equal(getSessionForUser(id, want.ownerUserId), want.session, id);
    assert.equal(getSessionForUser(id, 'mallory'), null, id);
  }
  assert.equal(evictHistoryStubs({ now: Date.now() + HISTORY_STUB_TTL_MS + 1, maxEntries: 0 }), 0);

  // Only the last chat-node registration per id publishes state; replaced objects are detached.
  const states = new Map<string, string | null | undefined>();
  subscribeSessionStates((id, state) => states.set(id, state.modelId))();
  assert.deepEqual(Object.fromEntries(states), {
    root: 'root-cleared', fork: 'fork', branch: 'branch', restored: 'restored-live',
  });
  for (const session of created) {
    const replaced = expected.get(session.id)?.session !== session;
    assert.equal(session.detached, replaced ? 1 : 0, session.label);
  }
});

test('getAncestors refreshes the stubs on the chain, so they outlive their original TTL', () => {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    configure({ mid: { parent: 'root' }, root: { parent: null }, other: { parent: null } });
    registerSession(fake('leaf', 'leaf', { parentChatId: 'mid' }), 'alice');
    ensureAncestorChainLoaded('leaf');
    ensureAncestorChainLoaded('other');
    assert.deepEqual(stubIds(), ['mid', 'root', 'other']);

    now += HISTORY_STUB_TTL_MS - 1;
    assert.deepEqual(getAncestors('leaf').map((session) => session.id), ['root', 'mid']);
    assert.deepEqual(stubIds(), ['mid', 'root', 'other'], 'nothing has expired yet');

    // Past the TTL of the original load: only the stub that getAncestors did not touch expires.
    now += 2;
    assert.equal(evictHistoryStubs(), 1);
    assert.deepEqual(stubIds(), ['mid', 'root']);
    assert.equal(getRuntimeManager().sessions.peek('mid')?.lastAccessedAt, 1_000_000 + HISTORY_STUB_TTL_MS - 1);
  } finally {
    Date.now = realNow;
  }
});

test('a chain longer than the stub cap comes back whole from getAncestors right after ensureAncestorChainLoaded', () => {
  const depth = HISTORY_STUB_MAX_ENTRIES + 20;
  const nodes: Record<string, { parent: string | null }> = {};
  for (let index = 0; index < depth; index += 1) nodes[`n${index}`] = { parent: index === 0 ? null : `n${index - 1}` };
  configure(nodes);
  registerSession(fake('leaf', 'leaf', { parentChatId: `n${depth - 1}` }), 'alice');

  ensureAncestorChainLoaded('leaf');
  assert.equal(stubIds().length, depth, 'the chain just loaded is protected beyond the cap');

  const chain = getAncestors('leaf');
  assert.equal(chain.length, depth);
  assert.deepEqual(chain.map((session) => session.id), Array.from({ length: depth }, (_, index) => `n${index}`));
  assert.equal(chain[0].getHistory()[0]?.content, 'history of n0');
  // getAncestors trims the resident stubs back to the cap only after copying the chain.
  assert.equal(stubIds().length, HISTORY_STUB_MAX_ENTRIES);
});

test('re-registering a chat id under an Agent Run owner stops its state tracking', () => {
  const session = fake('n', 'n');
  registerSession(session, 'alice');
  registerSession(session, 'alice', runOwner('run', 'n'));
  assert.equal(session.detached, 1);
  const seen: string[] = [];
  subscribeSessionStates((id) => seen.push(id))();
  assert.deepEqual(seen, []);
  assert.equal(hostOwner(getRuntimeManager().sessions.peek('n')!.owner!).kind, 'agent_run');
});

test('getRuntimeManager().sessions is the directory behind the old accessors', () => {
  const owner: RuntimeSessionOwner = chatOwner('via-accessor');
  const viaAccessor = fake('via-accessor', 'accessor');
  registerSession(viaAccessor, 'alice');
  assert.equal(getRuntimeManager().sessions.get('via-accessor'), viaAccessor);
  assert.equal(getRuntimeManager().sessions.matchesOwner('via-accessor', owner), true);

  const viaManager = fake('via-manager', 'manager');
  getRuntimeManager().sessions.register(viaManager, 'bob');
  assert.equal(getSession('via-manager'), viaManager);
  process.env.MICHI_CLOUD = '1';
  assert.equal(getSessionForUser('via-manager', 'bob'), viaManager);
  assert.equal(getSessionForUser('via-manager', 'alice'), null);
  delete process.env.MICHI_CLOUD;

  // The state feed in agents/sessionStateFeed is the one the directory drives.
  const states: Array<[string, string | null | undefined]> = [];
  subscribeSessionStates((id, state) => states.push([id, state.modelId]))();
  assert.deepEqual(states, [['via-accessor', 'accessor'], ['via-manager', 'manager']]);
  const bobOnly: string[] = [];
  subscribeSessionStates((id) => bobOnly.push(id), 'bob')();
  assert.deepEqual(bobOnly, ['via-manager']);

  dropSession('via-manager');
  assert.equal(getRuntimeManager().sessions.peek('via-manager'), undefined);
  assert.equal(viaManager.detached, 1);
  getRuntimeManager().sessions.drop('via-accessor');
  assert.equal(getSession('via-accessor'), undefined);
  assert.equal(viaAccessor.detached, 1);

  registerSession(fake('cleared', 'cleared'), 'alice');
  getRuntimeManager().sessions.clear();
  assert.equal(getSession('cleared'), undefined);
  registerSession(fake('again', 'again'), 'alice');
  clearAllSessions();
  assert.deepEqual(getRuntimeManager().sessions.entries(), []);
  const after: string[] = [];
  subscribeSessionStates((id) => after.push(id))();
  assert.deepEqual(after, []);
});

test('a failed persist logs the original WARN acp record and listeners still receive the state', (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(log, 'warn', (...args: unknown[]) => { warnings.push(args); });
  configure({}, { onSessionStateChanged: () => { throw new Error('disk full'); } });
  const received: string[] = [];
  const stop = subscribeSessionStates((id) => received.push(id), 'alice');
  try {
    registerSession(fake('n', 'n'), 'alice');
  } finally {
    stop();
  }

  assert.deepEqual(received, ['n']);
  assert.equal(warnings.length, 1);
  const [stage, msg, meta] = warnings[0] as [string, string, Record<string, unknown>];
  assert.equal(stage, 'acp');
  assert.equal(msg, 'could not persist session settings');
  assert.deepEqual(Object.entries(meta), [['nodeId', 'n'], ['error', 'Error: disk full']]);
});

test('registerRuntime keeps the last runtime per id in first-registration order', () => {
  const make = (id: string, label: string) => ({ id, label } as AgentRuntime);
  const before = listRuntimes().length;
  const first = make('w3c-a', 'first');
  const other = make('w3c-b', 'other');
  const second = make('w3c-a', 'second');
  registerRuntime(first);
  registerRuntime(other);
  registerRuntime(second);
  assert.equal(getRuntime('w3c-a'), second);
  assert.equal(getRuntimeManager().get('w3c-a'), second);
  assert.deepEqual(listRuntimes().slice(before), [second, other]);
});
