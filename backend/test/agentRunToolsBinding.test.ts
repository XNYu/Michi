import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentRunToolsBindingFor } from '../src/agents/agentRunInvocation';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { chatOwner, runOwner } from './helpers/owners';

const base = { runtimeId: 'claude', sessionId: 'session-1', ownerUserId: 'user-1', workspaceId: 'ws-1', nodeId: 'node-1' };

test('a chat session acts for its conversation: the bound node, else the owner\'s', () => {
  assert.deepEqual(agentRunToolsBindingFor({ ...base, owner: chatOwner('node-1') }), {
    kind: 'conversation', ownerUserId: 'user-1', workspaceId: 'ws-1', parentNodeId: 'node-1', runtimeSessionId: 'session-1',
  });
  assert.deepEqual(agentRunToolsBindingFor({ ...base, nodeId: null, ownerUserId: null, owner: chatOwner('node-owner') }), {
    kind: 'conversation', ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: 'ws-1', parentNodeId: 'node-owner', runtimeSessionId: 'session-1',
  });
  assert.equal(agentRunToolsBindingFor({ ...base, workspaceId: null, owner: chatOwner('node-1') }), null, 'no Workspace, no Agent tools');
});

test('a Run session acts for its Run Attempt, whatever node the binding names', () => {
  const caller = agentRunToolsBindingFor({ ...base, sessionId: 'attempt-1', nodeId: 'node-1', owner: runOwner('run-1', 'attempt-1') });
  assert.deepEqual(caller, {
    kind: 'agent_run', ownerUserId: 'user-1', workspaceId: 'ws-1', parentRunId: 'run-1', parentAttemptId: 'attempt-1',
  });
  assert.equal('parentNodeId' in caller!, false, 'the binding\'s node id does not reach a Run caller');
});

test('a headless owner without a Run id fails closed instead of acting for a conversation', () => {
  assert.throws(() => agentRunToolsBindingFor({ ...base, owner: { mode: 'headless', key: 'attempt-1' } }), /carries no Run id/);
});
