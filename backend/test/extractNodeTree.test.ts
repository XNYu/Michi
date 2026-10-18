import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { closeDb, getDb, initDb } from '../src/services/db';
import { extractNodeTree } from '../src/services/extractNodeTree';
import { getNode, listEdges, listMessages, listTrees, loadTreeMessages, saveEdge, saveMessage, saveNode, saveTree, saveWorkspace } from '../src/services/dbRepository';
import { setupPersistenceRoutes } from '../src/routes/persistence';
import { chatHub } from '../src/agents/chatHub';
import { clearAllSessions, getSession, registerSession } from '../src/agents/sessionRegistry';
import { registerRuntime } from '../src/agents/registry';
import type { AgentRuntime, AgentSession, NewAgentSessionOptions } from '../src/agents/types';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { ensureAncestorChainLoaded, getAncestors } from '../src/agents/sessionRegistry';

describe('extract a branch as an independent tree', () => {
  let dir: string;
  const oldDataDir = process.env.MICHI_DATA_DIR;
  const oldCloud = process.env.MICHI_CLOUD;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-extract-'));
    process.env.MICHI_DATA_DIR = dir;
    delete process.env.MICHI_CLOUD;
    closeDb(); initDb();
    saveWorkspace({ id: 'ws', name: 'Workspace', created_at: 1, updated_at: 1 });
    saveTree({ id: 'old', workspace_id: 'ws', root_node_id: 'root', created_at: 1, last_active_at: 1 });
    for (const [id, parent] of [['root', null], ['middle', 'root'], ['child', 'middle'], ['leaf', 'child'], ['sibling', 'root']] as const) {
      saveNode({ id, workspace_id: 'ws', tree_id: 'old', parent_node_id: parent, kind: 'chat', title: id,
        status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 });
      if (parent) saveEdge({ id: `${parent}-${id}`, workspace_id: 'ws', source_node_id: parent, target_node_id: id,
        kind: 'branch', anchor_message_id: `${parent}-a` });
      for (const [seq, role] of ['user', 'assistant'].entries()) saveMessage({ id: `${id}-${role === 'user' ? 'u' : 'a'}`,
        node_id: id, role, content: `${id} ${role}`, seq, created_at: seq + 1 });
    }
  });
  afterEach(() => {
    clearAllSessions(); __resetRuntimeDeps();
    closeDb(); fs.rmSync(dir, { recursive: true, force: true });
    if (oldDataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldDataDir;
    if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
  });

  test('prepends the anchored ancestor chain, keeps rich messages and own IDs, and moves only descendants', () => {
    const blocks = JSON.stringify([{ id: 'b', kind: 'answer', rawText: 'root assistant' }]);
    const metadata = JSON.stringify({ quotedText: 'quotation', attachments: [{ name: 'file', absPath: '/file' }] });
    getDb().prepare('UPDATE messages SET blocks = ?, tool_calls = ?, metadata = ? WHERE id = ?')
      .run(blocks, '[{"id":"tool"}]', metadata, 'root-a');
    saveMessage({ id: 'root-later', node_id: 'root', role: 'assistant', content: 'after fork', seq: 2, created_at: 3 });
    saveMessage({ id: 'middle-later', node_id: 'middle', role: 'assistant', content: 'after fork too', seq: 2, created_at: 3 });
    for (const kind of ['merge', 'link', 'digest-source']) saveEdge({ id: kind, workspace_id: 'ws', source_node_id: 'child', target_node_id: 'sibling', kind });
    const original = listMessages('root');
    const result = extractNodeTree('ws', 'child', 'new');
    assert.deepEqual(result.messages.map(m => m.content), ['root user', 'root assistant', 'middle user', 'middle assistant', 'child user', 'child assistant']);
    assert.deepEqual(result.messages.map(m => m.seq), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(result.messages.slice(-2).map(m => m.id), ['child-u', 'child-a']);
    assert.ok(result.messages.slice(0, 4).every(m => m.node_id === 'child' && m.id.startsWith('m-')));
    // Provenance: the extracted root knows the cut, the source, and how much
    // of its transcript is copied history rather than authored here.
    assert.equal(result.forkedFromNodeId, 'middle');
    assert.equal(result.inheritedMessageCount, 4);
    assert.equal(result.forkBoundaryMessageId, result.messages[3].id);
    assert.equal(getNode('child')?.forked_from_node_id, 'middle');
    assert.equal(getNode('child')?.inherited_message_count, 4);
    assert.equal(getNode('child')?.fork_boundary_message_id, result.messages[3].id);
    assert.equal(result.messages[1].blocks, blocks);
    assert.equal(result.messages[1].metadata, metadata);
    assert.equal(result.messages[1].tool_calls, '[{"id":"tool"}]');
    assert.deepEqual(listMessages('root'), original);
    assert.deepEqual(new Set(result.nodeIds), new Set(['child', 'leaf']));
    assert.equal(getNode('child')?.parent_node_id, null);
    assert.equal(getNode('leaf')?.parent_node_id, 'child');
    assert.equal(getNode('leaf')?.tree_id, 'new');
    assert.equal(getNode('sibling')?.tree_id, 'old');
    assert.equal(listEdges('ws').find(e => e.id === 'child-leaf')?.anchor_message_id, 'child-a');
    assert.deepEqual(listEdges('ws').filter(e => e.kind !== 'branch').map(e => e.kind).sort(), ['digest-source', 'merge']);
    assert.ok(!listEdges('ws').some(e => e.id === 'middle-child'));
    // The committed operation is retrievable after restart, without duplicating history.
    closeDb(); initDb();
    assert.deepEqual(extractNodeTree('ws', 'child', 'new'), result);
    assert.equal(loadTreeMessages('ws', 'new').length, 8);
    // Old-tree history can disappear without taking the snapshot with it.
    getDb().prepare('DELETE FROM messages WHERE node_id IN (?, ?)').run('root', 'middle');
    assert.equal(listMessages('child').length, 6);
  });

  test('uses branch time for older unanchored branches and rejects missing explicit anchors', () => {
    getDb().prepare('UPDATE edges SET anchor_message_id = NULL, created_at = 1 WHERE id = ?').run('root-middle');
    assert.deepEqual(extractNodeTree('ws', 'child', 'new').messages.map(m => m.content),
      ['root user', 'middle user', 'middle assistant', 'child user', 'child assistant']);
    getDb().prepare('UPDATE edges SET anchor_message_id = ? WHERE id = ?').run('missing', 'root-sibling');
    assert.throws(() => extractNodeTree('ws', 'sibling', 'another'), /anchor is missing/);
    assert.equal(getNode('sibling')?.parent_node_id, 'root');
  });

  test('extracting again from the new tree preserves inherited history exactly once and existing anchors', () => {
    extractNodeTree('ws', 'child', 'new');
    const second = extractNodeTree('ws', 'leaf', 'leaf-tree');
    assert.deepEqual(second.messages.map(m => m.content), [
      'root user', 'root assistant', 'middle user', 'middle assistant',
      'child user', 'child assistant', 'leaf user', 'leaf assistant',
    ]);
    assert.equal(new Set(second.messages.map(m => m.id)).size, 8);
    assert.equal(listMessages('child').length, 6);
    assert.equal(getNode('sibling')?.tree_id, 'old');
  });

  test('an empty child receives its history without needing a prior runtime binding', () => {
    getDb().prepare("DELETE FROM messages WHERE node_id = 'child'").run();
    const result = extractNodeTree('ws', 'child', 'new');
    assert.equal(result.messages.length, 4);
    assert.equal(getNode('child')?.parent_node_id, null);
    assert.equal(getNode('leaf')?.tree_id, 'new');
  });

  test('rejects roots, archived trees/workspaces, foreign nodes, busy descendants and broken lineage without writes', () => {
    assert.throws(() => extractNodeTree('ws', 'root', 'new'), /root/);
    assert.throws(() => extractNodeTree('other', 'child', 'new'), /not found/);
    getDb().prepare('UPDATE trees SET archived_at = 1 WHERE id = ?').run('old');
    assert.throws(() => extractNodeTree('ws', 'child', 'new'), /archived/);
    getDb().prepare('UPDATE trees SET archived_at = NULL WHERE id = ?').run('old');
    getDb().prepare('UPDATE workspaces SET archived_at = 1 WHERE id = ?').run('ws');
    assert.throws(() => extractNodeTree('ws', 'child', 'new'), /read-only/);
    getDb().prepare('UPDATE workspaces SET archived_at = NULL WHERE id = ?').run('ws');
    getDb().prepare("UPDATE nodes SET status = 'streaming' WHERE id = 'leaf'").run();
    assert.throws(() => extractNodeTree('ws', 'child', 'new'), /replies/);
    getDb().prepare("UPDATE nodes SET status = 'idle', parent_node_id = 'child' WHERE id = 'root'").run();
    assert.throws(() => extractNodeTree('ws', 'child', 'new'), /inconsistent/);
    assert.equal(listTrees('ws').length, 1);
    assert.equal(listMessages('child').length, 2);
  });

  test('checks cloud ownership and does not expose an idempotent result to another owner', () => {
    process.env.MICHI_CLOUD = '1';
    getDb().prepare("UPDATE workspaces SET owner_user_id = 'owner' WHERE id = 'ws'").run();
    assert.throws(() => extractNodeTree('ws', 'child', 'new'), /not found/);
    assert.throws(() => extractNodeTree('ws', 'child', 'new', 'stranger'), /not found/);
    extractNodeTree('ws', 'child', 'new', 'owner');
    assert.throws(() => extractNodeTree('ws', 'child', 'new', 'stranger'), /not found/);
  });

  test('rolls back graph changes, sequence shifts and copied messages when a write fails', () => {
    getDb().exec("CREATE TRIGGER fail_copy BEFORE INSERT ON messages WHEN NEW.node_id = 'child' BEGIN SELECT RAISE(ABORT, 'copy failed'); END");
    assert.throws(() => extractNodeTree('ws', 'child', 'new'), /copy failed/);
    assert.equal(listTrees('ws').length, 1);
    assert.equal(getNode('child')?.parent_node_id, 'middle');
    assert.deepEqual(listMessages('child').map(m => m.seq), [0, 1]);
  });

  test('HTTP refuses a draining runtime owner, then extracts and serves the same result on retry', async () => {
    const app = express(); app.use(express.json()); app.use('/api', setupPersistenceRoutes());
    const server = app.listen(0);
    const original = chatHub.isOwnerTurnActive;
    let released = 0;
    const session: AgentSession = { id: 'child', runtimeId: 'extraction-test', parentChatId: 'middle',
      getHistory: () => [{ role: 'assistant', content: 'old child history' }], getPendingAssistant: () => undefined,
      async *send() {}, cancel() {},
    };
    const runtime: AgentRuntime = {
      id: 'extraction-test', label: 'Test', capabilities: { modes: false, permissions: false, models: false,
        providerModels: false, reasoning: false, supportedReasoningLevels: [], apiKeys: false,
        warmSessions: false, saveContext: false, spawnBranches: true, nativeResume: false },
      async warm() {}, async shutdown() {}, async newSession(_opts: NewAgentSessionOptions) { return session; },
      async releaseSession(id, owner) {
        assert.equal(id, 'child'); assert.deepEqual(owner, { kind: 'chat_node', nodeId: 'child' }); released++;
      },
    };
    registerRuntime(runtime); registerSession(session);
    getDb().prepare("UPDATE nodes SET acp_session_id = 'native-child', external_session_id = 'native-child' WHERE id = 'child'").run();
    const post = () => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces/ws/nodes/child/extract-tree`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ treeId: 'new' }),
    });
    try {
      chatHub.isOwnerTurnActive = id => id === 'child';
      assert.equal((await post()).status, 409);
      assert.equal(released, 0);
      assert.equal(listTrees('ws').length, 1);
      chatHub.isOwnerTurnActive = original;
      const response = await post();
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(released, 1);
      assert.equal(getSession('child'), undefined);
      assert.equal(getNode('child')?.acp_session_id, null);
      assert.equal(getNode('child')?.external_session_id, null);
      assert.deepEqual(await (await post()).json(), body);
      assert.equal(released, 1);
      configureRuntimeDeps({ dataDir: dir,
        historyStore: { getNode, listMessages, getWorkspace: () => null, getWorkspaceInstructions: () => null, hasGrant: () => false, grantPermission() {} },
        agentConfig: { getAgentConfig: () => ({ runtime: 'extraction-test', provider: '', modelByRuntime: {}, reasoningByRuntime: {} }),
          resolveModel: () => '', resolveReasoning: () => undefined },
      });
      ensureAncestorChainLoaded('leaf');
      const ancestors = getAncestors('leaf');
      assert.deepEqual(ancestors.map(ancestor => ancestor.id), ['child']);
      assert.deepEqual(ancestors[0].getHistory().map(message => message.content), listMessages('child').map(message => message.content));
    } finally {
      chatHub.isOwnerTurnActive = original;
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
