/**
 * Deleted workspaces and purged nodes keep tombstone rows (purged_at) for the
 * GC window, and their titles stay in nodes_fts. The grouped search's title
 * pass must leave them out like every other search channel.
 *
 * Nodes inside a Tree are removed physically when deleteWorkspace drops the
 * Tree (FK cascade), so these fixtures use Nodes without a Tree: those keep
 * their tombstone row and title.
 */
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { deleteWorkspace, purgeWorkspaceNodes, saveNode, saveWorkspace } from '../src/services/dbRepository';
import { nodeGroupedSearch } from '../src/routes/search';

function seedWorkspace(id: string): void {
  saveWorkspace({ id, name: id, cwd: null, created_at: 1, updated_at: 1, settings: null });
}

function seedTreelessChat(workspaceId: string, id: string, title: string): void {
  saveNode({ id, workspace_id: workspaceId, kind: 'chat', title, status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 });
}

function dropNodesFts(): void {
  const db = getDb();
  db.exec('DROP TRIGGER IF EXISTS nodes_fts_ai');
  db.exec('DROP TRIGGER IF EXISTS nodes_fts_ad');
  db.exec('DROP TRIGGER IF EXISTS nodes_fts_au');
  db.exec('DROP TABLE IF EXISTS nodes_fts');
}

describe('grouped search title pass and tombstones', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-tombstones-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
    seedWorkspace('ws-live');
    seedWorkspace('ws-gone');
    seedTreelessChat('ws-live', 'n-live', 'Kestrel live plan');
    seedTreelessChat('ws-live', 'n-purged', 'Kestrel purged plan');
    seedTreelessChat('ws-gone', 'n-gone', 'Kestrel deleted plan');
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function titleHits(): string[] {
    return nodeGroupedSearch('kestrel').map((row) => row.nodeId).sort();
  }

  function tombstone(): void {
    deleteWorkspace('ws-gone');
    purgeWorkspaceNodes('ws-live', ['n-purged']);
    // The tombstone rows are still there; only search must hide them.
    const rows = getDb().prepare('SELECT id FROM nodes WHERE purged_at IS NOT NULL ORDER BY id').all() as Array<{ id: string }>;
    assert.deepEqual(rows.map((row) => row.id), ['n-gone', 'n-purged']);
  }

  test('FTS title pass leaves out deleted workspaces and purged nodes', () => {
    assert.deepEqual(titleHits(), ['n-gone', 'n-live', 'n-purged']);
    tombstone();
    assert.deepEqual(titleHits(), ['n-live']);
  });

  test('LIKE title fallback leaves out deleted workspaces and purged nodes', () => {
    tombstone();
    dropNodesFts();
    assert.deepEqual(titleHits(), ['n-live']);
  });
});
