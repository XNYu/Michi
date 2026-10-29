/**
 * The Michi assistant's conversations are not search or navigation material
 * outside its own workspace: Michi's /api/search (keyword, grouped with the
 * title pass, semantic) leaves system workspaces out unless a search names
 * that workspace, and other agents' list_threads / search_messages /
 * read_node cannot reach them. Temp SQLite per test.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { closeDb, initDb } from '../src/services/db';
import { loadFullWorkspace, saveEdge, saveMessage, saveNode, saveTree, saveWorkspace, setAiGlobalContext } from '../src/services/dbRepository';
import { ensureAssistant } from '../src/assistant/store';
import { keywordSearch, nodeGroupedSearch, setupSearchRoutes } from '../src/routes/search';
import { setupBackupRoutes } from '../src/routes/backup';
import { listThreads, readNode, readNodeOverview, searchMessages } from '../src/services/globalContext';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { createPage } from '../src/services/pages/repository';
import { ensurePageHelper, promotePageHelper } from '../src/services/pages/helpers';

function seedChat(id: string, workspaceId: string, title: string): void {
  saveTree({ id: `t-${id}`, workspace_id: workspaceId, root_node_id: id, last_active_at: 1, created_at: 1 });
  saveNode({ id, workspace_id: workspaceId, tree_id: `t-${id}`, kind: 'chat', title, status: 'idle', minimized: 0, spawned_by_agent: 0, runtime_id: 'claude', created_at: 1 });
}

describe('search leaves the assistant out', () => {
  let tmpDir: string;
  let assistant: ReturnType<typeof ensureAssistant>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-search-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
    saveWorkspace({ id: 'ws-a', name: 'A', cwd: '/tmp/a', created_at: 1, updated_at: 1, settings: null });
    setAiGlobalContext('ws-a', true);
    seedChat('n-a', 'ws-a', 'Pelican release');
    saveMessage({ id: 'm-a', node_id: 'n-a', role: 'user', content: 'pelican migration plan', seq: 1, created_at: 1 });
    assistant = ensureAssistant();
    // The assistant's conversation talks about the same thing, and is titled after it.
    saveMessage({ id: 'm-q', node_id: assistant.nodeId, role: 'user', content: 'where is the pelican plan?', seq: 1, created_at: 2 });
    seedChat('n-asst-title', assistant.workspaceId, 'Pelican questions');
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('keyword and grouped search (title pass included) across workspaces', () => {
    assert.deepEqual(keywordSearch('pelican').map((r) => r.node_id), ['n-a']);
    const grouped = nodeGroupedSearch('pelican');
    assert.deepEqual(grouped.map((r) => r.nodeId), ['n-a'], 'neither its messages nor its titles');
    // A search that names the assistant's workspace searches exactly that one.
    assert.deepEqual(keywordSearch('pelican', assistant.workspaceId).map((r) => r.node_id), [assistant.nodeId]);
  });

  test('GET /api/search in every mode', async () => {
    const app = express();
    app.use('/api', setupSearchRoutes());
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/search?q=pelican`;
      const keyword = await (await fetch(base)).json() as { results: Array<{ node_id: string }> };
      assert.deepEqual(keyword.results.map((r) => r.node_id), ['n-a']);
      const grouped = await (await fetch(`${base}&mode=grouped`)).json() as { results: Array<{ nodeId: string }> };
      assert.deepEqual(grouped.results.map((r) => r.nodeId), ['n-a']);
      const semantic = await (await fetch(`${base}&mode=semantic`)).json() as { results: Array<{ node_id: string }> };
      assert.deepEqual(semantic.results.map((r) => r.node_id), ['n-a']);
    } finally {
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    }
  });

  test('other agents can neither find, list nor read the assistant\'s threads', () => {
    const all = searchMessages('ws-a', null, 'pelican', 'all');
    assert.match(all.text, /Found 1 match/);
    assert.doesNotMatch(all.text, new RegExp(assistant.nodeId));
    assert.equal(listThreads('ws-a', null, assistant.workspaceId).status, 'no_workspace');
    assert.equal(readNode('ws-a', null, assistant.nodeId).status, 'not_found');
    assert.equal(readNodeOverview('ws-a', null, assistant.nodeId).status, 'not_found');
    // Their own workspace and other ordinary ones are unchanged.
    assert.equal(listThreads('ws-a', null).status, 'ok');
    assert.equal(readNode('ws-a', null, 'n-a').status, 'ok');
  });

  test('unpromoted page helpers stay out of every ordinary search and export, then appear immediately after promotion', async () => {
    const page = createPage({ workspaceId: 'ws-a', ownerUserId: LOCAL_AGENT_OWNER_ID, title: 'Quartz Helper Only' });
    const helper = ensurePageHelper(page.id, LOCAL_AGENT_OWNER_ID);
    saveMessage({ id: 'm-helper', node_id: helper.nodeId, role: 'user', content: 'marigold helper secret phrase', seq: 1, created_at: 3 });
    saveEdge({ id: 'edge-helper', workspace_id: 'ws-a', source_node_id: 'n-a', target_node_id: helper.nodeId, kind: 'link', created_at: 4 });

    const snapshot = loadFullWorkspace('ws-a')!;
    assert.equal(snapshot.nodes.find((node) => node.id === helper.nodeId)?.page_id, page.id,
      'authoritative snapshots retain the helper binding for page embedding');
    assert.deepEqual(keywordSearch('marigold').map((row) => row.node_id), []);
    assert.deepEqual(keywordSearch('Quartz').map((row) => row.node_id), [], 'keyword title matches remain hidden');
    assert.deepEqual(nodeGroupedSearch('marigold').map((row) => row.nodeId), []);
    assert.deepEqual(nodeGroupedSearch('Quartz').map((row) => row.nodeId), [], 'the FTS title pass remains hidden');
    assert.deepEqual(keywordSearch('marigold', 'ws-a').map((row) => row.node_id), []);

    // Exercise the legacy title fallback as well as FTS title search.
    const db = (await import('../src/services/db')).getDb();
    db.exec('DROP TABLE nodes_fts');
    assert.deepEqual(nodeGroupedSearch('Quartz').map((row) => row.nodeId), [], 'the LIKE title fallback remains hidden');

    const searchApp = express();
    searchApp.use('/api', setupSearchRoutes());
    const searchServer = searchApp.listen(0, '127.0.0.1');
    await new Promise((resolve) => searchServer.once('listening', resolve));
    const semanticUrl = `http://127.0.0.1:${(searchServer.address() as AddressInfo).port}/api/search?q=marigold&mode=semantic`;
    const hiddenSemantic = await (await fetch(semanticUrl)).json() as { results: Array<{ node_id: string }> };
    assert.deepEqual(hiddenSemantic.results.map((row) => row.node_id), []);

    const backupApp = express();
    backupApp.use(express.json());
    backupApp.use('/api', setupBackupRoutes());
    const backupServer = backupApp.listen(0, '127.0.0.1');
    await new Promise((resolve) => backupServer.once('listening', resolve));
    const backupUrl = `http://127.0.0.1:${(backupServer.address() as AddressInfo).port}/api/backup/export/ws-a`;
    try {
      const hiddenBackup = await (await fetch(backupUrl)).json() as { workspaces: Array<{ nodes: Array<{ id: string }>; messages: Array<{ id: string }>; edges: Array<{ id: string }> }> };
      const hiddenWorkspace = hiddenBackup.workspaces[0]!;
      assert.equal(hiddenWorkspace.nodes.some((node) => node.id === helper.nodeId), false);
      assert.equal(hiddenWorkspace.messages.some((message) => message.id === 'm-helper'), false);
      assert.equal(hiddenWorkspace.edges.some((edge) => edge.id === 'edge-helper'), false);

      promotePageHelper(page.id, LOCAL_AGENT_OWNER_ID);
      assert.deepEqual(keywordSearch('marigold').map((row) => row.node_id), [helper.nodeId]);
      assert.deepEqual(nodeGroupedSearch('marigold').map((row) => row.nodeId), [helper.nodeId]);
      assert.deepEqual(nodeGroupedSearch('Quartz').map((row) => row.nodeId), [helper.nodeId]);
      const semantic = await (await fetch(semanticUrl)).json() as { results: Array<{ node_id: string }> };
      assert.deepEqual(semantic.results.map((row) => row.node_id), [helper.nodeId]);
      const visibleBackup = await (await fetch(backupUrl)).json() as typeof hiddenBackup;
      const visibleWorkspace = visibleBackup.workspaces[0]!;
      assert.equal(visibleWorkspace.nodes.some((node) => node.id === helper.nodeId), true);
      assert.equal(visibleWorkspace.messages.some((message) => message.id === 'm-helper'), true);
      assert.equal(visibleWorkspace.edges.some((edge) => edge.id === 'edge-helper'), true);
    } finally {
      await new Promise<void>((resolve) => { backupServer.close(() => resolve()); backupServer.closeAllConnections(); });
      await new Promise<void>((resolve) => { searchServer.close(() => resolve()); searchServer.closeAllConnections(); });
    }
  });
});
