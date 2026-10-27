// Characterizes what a runtime session owner decides on Michi's side, so the
// owner flip (runtime owners carry only a mode and a key, Michi maps them to
// chat nodes and Agent Run Attempts) cannot change it:
// - owner identity: interactive and headless owners never match, and a
//   release by a stranger fails with "Owner mismatch";
// - the session registry gives an unowned session the chat owner of its id;
// - chat permission modes, grants and reset tokens are keyed by the chat's
//   node id, and a Run owner never reaches them;
// - Run-scoped tools (conversation updates, pane inspection) see the Run id
//   of a Run owner, through MCP and through Pi, and no Run id for a chat.
import { afterEach, describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSessionState } from 'michi-shared';
import { assertOwner, ownerMode, sameOwner } from 'michi-runtime';
import { assertReleaseOwnership } from 'michi-runtime/internal/core/release';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { clearAllSessions, getSessionForOwner, registerSession, sessionMatchesOwner } from '../src/agents/sessionRegistry';
import { michiPermissionPolicy } from '../src/agents/chatApprovalState';
import { McpSlotRegistry, buildMcpServerForSlot, type McpSlot } from '../src/services/mcpServer';
import { buildPiTools } from '../src/agents/pi/piTools';
import type { AgentSession } from '../src/agents/types';
import { chatOwner as chat, runOwner as run } from './helpers/owners';

afterEach(() => {
  clearAllSessions();
  __resetRuntimeDeps();
});

describe('owner identity', () => {
  test('chats are interactive and Runs headless', () => {
    assert.equal(ownerMode(chat('n-1')), 'interactive');
    assert.equal(ownerMode(run('run-1', 'attempt-1')), 'headless');
  });

  test('owners match by mode and id; a chat never matches a Run, even under the same id', () => {
    assert.equal(sameOwner(chat('n-1'), chat('n-1')), true);
    assert.equal(sameOwner(chat('n-1'), chat('n-2')), false);
    assert.equal(sameOwner(run('run-1', 'attempt-1'), run('run-1', 'attempt-1')), true);
    assert.equal(sameOwner(run('run-1', 'attempt-1'), run('run-1', 'attempt-2')), false);
    assert.equal(sameOwner(chat('shared'), run('run-1', 'shared')), false);
    assert.equal(sameOwner(run('run-1', 'shared'), chat('shared')), false);
  });

  test('a mismatch throws "Owner mismatch", and a release guard tags it SESSION_OWNER_MISMATCH', () => {
    assert.doesNotThrow(() => assertOwner(chat('n-1'), chat('n-1')));
    assert.throws(() => assertOwner(chat('n-1'), run('run-1', 'n-1')), /^Error: Owner mismatch: /);
    assert.doesNotThrow(() => assertReleaseOwnership(run('run-1', 'attempt-1'), undefined));
    assert.doesNotThrow(() => assertReleaseOwnership(run('run-1', 'attempt-1'), run('run-1', 'attempt-1')));
    assert.throws(() => assertReleaseOwnership(run('run-1', 'attempt-1'), run('run-2', 'attempt-2')),
      (error: Error & { code?: string }) => error.message.startsWith('Owner mismatch: ') && error.code === 'SESSION_OWNER_MISMATCH');
  });
});

describe('session registry owners', () => {
  function fake(id: string, extra: Partial<AgentSession> = {}): AgentSession {
    return {
      id, runtimeId: 'pi', getHistory: () => [], getPendingAssistant: () => undefined,
      async *send() {}, cancel: () => {},
      getSessionState: (): AgentSessionState => ({ runtimeId: 'pi' }),
      ...extra,
    } as AgentSession;
  }

  test('an unowned session registers as the chat of its own id', () => {
    const session = fake('n-1');
    registerSession(session, 'alice');
    assert.equal(sessionMatchesOwner('n-1', chat('n-1')), true);
    assert.equal(sessionMatchesOwner('n-1', run('run-1', 'n-1')), false);
    assert.equal(getSessionForOwner('n-1', chat('n-1'), 'alice'), session);
  });

  test('a Run session registers under its own owner, never as the chat of its id', () => {
    const session = fake('attempt-1', { owner: run('run-1', 'attempt-1') });
    registerSession(session, 'alice');
    assert.equal(sessionMatchesOwner('attempt-1', run('run-1', 'attempt-1')), true);
    assert.equal(sessionMatchesOwner('attempt-1', chat('attempt-1')), false);
    assert.equal(getSessionForOwner('attempt-1', chat('attempt-1'), 'alice'), null);
  });
});

