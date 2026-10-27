import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatPermissionMode } from 'michi-shared';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { resolveChatPolicy, codexChatTurnPolicy } from '../src/agents/permissionPolicy';
import { chatOwner } from './helpers/owners';

afterEach(__resetRuntimeDeps);
function configure(modes: Record<string, ChatPermissionMode>) {
  const grants = new Set<string>();
  configureRuntimeDeps({
    dataDir: '/tmp/michi-permission-runtime-tests',
    historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null,
      hasGrant: () => { throw new Error('Ordinary chats must not consult workspace grants'); }, grantPermission: () => { throw new Error('Workspace grants must not be written'); } },
    agentConfig: { getAgentConfig: () => ({ runtime: 'pi', provider: 'x', modelByRuntime: {}, reasoningByRuntime: {} }), resolveModel: () => '', resolveReasoning: () => undefined },
    chatPermissions: { getMode: (id) => modes[id] ?? 'ask', hasGrant: (id, tool) => grants.has(`${id}:${tool}`), grant: (id, tool) => { grants.add(`${id}:${tool}`); } },
  });
  return grants;
}

test('Ask gates writes, execution, unknown MCP and native requests; Trust and YOLO auto-approve on the backend', () => {
  const modes: Record<string, ChatPermissionMode> = { a: 'ask', b: 'trust', c: 'yolo' };
  configure(modes);
  for (const tool of ['bash', 'write', 'edit', 'Bash', 'Write', 'mcp__unknown__mutate']) {
    assert.equal(resolveChatPolicy(chatOwner('a'), null, tool), 'ask');
    for (const nodeId of ['b', 'c']) assert.equal(resolveChatPolicy(chatOwner(nodeId), null, tool, true), 'allow');
  }
  assert.equal(resolveChatPolicy(chatOwner('a'), null, 'read'), 'allow');
  assert.equal(resolveChatPolicy(chatOwner('a'), null, 'Read', true), 'ask');
  modes.b = 'ask';
  assert.equal(resolveChatPolicy(chatOwner('b'), null, 'write'), 'ask');
});

test('Codex maps all three modes to native turn approval and sandbox policies', () => {
  assert.deepEqual(codexChatTurnPolicy('ask', '/workspace'), { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly', networkAccess: false } });
  assert.equal(codexChatTurnPolicy('trust', '/workspace').approvalPolicy, 'never');
  assert.equal(codexChatTurnPolicy('trust', '/workspace').sandboxPolicy.type, 'workspaceWrite');
  assert.deepEqual(codexChatTurnPolicy('yolo', '/workspace'), { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
});

for (const mode of ['ask', 'trust', 'yolo'] as const) {
}
