import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDb, getDb, initDb } from '../src/services/db';
import { saveNode, saveTree, saveWorkspace } from '../src/services/dbRepository';

// Regression tests for 0021_nodes_fts_trigger_fix.sql.
//
// nodes_fts is an FTS5 external-content table. 0020's AFTER UPDATE/DELETE
// triggers issued the 'delete' command unconditionally while its AFTER INSERT
// trigger only indexed non-empty titles, so titling a previously-untitled node
// asked FTS5 to delete an entry that was never inserted. On a fresh database
// that raises SQLITE_CORRUPT_VTAB inside coreFinalizeTurn's transaction (so the
// turn rolls back and the assistant message persists empty); on a populated
// index it corrupts silently. These tests pin both directions.

function node(id: string, title: string | null) {
  return {
    id, workspace_id: 'ws-1', tree_id: 'tree-1', parent_node_id: null,
    kind: 'chat', title, branch_overview: null, status: 'idle',
    position_x: null, position_y: null, minimized: 0, deleted_at: null,
    deletion_group_id: null, spawned_by_agent: 0, current_mode_id: null,
    pane_width: null, digest: null, follow_ups: null,
    follow_ups_source_message_id: null, acp_session_id: null, runtime_id: null,
    provider_id: null, model_id: null, reasoning: null, resume_fingerprint: null,
    composer_draft: null, external_session_id: null, trim_snapshot: null,
    created_at: 1,
  };
}

/** FTS5's own consistency check: throws SQLITE_CORRUPT_VTAB if the index and
 *  the content table disagree. This is what silently failed before 0021. */
function assertFtsIntact(): void {
  getDb().exec("INSERT INTO nodes_fts(nodes_fts, rank) VALUES('integrity-check', 1);");
}

function titleSearch(term: string): string[] {
  return (getDb()
    .prepare(`SELECT n.id AS id FROM nodes_fts f JOIN nodes n ON n.rowid = f.rowid
              WHERE nodes_fts MATCH ? ORDER BY n.id`)
    .all(term) as unknown as Array<{ id: string }>).map((r) => r.id);
}

describe('nodes_fts triggers', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-nodes-fts-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
    saveWorkspace({
      id: 'ws-1', name: 'Workspace', created_at: 1, updated_at: 1,
      active_tree_id: 'tree-1', cwd: null, settings: null,
    });
    saveTree({
      id: 'tree-1', workspace_id: 'ws-1', root_node_id: 'node-1',
      name: null, archived_at: null, pinned_at: null, last_active_at: 1, created_at: 1,
    });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('titling an untitled node leaves a populated index intact', () => {
    saveNode(node('node-1', 'already titled'));
    saveNode(node('node-2', null));
    getDb().exec("UPDATE nodes SET title = 'Second answer' WHERE id = 'node-2'");
    assertFtsIntact();
    assert.deepEqual(titleSearch('Second'), ['node-2']);
    assert.deepEqual(titleSearch('titled'), ['node-1']);
  });

  test('renaming, clearing and re-setting a title all keep the index intact', () => {
    saveNode(node('node-1', 'original'));
    const db = getDb();
    db.exec("UPDATE nodes SET title = 'renamed' WHERE id = 'node-1'");
    assertFtsIntact();
    assert.deepEqual(titleSearch('original'), []);
    assert.deepEqual(titleSearch('renamed'), ['node-1']);

    db.exec("UPDATE nodes SET title = NULL WHERE id = 'node-1'");
    assertFtsIntact();
    assert.deepEqual(titleSearch('renamed'), []);

    db.exec("UPDATE nodes SET title = 'restored' WHERE id = 'node-1'");
    assertFtsIntact();
    assert.deepEqual(titleSearch('restored'), ['node-1']);
  });
});
