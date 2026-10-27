import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDb, getDb, initDb } from '../src/services/db';
import { loadProfileActivity } from '../src/services/profileActivity';

const timestamp = (iso: string): number => new Date(iso).getTime();

function seedWorkspace(id: string, ownerUserId: string): void {
  getDb().prepare(
    'INSERT INTO workspaces (id, name, created_at, updated_at, owner_user_id) VALUES (?, ?, ?, ?, ?)',
  ).run(id, id, 1, 1, ownerUserId);
}

function seedTree(id: string, workspaceId: string, rootNodeId: string): void {
  getDb().prepare(
    'INSERT INTO trees (id, workspace_id, root_node_id, last_active_at, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, workspaceId, rootNodeId, 1, 1);
}

function seedNode(input: {
  id: string;
  workspaceId: string;
  treeId: string;
  createdAt: number;
  parentNodeId?: string;
  deletedAt?: number;
  maintenanceJobId?: string;
}): void {
  getDb().prepare(
    `INSERT INTO nodes (
      id, workspace_id, tree_id, parent_node_id, kind, status, minimized,
      deleted_at, spawned_by_agent, created_at, maintenance_job_id
    ) VALUES (?, ?, ?, ?, 'chat', 'idle', 0, ?, 0, ?, ?)`,
  ).run(
    input.id,
    input.workspaceId,
    input.treeId,
    input.parentNodeId ?? null,
    input.deletedAt ?? null,
    input.createdAt,
    input.maintenanceJobId ?? null,
  );
}

function seedMessage(input: {
  id: string;
  nodeId: string;
  role: 'user' | 'assistant';
  createdAt: number;
  seq: number;
}): void {
  getDb().prepare(
    'INSERT INTO messages (id, node_id, role, content, seq, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(input.id, input.nodeId, input.role, input.id, input.seq, input.createdAt);
}

describe('profile activity aggregation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-profile-activity-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    process.env.MICHI_CLOUD = '1';
    closeDb();
    initDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.MICHI_CLOUD;
    delete process.env.MICHI_REQUIRE_AUTH;
  });

  test('leaves out page helpers and Meta agent maintenance runs', () => {
    const day = timestamp('2026-09-15T03:00:00.000Z');
    seedWorkspace('mine', 'user-a');
    seedTree('mine-tree', 'mine', 'root');
    seedNode({ id: 'root', workspaceId: 'mine', treeId: 'mine-tree', createdAt: day });
    seedMessage({ id: 'user-one', nodeId: 'root', role: 'user', seq: 0, createdAt: day });
    getDb().prepare("INSERT INTO pages (id, owner_user_id, workspace_id, title, blocks, updated_at, created_at) VALUES ('page-1', 'user-a', 'mine', 'Page', '[]', 1, 1)").run();
    seedNode({ id: 'helper', workspaceId: 'mine', treeId: 'mine-tree', parentNodeId: 'root', createdAt: day });
    getDb().prepare("UPDATE nodes SET page_id = 'page-1' WHERE id = 'helper'").run();
    getDb().prepare(
      "INSERT INTO edges (id, workspace_id, source_node_id, target_node_id, kind) VALUES ('to-helper', 'mine', 'root', 'helper', 'branch')",
    ).run();
    seedMessage({ id: 'helper-message', nodeId: 'helper', role: 'user', seq: 0, createdAt: day });
    seedTree('maint-tree', 'mine', 'maint');
    seedNode({ id: 'maint', workspaceId: 'mine', treeId: 'maint-tree', createdAt: day, maintenanceJobId: 'job-1' });
    seedMessage({ id: 'maint-prompt', nodeId: 'maint', role: 'user', seq: 0, createdAt: day });

    const activity = loadProfileActivity({ userId: 'user-a', timeZone: 'UTC', nowMs: timestamp('2026-09-16T12:00:00.000Z') });
    assert.deepEqual(
      [activity.totalNodes, activity.totalThreads, activity.totalBranches, activity.totalMessages],
      [1, 1, 0, 1],
    );
    assert.deepEqual(activity.days, [{ dateKey: '2026-09-15', nodes: 1, branches: 0, messages: 1 }]);
  });

  test('returns owner-scoped daily node, branch, and user-message counts', () => {
    seedWorkspace('mine', 'user-a');
    seedTree('mine-tree', 'mine', 'root');
    seedNode({
      id: 'root',
      workspaceId: 'mine',
      treeId: 'mine-tree',
      createdAt: timestamp('2026-09-15T15:30:00.000Z'),
    });
    seedNode({
      id: 'child',
      workspaceId: 'mine',
      treeId: 'mine-tree',
      parentNodeId: 'root',
      createdAt: timestamp('2026-09-16T01:00:00.000Z'),
    });
    getDb().prepare(
      "INSERT INTO edges (id, workspace_id, source_node_id, target_node_id, kind) VALUES ('branch', 'mine', 'root', 'child', 'branch')",
    ).run();
    seedMessage({ id: 'user-one', nodeId: 'root', role: 'user', seq: 0, createdAt: timestamp('2026-09-15T16:00:00.000Z') });
    seedMessage({ id: 'assistant-one', nodeId: 'root', role: 'assistant', seq: 1, createdAt: timestamp('2026-09-15T16:01:00.000Z') });
    seedMessage({ id: 'user-two', nodeId: 'child', role: 'user', seq: 0, createdAt: timestamp('2026-09-16T02:00:00.000Z') });

    seedWorkspace('theirs', 'user-b');
    seedTree('their-tree', 'theirs', 'their-root');
    seedNode({ id: 'their-root', workspaceId: 'theirs', treeId: 'their-tree', createdAt: timestamp('2026-09-16T03:00:00.000Z') });
    seedMessage({ id: 'their-message', nodeId: 'their-root', role: 'user', seq: 0, createdAt: timestamp('2026-09-16T03:01:00.000Z') });

    const activity = loadProfileActivity({
      userId: 'user-a',
      timeZone: 'Asia/Tokyo',
      nowMs: timestamp('2026-09-16T12:00:00.000Z'),
    });

    assert.deepEqual(
      {
        totalNodes: activity.totalNodes,
        totalThreads: activity.totalThreads,
        totalBranches: activity.totalBranches,
        totalMessages: activity.totalMessages,
      },
      { totalNodes: 2, totalThreads: 1, totalBranches: 1, totalMessages: 2 },
    );
    assert.deepEqual(activity.days, [
      { dateKey: '2026-09-16', nodes: 2, branches: 1, messages: 2 },
    ]);
  });
});
