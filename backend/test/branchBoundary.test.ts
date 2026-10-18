import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, initDb } from '../src/services/db';
import { saveMessage, saveNode, saveEdge, saveTree, saveWorkspace } from '../src/services/dbRepository';
import {
  BranchBoundaryError,
  renderBranchContext,
  resolveBranchBoundary,
  toBranchContext,
} from '../src/services/branchBoundary';

describe('resolve a branch boundary from durable graph + messages', () => {
  let dir: string;
  const oldDataDir = process.env.MICHI_DATA_DIR;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-branch-boundary-'));
    process.env.MICHI_DATA_DIR = dir;
    closeDb();
    initDb();
    saveWorkspace({ id: 'ws', name: 'Workspace', created_at: 1, updated_at: 1 });
    saveTree({ id: 'tree', workspace_id: 'ws', root_node_id: 'root', created_at: 1, last_active_at: 1 });
    for (const id of ['root', 'child']) {
      saveNode({ id, workspace_id: 'ws', tree_id: 'tree', parent_node_id: id === 'child' ? 'root' : null,
        kind: 'chat', title: id, status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 });
    }
    const messages = [
      ['m1', 'user', 'first question', 1],
      ['m2', 'assistant', 'first answer', 2],
      ['m3', 'user', 'later question', 3],
      ['m4', 'assistant', 'later answer', 4],
    ] as const;
    for (const [id, role, content, createdAt] of messages) {
      saveMessage({ id, node_id: 'root', role, content, seq: createdAt - 1, created_at: createdAt });
    }
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
    if (oldDataDir === undefined) delete process.env.MICHI_DATA_DIR;
    else process.env.MICHI_DATA_DIR = oldDataDir;
  });

  function branchEdge(anchor: string | null, createdAt: number | null = null) {
    saveEdge({ id: 'root-child', workspace_id: 'ws', source_node_id: 'root', target_node_id: 'child',
      kind: 'branch', anchor_message_id: anchor, created_at: createdAt });
  }

  test('an anchored cut inherits exactly through the selected message', () => {
    branchEdge('m2');
    const boundary = resolveBranchBoundary({ childNodeId: 'child' });
    assert.ok(boundary);
    assert.equal(boundary.kind, 'exact');
    assert.equal(boundary.parentNodeId, 'root');
    assert.equal(boundary.boundaryMessageId, 'm2');
    assert.equal(boundary.atTail, false);
    assert.deepEqual(boundary.messages.map(message => message.id), ['m1', 'm2']);
    assert.equal(boundary.note, undefined);
  });

  test('a tail anchor is reported as tail so native latest-state fork stays valid', () => {
    branchEdge('m4');
    const boundary = resolveBranchBoundary({ childNodeId: 'child' });
    assert.ok(boundary);
    assert.equal(boundary.atTail, true);
    assert.deepEqual(boundary.messages.map(message => message.id), ['m1', 'm2', 'm3', 'm4']);
  });

  test('a missing anchor is rejected instead of silently inheriting everything', () => {
    branchEdge('gone');
    assert.throws(
      () => resolveBranchBoundary({ childNodeId: 'child' }),
      (error: unknown) => error instanceof BranchBoundaryError && error.code === 'BRANCH_ANCHOR_UNAVAILABLE',
    );
  });

  test('a pre-provenance edge falls back to its creation time and is marked approximate', () => {
    branchEdge(null, 2);
    const boundary = resolveBranchBoundary({ childNodeId: 'child' });
    assert.ok(boundary);
    assert.equal(boundary.kind, 'approx');
    assert.equal(boundary.atTail, false);
    assert.deepEqual(boundary.messages.map(message => message.id), ['m1', 'm2']);
    assert.match(boundary.note ?? '', /reconstructed from the branch creation time/);
  });

  test('an unanswered final user message adds a model-facing tail note', () => {
    branchEdge('m3');
    const boundary = resolveBranchBoundary({ childNodeId: 'child' });
    assert.ok(boundary);
    assert.match(boundary.note ?? '', /had not yet answered/);
    const context = toBranchContext(boundary);
    assert.equal(context.kind, 'exact');
    const rendered = renderBranchContext(context);
    assert.match(rendered ?? '', /Inherited branch transcript/);
    assert.match(rendered ?? '', /Note: At the branch point/);
  });
});
