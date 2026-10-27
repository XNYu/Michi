/**
 * The shared runtime test helpers: michiTestHost() is Michi's host, and
 * fakeMcpRegistry() behaves as McpSlotRegistry does for everything an adapter
 * reads (URLs, live bindings, rebind, session group bindings).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertHostPorts, type McpSlotProvider, type McpSlotRebindPatch } from 'michi-runtime';
import { McpSlotRegistry, type McpSlotCallbacks } from '../src/services/mcpServer';
import { createMichiRuntimeHost } from '../src/agents/michiRuntimeHost';
import { michiTestHost } from './helpers/michiTestHost';
import { fakeMcpRegistry } from './helpers/fakeMcpRegistry';
import { chatOwner, runOwner } from './helpers/owners';

const callbacks = (over: Partial<McpSlotCallbacks> = {}): McpSlotCallbacks => ({
  onSpawnBranches: async () => [],
  onSaveArtifact: () => null,
  onUpdateArtifact: () => null,
  ...over,
});

test('michiTestHost is a fresh Michi host with every port', () => {
  const host = michiTestHost();
  assertHostPorts(host, [
    'config', 'prompt', 'profile', 'bindings', 'sessions', 'permissions', 'principal', 'observability', 'title',
    'backgroundTurns', 'workflows', 'backgroundSubagents', 'onSessionStateChanged', 'bindings.crewMemory',
  ], 'test');
  assert.deepEqual(Object.keys(host).sort(), Object.keys(createMichiRuntimeHost()).sort());
  assert.notEqual(michiTestHost(), host);
});

for (const port of [undefined, 43117]) {
  test(`fakeMcpRegistry URLs equal McpSlotRegistry's (port ${port ?? 'default'})`, async () => {
    const fake: McpSlotProvider = fakeMcpRegistry({}, { mcpPort: port });
    const real: McpSlotProvider = new McpSlotRegistry(port === undefined ? {} : { mcpPort: port });
    const slot = real.create('chat-a', '/tmp', null, callbacks(), { nodeId: 'node-a' });
    const groupId = real.createSessionGroup(slot);
    try {
      for (const id of [slot.slotId, 'abc']) {
        assert.deepEqual(fake.endpoint(id), real.endpoint(id));
        assert.equal(fake.hookEndpoint(id, 'stop'), real.hookEndpoint(id, 'stop'));
      }
      assert.deepEqual(fake.sessionEndpoint(groupId), real.sessionEndpoint(groupId));
      assert.throws(() => fake.hookEndpoint('abc', 'start' as 'stop'), /Unknown MCP slot hook: start/);
    } finally {
      real.disposeSessionGroup(groupId);
      await real.dispose(slot.slotId);
    }
  });
}

test('fakeMcpRegistry reads a port function each time, as McpSlotRegistry does', () => {
  let port = 0;
  const fake = fakeMcpRegistry({}, { mcpPort: () => port });
  const real = new McpSlotRegistry({ mcpPort: () => port });
  for (const bound of [43118, 43119]) {
    port = bound;
    assert.deepEqual(fake.endpoint('abc'), real.endpoint('abc'));
    assert.equal(fake.endpoint('abc').url, `http://127.0.0.1:${bound}/api/mcp/abc`);
    assert.deepEqual(fake.sessionEndpoint('g'), real.sessionEndpoint('g'));
    assert.equal(fake.hookEndpoint('abc', 'stop'), real.hookEndpoint('abc', 'stop'));
  }
});

test('fakeMcpRegistry create and get hand out the live slot, kept in slots', async () => {
  const fake = fakeMcpRegistry();
  const owner = chatOwner('node-a');
  const slot = fake.create('chat-a', '/tmp', 'user-1', callbacks({ owner, restricted: true }), { workspaceId: 'ws-1' });
  assert.equal(fake.get(slot.slotId), slot);
  assert.equal(fake.slots.get(slot.slotId), slot);
  assert.deepEqual(
    { owner: slot.owner, nodeId: slot.nodeId, parentChatId: slot.parentChatId, cwd: slot.cwd,
      workspaceId: slot.workspaceId, ownerUserId: slot.ownerUserId, restricted: slot.restricted },
    { owner, nodeId: null, parentChatId: 'chat-a', cwd: '/tmp', workspaceId: 'ws-1', ownerUserId: 'user-1', restricted: true },
  );
  assert.notEqual(fake.create('chat-a', '/tmp', null, callbacks()).slotId, slot.slotId);
  await fake.dispose(slot.slotId);
  assert.equal(fake.get(slot.slotId), undefined);
  await fake.dispose(slot.slotId);
});

test('fakeMcpRegistry rebind assigns in place exactly as McpSlotRegistry does', async () => {
  const real = new McpSlotRegistry();
  const fake = fakeMcpRegistry();
  const invoker = { invoke: async () => ({}) };
  const submit = () => { throw new Error('not called'); };
  const patches: McpSlotRebindPatch[] = [
    {
      owner: runOwner('run-1', 'attempt-1'),
      exposedToolNames: undefined,
      parentChatId: 'native-1',
      nodeId: 'node-1',
      workspaceId: 'ws-1',
      ownerUserId: 'user-1',
      agentRuns: invoker,
      agentRunToolNames: ['list_agents'],
      onSubmitAgentResult: submit,
    },
    {},
    { parentChatId: undefined, nodeId: undefined, workspaceId: undefined, ownerUserId: undefined },
    { nodeId: null, workspaceId: null, ownerUserId: null, agentRuns: undefined },
  ];
  const start = callbacks({ owner: chatOwner('warm'), exposedToolNames: new Set(['save_artifact']) });
  const realSlot = real.create('__pending__', '/tmp', null, start);
  const fakeSlot = fake.create('__pending__', '/tmp', null, start);
  const fields = (slot: object) => {
    const { slotId: _slotId, ...rest } = slot as Record<string, unknown>;
    return rest;
  };
  try {
    for (const patch of patches) {
      real.rebind(realSlot.slotId, patch);
      fake.rebind(fakeSlot.slotId, patch);
      assert.equal(fake.get(fakeSlot.slotId), fakeSlot, 'the same object, not a replacement');
      assert.deepEqual(fields(fakeSlot), fields(realSlot));
    }
    assert.equal(fakeSlot.parentChatId, 'native-1');
    assert.equal(fakeSlot.nodeId, null);
    assert.ok('exposedToolNames' in fakeSlot);
    assert.doesNotThrow(() => fake.rebind('unknown', { parentChatId: 'other' }));
  } finally {
    await real.dispose(realSlot.slotId);
  }
});

test('fakeMcpRegistry session groups bind, open turns and unbind as McpSlotRegistry does', async () => {
  const fake = fakeMcpRegistry();
  const chat = fake.create('native-1', '/tmp', null, callbacks({ owner: chatOwner('node-1') }), { nodeId: 'node-1' });
  const groupId = fake.createSessionGroup(chat);
  const group = fake.sessionGroups.get(groupId)!;
  assert.notEqual(group.catalog, chat, 'the group serves a copy of the catalog');

  const run = fake.create('native-2', '/tmp', null, callbacks({ owner: runOwner('r', 'a') }), { nodeId: 'node-2' });
  const nodeless = fake.create('native-3', '/tmp', null, callbacks());
  for (const [sessionId, slotId] of [['native-2', run.slotId], ['native-3', nodeless.slotId], ['other', chat.slotId], ['native-1', 'missing']]) {
    assert.throws(() => fake.bindSession(groupId, sessionId, slotId), /Invalid MCP chat session binding/);
  }
  assert.throws(() => fake.bindSession('missing', 'native-1', chat.slotId), /Invalid MCP chat session binding/);
  assert.throws(() => fake.beginSessionTurn(groupId, 'native-1'), /MCP session is not bound/);

  fake.bindSession(groupId, 'native-1', chat.slotId);
  const end = fake.beginSessionTurn(groupId, 'native-1');
  assert.ok(group.openTurns.has('native-1'));
  end();
  assert.ok(!group.openTurns.has('native-1'));
  fake.beginSessionTurn(groupId, 'native-1');
  fake.bindSession(groupId, 'native-1', chat.slotId);
  assert.ok(!group.openTurns.has('native-1'), 'rebinding closes the turn window');
  fake.beginSessionTurn(groupId, 'native-1');
  fake.endSessionTurn(groupId, 'native-1');
  assert.ok(!group.openTurns.has('native-1'));

  await fake.dispose(chat.slotId);
  assert.equal(group.sessions.has('native-1'), false, 'a disposed slot is unbound from its groups');
  fake.disposeSessionGroup(groupId);
  assert.equal(fake.sessionGroups.has(groupId), false);
  assert.doesNotThrow(() => fake.endSessionTurn(groupId, 'native-1'));
});

test('a late turn closer leaves a newer turn open, in the fake as in McpSlotRegistry', async (t) => {
  const real = new McpSlotRegistry();
  const fake = fakeMcpRegistry();
  const providers: Array<[string, McpSlotProvider, (groupId: string, sessionId: string) => boolean]> = [
    ['real', real, (groupId, sessionId) => real.resolveSessionSlot(groupId, sessionId) !== undefined],
    ['fake', fake, (groupId, sessionId) => fake.sessionGroups.get(groupId)!.openTurns.has(sessionId)],
  ];
  for (const [label, provider, isOpen] of providers) {
    const slot = provider.create('native-1', '/tmp', null, callbacks({ owner: chatOwner('node-1') }), { nodeId: 'node-1' });
    const groupId = provider.createSessionGroup(slot);
    t.after(async () => { provider.disposeSessionGroup(groupId); await provider.dispose(slot.slotId); });
    provider.bindSession(groupId, 'native-1', slot.slotId);
    const open = () => isOpen(groupId, 'native-1');

    const closeFirst = provider.beginSessionTurn(groupId, 'native-1');
    const closeSecond = provider.beginSessionTurn(groupId, 'native-1');
    closeFirst();
    assert.equal(open(), true, `${label}: a late closer leaves the newer turn open`);
    closeSecond();
    assert.equal(open(), false, `${label}: the current turn's closer closes it`);

    // endSessionTurn and a rebind close whatever turn is open; closers from before stay inert.
    const closeThird = provider.beginSessionTurn(groupId, 'native-1');
    provider.endSessionTurn(groupId, 'native-1');
    assert.equal(open(), false, `${label}: endSessionTurn closes the window`);
    const closeFourth = provider.beginSessionTurn(groupId, 'native-1');
    closeThird();
    assert.equal(open(), true, `${label}: a closer from before endSessionTurn`);
    provider.bindSession(groupId, 'native-1', slot.slotId);
    assert.equal(open(), false, `${label}: rebinding closes the window`);
    const closeFifth = provider.beginSessionTurn(groupId, 'native-1');
    closeFourth();
    assert.equal(open(), true, `${label}: a closer from before the rebind`);
    closeFifth();
    assert.equal(open(), false, label);
  }
});

test('fakeMcpRegistry overrides replace single methods', () => {
  const seen: string[] = [];
  const fake = fakeMcpRegistry({ endpoint: (slotId) => { seen.push(slotId); return { type: 'http', url: 'http://x', headers: [] }; } });
  const slot = fake.create('chat-a', '/tmp', null, callbacks());
  assert.equal(fake.endpoint(slot.slotId).url, 'http://x');
  assert.deepEqual(seen, [slot.slotId]);
  assert.equal(fake.get(slot.slotId), slot);
});
