import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDb, getDb, initDb } from '../src/services/db';
import {
  DeskAuthError,
  loadDeskNow,
  loadDeskPeek,
  loadDeskProjects,
  loadDeskThreads,
  mutateDeskThreads,
  searchDeskThreads,
  undoDeskReceipt,
  type DeskScope,
} from '../src/services/desk';

const NOW = Date.parse('2026-10-20T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const local: DeskScope = { ownerKey: 'local' };

function seedWorkspace(id: string, ownerUserId: string | null, name = id): void {
  getDb().prepare(
    'INSERT INTO workspaces (id, name, cwd, created_at, updated_at, owner_user_id) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, name, `/tmp/${id}`, 1, 1, ownerUserId);
}

function seedTree(id: string, workspaceId: string, rootNodeId: string, lastActiveAt: number, archivedAt: number | null = null): void {
  getDb().prepare(
    'INSERT INTO trees (id, workspace_id, root_node_id, name, archived_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, workspaceId, rootNodeId, id, archivedAt, lastActiveAt, lastActiveAt);
}

function seedNode(id: string, workspaceId: string, treeId: string, createdAt: number, status = 'idle', followUps: string | null = null): void {
  getDb().prepare(
    `INSERT INTO nodes (
      id, workspace_id, tree_id, kind, title, status, minimized, spawned_by_agent, follow_ups, created_at
    ) VALUES (?, ?, ?, 'chat', ?, ?, 0, 0, ?, ?)`,
  ).run(id, workspaceId, treeId, id, status, followUps, createdAt);
}

function seedMessage(id: string, nodeId: string, role: 'user' | 'assistant', content: string, createdAt: number, seq: number): void {
  getDb().prepare(
    'INSERT INTO messages (id, node_id, role, content, seq, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, nodeId, role, content, seq, createdAt);
}

function thread(title: string, opts: {
  at: number;
  role?: 'user' | 'assistant';
  assistant?: boolean;
  content?: string;
  status?: string;
  followUps?: string[] | null;
  archivedAt?: number | null;
  owner?: string;
  workspace?: string;
} = { at: NOW }): void {
  const workspace = opts.workspace ?? 'ws';
  const owner = opts.owner ?? 'user-a';
  const existing = getDb().prepare('SELECT id FROM workspaces WHERE id = ?').get(workspace);
  if (!existing) seedWorkspace(workspace, owner, workspace === 'ws' ? 'Michi' : workspace);
  seedTree(title, workspace, `${title}-root`, opts.at, opts.archivedAt ?? null);
  seedNode(
    `${title}-root`,
    workspace,
    title,
    opts.at,
    opts.status ?? 'idle',
    opts.followUps ? JSON.stringify(opts.followUps) : null,
  );
  if (opts.role) {
    if (opts.assistant !== false && opts.role === 'assistant') {
      seedMessage(`${title}-u`, `${title}-root`, 'user', 'start', opts.at - 1000, 0);
    }
    seedMessage(`${title}-m`, `${title}-root`, opts.role, opts.content ?? title, opts.at, 1);
  }
}

describe('desk threads from Michi conversations', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-desk-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.MICHI_CLOUD;
  });

  test('sorts a reply, a quiet thread, an unanswered prompt, and a blank thread', () => {
    thread('waiting', { at: NOW - 60 * 60 * 1000, role: 'assistant', content: 'Need a decision on the schema', followUps: ['Pick camelCase'] });
    thread('stalled', { at: NOW - 4 * DAY, role: 'assistant', content: 'Still on the old path' });
    thread('doing', { at: NOW - 2 * 60 * 60 * 1000, role: 'user', assistant: false, content: 'Please continue' });
    thread('blank', { at: NOW - 60 * 1000 });
    thread('old', { at: NOW - 40 * DAY, role: 'assistant' });

    const now = loadDeskNow(local, undefined, NOW);
    assert.equal(now.waiting.length, 1);
    assert.equal(now.waiting[0].id, 'waiting');
    assert.equal(now.waiting[0].state, 'waiting');
    assert.equal(now.waiting[0].next, 'Pick camelCase');
    assert.equal(now.waiting[0].source?.app, 'Michi');
    assert.equal(now.stalled.length, 1);
    assert.equal(now.stalled[0].id, 'stalled');
    assert.equal(now.stalled[0].idleDays, 4);
    assert.equal(now.done.length, 0);
    assert.match(now.summary ?? '', /1 waiting on you/);
    assert.match(now.summary ?? '', /1 line stalled for 4 days/);
    assert.equal(loadDeskThreads(local, NOW).some((item) => item.id === 'blank' && item.state === 'idea'), true);
    assert.equal(now.waiting.some((item) => item.id === 'old'), false);
    assert.equal(now.stalled.some((item) => item.id === 'old'), false);
  });

  test('a running turn stays in progress and a user-marked thread is done until it moves', () => {
    thread('live', { at: NOW - 10 * DAY, role: 'assistant', status: 'streaming' });
    thread('confirmed', { at: NOW - 2 * 60 * 60 * 1000, role: 'assistant', content: 'Merged' });
    const write = mutateDeskThreads(local, 'done', ['confirmed'], NOW);
    assert.ok(write);

    const now = loadDeskNow(local, undefined, NOW);
    assert.equal(now.done.length, 1);
    assert.equal(now.done[0].doneBy, 'user');
    assert.equal(now.waiting.length, 0);
    const threads = loadDeskThreads(local, NOW);
    assert.equal(threads.find((item) => item.id === 'live')?.state, 'doing');
  });

  test('archive hides a thread, undo puts it back, and a newer message returns it', () => {
    thread('line', { at: NOW - DAY, role: 'assistant', content: 'Waiting on the fixture path' });
    const archived = mutateDeskThreads(local, 'archive', ['line'], NOW);
    assert.ok(archived);
    assert.equal(loadDeskNow(local, undefined, NOW).waiting.length, 0);
    assert.equal(loadDeskNow(local, undefined, NOW).archivedCount, 1);

    assert.equal(undoDeskReceipt(local, archived.receipt.id, NOW + 1), true);
    assert.equal(loadDeskNow(local, undefined, NOW).waiting.length, 1);
    assert.equal(undoDeskReceipt(local, archived.receipt.id, NOW + 2), false);

    const again = mutateDeskThreads(local, 'archive', ['line'], NOW + 10);
    assert.ok(again);
    seedMessage('line-new', 'line-root', 'assistant', 'New reply', NOW + DAY, 2);
    const returned = loadDeskNow(local, undefined, NOW + DAY);
    assert.equal(returned.waiting.length, 1);
    assert.equal(returned.waiting[0].returned, true);
  });

  test('ignore hides a thread from the desk until it is undone', () => {
    thread('noise', { at: NOW - 60 * 1000, role: 'assistant' });
    const ignored = mutateDeskThreads(local, 'ignore', ['noise'], NOW);
    assert.ok(ignored);
    assert.equal(loadDeskThreads(local, NOW).some((item) => item.id === 'noise'), false);
    assert.equal(loadDeskPeek(local, 'noise', NOW), null);
    undoDeskReceipt(local, ignored.receipt.id, NOW + 1);
    assert.equal(loadDeskPeek(local, 'noise', NOW)?.thread.id, 'noise');
  });

  test('a Michi-archived thread stays in the archived count', () => {
    thread('boxed', { at: NOW - 60 * 60 * 1000, role: 'assistant', archivedAt: NOW - 30 * 60 * 1000 });
    const now = loadDeskNow(local, undefined, NOW);
    assert.equal(now.waiting.length, 0);
    assert.equal(now.archivedCount, 1);
    assert.equal(loadDeskThreads(local, NOW)[0].michiArchived, true);
  });

  test('projects count only the threads waiting inside the window', () => {
    thread('fresh', { at: NOW - 60 * 1000, role: 'assistant', workspace: 'alpha', owner: 'user-a' });
    thread('quiet', { at: NOW - 5 * DAY, role: 'assistant', workspace: 'beta', owner: 'user-a' });
    const projects = loadDeskProjects(local, NOW);
    assert.deepEqual(projects.map((project) => [project.id, project.dot, project.waitingCount]), [
      ['alpha', 'waiting', 1],
      ['beta', 'stalled', 0],
    ]);
  });

  test('search matches an earlier message and stays inside the caller workspace', () => {
    thread('topic', { at: NOW - 60 * 1000, role: 'assistant', content: 'latest' });
    seedMessage('topic-old', 'topic-root', 'user', 'rename the fixture path', NOW - DAY, 0);
    process.env.MICHI_CLOUD = '1';
    thread('secret', { at: NOW - 60 * 1000, role: 'assistant', content: 'fixture path for someone else', workspace: 'other', owner: 'user-b' });

    const mine = searchDeskThreads({ ownerKey: 'user-a', userId: 'user-a' }, 'fixture', NOW);
    assert.deepEqual(mine.map((item) => item.id), ['topic']);
    assert.throws(() => searchDeskThreads({ ownerKey: 'local' }, 'fixture', NOW), DeskAuthError);
  });

  test('nine waiting threads report one more past the section limit', () => {
    for (let i = 0; i < 9; i += 1) {
      thread(`w${i}`, { at: NOW - i * 60 * 1000, role: 'assistant' });
    }
    const now = loadDeskNow(local, undefined, NOW);
    assert.equal(now.waiting.length, 8);
    assert.equal(now.more.waiting, 1);
    assert.equal(now.waiting[0].id, 'w0');
  });

  test('an unknown id is not archived', () => {
    thread('real', { at: NOW, role: 'assistant' });
    assert.equal(mutateDeskThreads(local, 'archive', ['real', 'missing'], NOW), null);
    assert.equal(loadDeskNow(local, undefined, NOW).waiting.length, 1);
  });
});
