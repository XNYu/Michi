// Michi's runtime manager built at server start over the runtime host
// (sessionRegistry.configureRuntimeManager): the registry and session
// accessors use it, ownership comes from host.principal, and session state
// keeps its runtime-deps persistence and `acp` log record.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSessionState } from 'michi-shared';
import type { RuntimeHost } from 'michi-runtime';
import { createSessionDirectory } from 'michi-runtime/internal/core/sessionDirectory';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { getRuntime, listRuntimes, registerRuntime } from '../src/agents/registry';
import {
  __resetRuntimeManager, configureRuntimeManager, getRuntimeManager, getSession, getSessionForOwner, getSessionForUser,
  registerSession,
} from '../src/agents/sessionRegistry';
import { createMichiRuntimeHost } from '../src/agents/michiRuntimeHost';
import { log } from '../src/services/logger';
import type { AgentRuntime, AgentSession } from '../src/agents/types';
import { chatOwner } from './helpers/owners';

function fake(id: string): AgentSession {
  return {
    id, runtimeId: 'kiro', getHistory: () => [], getPendingAssistant: () => undefined,
    async *send() {}, cancel: () => {},
    getSessionState: (): AgentSessionState => ({ runtimeId: 'kiro', modelId: id }),
    onSessionState: () => () => {},
  };
}

/** Michi's host with its principal's enforceUserOwnership replaced. */
function hostEnforcing(enforce: () => boolean): RuntimeHost {
  const host = createMichiRuntimeHost();
  return { ...host, principal: { ...host.principal, enforceUserOwnership: enforce } };
}

const originalCloud = process.env.MICHI_CLOUD;
afterEach(() => {
  __resetRuntimeManager();
  __resetRuntimeDeps();
  if (originalCloud === undefined) delete process.env.MICHI_CLOUD;
  else process.env.MICHI_CLOUD = originalCloud;
});

test('configureRuntimeManager builds the manager that the registry, the accessors and the host sessions port use', () => {
  const host = createMichiRuntimeHost();
  const manager = configureRuntimeManager(host);
  assert.equal(getRuntimeManager(), manager);

  const runtime = { id: 'w5c', label: 'w5c' } as AgentRuntime;
  registerRuntime(runtime);
  assert.equal(manager.get('w5c'), runtime);
  assert.equal(getRuntime('w5c'), runtime);
  assert.deepEqual(listRuntimes(), [runtime]);

  const viaAccessor = fake('via-accessor');
  registerSession(viaAccessor, 'bob');
  assert.equal(manager.sessions.get('via-accessor'), viaAccessor);
  // As the adapters register: through the host's sessions port.
  const viaHost = fake('via-host');
  host.sessions.registerSession(viaHost, 'bob');
  assert.equal(manager.sessions.get('via-host'), viaHost);
  assert.equal(getSession('via-host'), viaHost);
});

test('the configured manager reads ownership from host.principal on every lookup, not from MICHI_CLOUD', () => {
  let enforce = false;
  configureRuntimeManager(hostEnforcing(() => enforce));
  const session = fake('n');
  registerSession(session, 'bob');

  process.env.MICHI_CLOUD = '1';
  assert.equal(getSessionForUser('n', 'alice'), session);
  enforce = true;
  delete process.env.MICHI_CLOUD;
  assert.equal(getSessionForUser('n', 'alice'), null);
  assert.equal(getSessionForUser('n', 'bob'), session);
  assert.equal(getSessionForOwner('n', chatOwner('n'), 'alice'), null);
});

test("with Michi's host, ownership follows MICHI_CLOUD exactly as the import-time directory did", () => {
  configureRuntimeManager(createMichiRuntimeHost());
  // The rule before the switch: sessionRegistry's own directory read MICHI_CLOUD itself.
  const before = createSessionDirectory({ enforceUserOwnership: () => process.env.MICHI_CLOUD === '1' });
  const owners: Array<[string, string | null]> = [['owned', 'bob'], ['unowned', null]];
  for (const [id, ownerUserId] of owners) {
    const session = fake(id);
    registerSession(session, ownerUserId);
    before.register(session, ownerUserId);
  }
  for (const cloud of [undefined, '', '0', '1', 'true']) {
    if (cloud === undefined) delete process.env.MICHI_CLOUD;
    else process.env.MICHI_CLOUD = cloud;
    for (const [id] of owners) {
      for (const userId of ['bob', 'alice', null]) {
        const label = `MICHI_CLOUD=${cloud} ${id} as ${userId}`;
        assert.equal(getSessionForUser(id, userId), before.getForUser(id, userId), label);
        assert.equal(getSessionForOwner(id, chatOwner(id), userId), before.getForOwner(id, chatOwner(id), userId), label);
      }
    }
  }
});

test('after configureRuntimeManager, session state still persists through runtime deps and logs the WARN acp record', (t) => {
  const hostPersisted: string[] = [];
  const host: RuntimeHost = { ...createMichiRuntimeHost(), onSessionStateChanged: (session) => { hostPersisted.push(session.id); } };
  const persisted: Array<[string, string | null, AgentSessionState]> = [];
  let fail = false;
  configureRuntimeDeps({
    historyStore: {
      getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null,
    },
    agentConfig: {
      getAgentConfig: () => ({ runtime: 'kiro', provider: 'x', modelByRuntime: {}, reasoningByRuntime: {} }),
      resolveModel: () => '', resolveReasoning: () => undefined,
    },
    dataDir: '/tmp/agent-runtime-test',
    onSessionStateChanged: (session, ownerUserId, state) => {
      if (fail) throw new Error('disk full');
      persisted.push([session.id, ownerUserId, state]);
    },
  });
  configureRuntimeManager(host);
  const warnings: unknown[][] = [];
  t.mock.method(log, 'warn', (...args: unknown[]) => { warnings.push(args); });

  registerSession(fake('n'), 'alice');
  assert.deepEqual(persisted, [['n', 'alice', { runtimeId: 'kiro', modelId: 'n' }]]);
  fail = true;
  host.sessions.registerSession(fake('m'), 'alice');
  assert.deepEqual(hostPersisted, [], 'the host port is not the persistence path');
  assert.equal(warnings.length, 1);
  const [stage, msg, meta] = warnings[0] as [string, string, Record<string, unknown>];
  assert.equal(stage, 'acp');
  assert.equal(msg, 'could not persist session settings');
  assert.deepEqual(Object.entries(meta), [['nodeId', 'm'], ['error', 'Error: disk full']]);
});

test('configureRuntimeManager never replaces a manager already in use', () => {
  const inUse = getRuntimeManager();
  assert.throws(() => configureRuntimeManager(createMichiRuntimeHost()), /already in use\. Call it once, in server\.ts before anything reads agents\/registry/);
  assert.equal(getRuntimeManager(), inUse);

  __resetRuntimeManager();
  const configured = configureRuntimeManager(createMichiRuntimeHost());
  assert.throws(() => configureRuntimeManager(createMichiRuntimeHost()), /already in use/);
  assert.equal(getRuntimeManager(), configured);
});
