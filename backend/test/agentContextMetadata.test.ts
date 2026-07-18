import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDb, initDb } from '../src/services/db';
import { listContexts, saveNode, saveWorkspace, upsertAgentContextMetadata } from '../src/services/dbRepository';

describe('agent context metadata persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-agent-context-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
    saveWorkspace({ id: 'ws-1', name: 'Workspace', created_at: 1, updated_at: 1 });
    saveNode({
      id: 'node-1', workspace_id: 'ws-1', tree_id: null, parent_node_id: null,
      kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1,
    });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('upserts one durable agent context by workspace/name for save and update', () => {
    const savedId = upsertAgentContextMetadata({
      workspaceId: 'ws-1', nodeId: 'node-1', name: 'notes', filePath: '.contexts/notes.md', size: 2,
    });
    assert.ok(savedId);
    const [saved] = listContexts('ws-1');
    assert.equal(saved.id, savedId);

    const updatedId = upsertAgentContextMetadata({
      workspaceId: 'ws-1', nodeId: 'node-1', name: 'notes', filePath: '.contexts/notes.md', size: 11,
    });
    const contexts = listContexts('ws-1');

    assert.equal(updatedId, savedId);
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].id, saved.id);
    assert.equal(contexts[0].size, 11);
    assert.equal(contexts[0].source, 'agent');
    assert.equal(contexts[0].origin_node_id, 'node-1');
  });
});
