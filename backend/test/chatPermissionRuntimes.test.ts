import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatPermissionMode } from 'michi-shared';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { chatPermissionMode, resolveChatPolicy, grantChatPermission, codexChatTurnPolicy } from '../src/agents/permissionPolicy';
import { KiroSession } from '../src/agents/kiro/KiroSession';
import { kiroArgs } from '../src/agents/kiro/kiroProtocol';
import type { KiroRuntime } from '../src/agents/kiro/KiroRuntime';

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
    assert.equal(resolveChatPolicy({ kind: 'chat_node', nodeId: 'a' }, null, tool), 'ask');
    for (const nodeId of ['b', 'c']) assert.equal(resolveChatPolicy({ kind: 'chat_node', nodeId }, null, tool, true), 'allow');
  }
  assert.equal(resolveChatPolicy({ kind: 'chat_node', nodeId: 'a' }, null, 'read'), 'allow');
  assert.equal(resolveChatPolicy({ kind: 'chat_node', nodeId: 'a' }, null, 'Read', true), 'ask');
  modes.b = 'ask';
  assert.equal(resolveChatPolicy({ kind: 'chat_node', nodeId: 'b' }, null, 'write'), 'ask');
});

test('always-allow canonical tool grant is confined to a single ordinary chat', () => {
  const grants = configure({});
  const owner = { kind: 'chat_node' as const, nodeId: 'a' };
  grantChatPermission(owner, 'Bash');
  assert.deepEqual([...grants], ['a:bash']);
  assert.equal(resolveChatPolicy(owner, null, 'bash', true), 'allow');
  assert.equal(resolveChatPolicy({ kind: 'chat_node', nodeId: 'b' }, null, 'bash', true), 'ask');
  grantChatPermission({ kind: 'agent_run', runId: 'r', attemptId: 'a' }, 'bash');
  assert.equal(grants.size, 1);
  assert.equal(chatPermissionMode({ kind: 'agent_run', runId: 'r', attemptId: 'a' }), 'ask');
});

test('Codex maps all three modes to native turn approval and sandbox policies', () => {
  assert.deepEqual(codexChatTurnPolicy('ask', '/workspace'), { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly', networkAccess: false } });
  assert.equal(codexChatTurnPolicy('trust', '/workspace').approvalPolicy, 'never');
  assert.equal(codexChatTurnPolicy('trust', '/workspace').sandboxPolicy.type, 'workspaceWrite');
  assert.deepEqual(codexChatTurnPolicy('yolo', '/workspace'), { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
});

test('neither Kiro engine starts with unconditional trust-all-tools', () => {
  for (const engine of ['v2', 'v3'] as const) {
    assert.equal(kiroArgs(engine, 'model').includes('-a'), false);
    assert.equal(kiroArgs(engine).includes('--trust-all-tools'), false);
  }
});

for (const mode of ['ask', 'trust', 'yolo'] as const) {
  test(`Kiro ${mode} uses session-local decisions and exact offered option IDs`, async () => {
    configure({ a: mode, b: 'ask' });
    const approved: Array<unknown> = [];
    const runtime = {
      ensureClient: async () => ({ prompt: async function* () {
        yield { sessionUpdate: 'permission_request', requestId: 42, toolCall: { title: 'write' }, options: [
          { optionId: 'native-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'native-persist', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'native-deny', name: 'Deny', kind: 'reject_once' },
        ] };
        yield { sessionUpdate: 'turn_end', stopReason: 'end_turn' };
      } }),
      getCurrentMode: () => undefined, getCurrentModel: () => undefined,
      respondToPermission: (...args: unknown[]) => approved.push(args),
    } as unknown as KiroRuntime;
    const session = new KiroSession('a', 'native-a', runtime, '/tmp', { owner: { kind: 'chat_node', nodeId: 'a' } });
    const events = [];
    for await (const event of session.send('test')) events.push(event);
    const permission = events.find((event) => event.kind === 'permission_request');
    if (mode === 'ask') {
      assert.ok(permission);
      assert.equal(permission.options.some((option) => option.kind === 'allow_always'), false, 'native persistent grants cannot survive switching back to Ask');
      assert.deepEqual(approved, []);
    } else {
      assert.equal(permission, undefined);
      assert.deepEqual(approved, [['native-a', 42, 'native-once']]);
    }
    assert.equal(chatPermissionMode({ kind: 'chat_node', nodeId: 'b' }), 'ask');
  });
}