describe('chat permission keys', () => {
  type Call = [string, ...unknown[]];
  function setup(): Call[] {
    const calls: Call[] = [];
    configureRuntimeDeps({
      dataDir: '/tmp/michi-owner-flip-tests',
      historyStore: {
        getNode: (id: string) => { calls.push(['getNode', id]); return id === 'n-1' ? { workspace_id: 'ws-1' } : null; },
        listMessages: () => [],
        getWorkspace: (id: string) => (id === 'ws-1' ? { owner_user_id: 'workspace-owner' } : null),
        getWorkspaceInstructions: () => null,
        hasGrant: () => false,
        grantPermission: () => { throw new Error('No workspace grants'); },
      } as never,
      agentConfig: { getAgentConfig: () => ({ runtime: 'pi', provider: 'x', modelByRuntime: {}, reasoningByRuntime: {} }), resolveModel: () => '', resolveReasoning: () => undefined },
      chatPermissions: {
        getMode: (id, userId) => { calls.push(['getMode', id, userId]); return 'ask'; },
        hasGrant: (id, name, userId) => { calls.push(['hasGrant', id, name, userId]); return name === 'bash'; },
        grant: (id, name, userId) => { calls.push(['grant', id, name, userId]); },
        resetToken: (id, userId) => { calls.push(['resetToken', id, userId]); return `token-${id}`; },
      },
    });
    return calls;
  }

  test('a chat owner reads and writes its mode, grants and reset token under its node id', () => {
    const calls = setup();
    const owner = chat('n-1');
    assert.equal(michiPermissionPolicy.mode(owner, 'alice'), 'ask');
    assert.equal(michiPermissionPolicy.decide({ owner, ownerUserId: 'alice', toolName: 'Bash', nativeRequest: true }), 'allow');
    michiPermissionPolicy.grant({ owner, ownerUserId: 'alice', toolName: 'Edit' });
    assert.equal(michiPermissionPolicy.resetToken!(owner, 'alice'), 'token-n-1');
    assert.deepEqual(calls, [
      ['getMode', 'n-1', 'alice'],
      ['getMode', 'n-1', 'alice'],
      ['hasGrant', 'n-1', 'bash', 'alice'],
      ['grant', 'n-1', 'edit', 'alice'],
      ['resetToken', 'n-1', 'alice'],
    ]);
  });

  test('without a user, a chat owner resolves the workspace owner from its node row', () => {
    const calls = setup();
    assert.equal(michiPermissionPolicy.resolveOwnerUserId(chat('n-1'), null), 'workspace-owner');
    assert.deepEqual(calls, [['getNode', 'n-1']]);
  });

  test('a Run owner never reaches the chat permission store', () => {
    const calls = setup();
    const owner = run('run-1', 'attempt-1');
    assert.equal(michiPermissionPolicy.mode(owner, 'alice'), 'ask');
    assert.equal(michiPermissionPolicy.mode(undefined, 'alice'), 'ask');
    assert.equal(michiPermissionPolicy.decide({ owner, ownerUserId: 'alice', toolName: 'Bash', nativeRequest: true }), 'ask');
    assert.equal(michiPermissionPolicy.decide({ owner, ownerUserId: 'alice', toolName: 'send_to_thread', nativeRequest: true }), 'ask');
    michiPermissionPolicy.grant({ owner, ownerUserId: 'alice', toolName: 'Bash' });
    assert.equal(michiPermissionPolicy.resetToken!(owner, 'alice'), undefined);
    assert.equal(michiPermissionPolicy.resolveOwnerUserId(owner, null), null);
    assert.deepEqual(calls, []);
  });
});

describe('Run-scoped tool bindings', () => {
  type Binding = { runOwnerRunId?: string | null; workspaceId?: string | null; ownerUserId?: string | null };
  function captureBindings(t: TestContext): Binding[] {
    const seen: Binding[] = [];
    t.mock.method(require('../src/agents/conversationUpdatesTool'), 'readConversationUpdatesTool', (binding: Binding) => {
      seen.push(binding);
      return { content: [{ type: 'text', text: '{}' }] };
    });
    t.mock.method(require('../src/agents/paneInspectionTools'), 'inspectPaneTool', (binding: Binding) => {
      seen.push(binding);
      return { content: [{ type: 'text', text: '' }] };
    });
    return seen;
  }

  const chatCallbacks = () => ({
    onSpawnBranches: async () => [],
    onSaveArtifact: () => null,
    onUpdateArtifact: () => null,
    onShowImage: () => ({ error: 'unsupported in test' as const }),
  });

  function mcpHandlers(slot: McpSlot) {
    const tools = (buildMcpServerForSlot(slot) as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    return { updates: tools.read_conversation_updates.handler, inspect: tools.inspect_pane.handler };
  }

  test('an MCP slot hands its Run owner\'s Run id to Run-scoped tools, and a chat slot none', async (t) => {
    const seen = captureBindings(t);
    t.mock.method(require('../src/services/dbRepository'), 'getNodeSessionBinding', () => null);
    const registry = new McpSlotRegistry();
    const runSlot = registry.create('attempt-1', '/tmp', 'alice', { ...chatCallbacks(), owner: run('run-1', 'attempt-1') },
      { workspaceId: 'ws-run' });
    const chatSlot = registry.create('n-1', '/tmp', 'alice', { ...chatCallbacks(), owner: chat('n-1') },
      { nodeId: 'n-1', workspaceId: 'ws-chat' });
    for (const slot of [runSlot, chatSlot]) {
      const { updates, inspect } = mcpHandlers(slot);
      await updates({ after: 0 });
      await inspect({ nodeId: 'n-2' });
    }
    assert.deepEqual(seen.map((binding) => [binding.runOwnerRunId, binding.workspaceId, binding.ownerUserId]), [
      ['run-1', 'ws-run', 'alice'],
      ['run-1', 'ws-run', 'alice'],
      [null, 'ws-chat', 'alice'],
      [null, 'ws-chat', 'alice'],
    ]);
  });

  test('Pi hands its Run owner\'s Run id to Run-scoped tools, and a chat owner none', async (t) => {
    const seen = captureBindings(t);
    configureRuntimeDeps({
      dataDir: '/tmp/michi-owner-flip-tests',
      historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null,
        hasGrant: () => false, grantPermission: () => {} } as never,
      agentConfig: { getAgentConfig: () => ({ runtime: 'pi', provider: 'x', modelByRuntime: {}, reasoningByRuntime: {} }), resolveModel: () => '', resolveReasoning: () => undefined },
    });
    const Type = new Proxy({}, { get: () => () => ({}) });
    for (const owner of [run('run-1', 'attempt-1'), chat('n-1')]) {
      const tools = buildPiTools({ bridge: {} as never, cwd: '/tmp', parentChatId: 'p', workspaceId: 'ws-pi', ownerUserId: 'alice',
        owner, enableFollowUps: false, imageQuota: { usedBytes: 0, limitBytes: 1 } as never, seenPaths: new Set<string>(), Type });
      const byName = (name: string) => tools.find((tool: { name: string }) => tool.name === name);
      await byName('read_conversation_updates').execute('updates', { after: 0 });
      await byName('inspect_pane').execute('inspect', { nodeId: 'n-2' });
      // Reporting "no change" belongs to a chat; a Run owner is not offered it.
      assert.equal(!!byName('report_conversation_no_change'), ownerMode(owner) === 'interactive');
    }
    assert.deepEqual(seen.map((binding) => [binding.runOwnerRunId, binding.workspaceId, binding.ownerUserId]), [
      ['run-1', 'ws-pi', 'alice'],
      ['run-1', 'ws-pi', 'alice'],
      [null, 'ws-pi', 'alice'],
      [null, 'ws-pi', 'alice'],
    ]);
  });
});
