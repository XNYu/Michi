import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { applyWorkspaceCommands } from '../src/services/domainCommands';
import { getNode, loadAllWorkspacesMeta, saveNode } from '../src/services/dbRepository';

let dir: string;
let oldData: string | undefined;
let oldCloud: string | undefined;
let op = 0;

beforeEach(() => {
  oldData = process.env.MICHI_DATA_DIR;
  oldCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-node-viewed-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb(); initDb();
  const workspace = getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)');
  workspace.run('ws-a', 'Mine', 'alice');
  workspace.run('ws-b', 'Theirs', 'bob');
  const node = getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,created_at) VALUES (?,?,'chat','idle',1)");
  node.run('n-a', 'ws-a');
  node.run('n-b', 'ws-b');
});

afterEach(() => {
  closeDb();
  if (oldData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldData;
  if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

const view = (workspaceId: string, payload: Record<string, unknown>, ownerUserId: string | null = null) =>
  applyWorkspaceCommands(workspaceId, { operationId: `view-${++op}`, ownerUserId, commands: [{ type: 'node.patch', payload }] });
const viewedAt = (nodeId: string) => getNode(nodeId)?.viewed_at ?? null;

test('a view mark is stored, only moves forward and is held to the present', () => {
  view('ws-a', { id: 'n-a', viewed_at: 2_000 });
  assert.equal(viewedAt('n-a'), 2_000);
  view('ws-a', { id: 'n-a', viewed_at: 1_000 });
  assert.equal(viewedAt('n-a'), 2_000, 'an older mark from another window does not move it back');
  const before = Date.now();
  view('ws-a', { id: 'n-a', viewed_at: before + 10 * 60_000 });
  const stored = viewedAt('n-a')!;
  assert.ok(stored >= before && stored <= Date.now(), `a future mark is held to now, got ${stored}`);
});

test('a view mark for a missing node or another workspace node writes nothing and does not fail the batch', () => {
  assert.doesNotThrow(() => view('ws-a', { id: 'n-gone', viewed_at: 5 }));
  view('ws-a', { id: 'n-b', viewed_at: 5 });
  assert.equal(viewedAt('n-b'), null);
  assert.throws(() => view('ws-a', { id: 'n-a', viewed_at: 'soon' }), /viewed_at/);
  assert.throws(() => view('ws-a', { id: 'n-a', viewed_at: -1 }), /viewed_at/);
});

test('in the cloud a view mark needs the workspace owner', () => {
  process.env.MICHI_CLOUD = '1';
  assert.throws(() => view('ws-b', { id: 'n-b', viewed_at: 5 }, 'alice'), /not found/);
  assert.equal(viewedAt('n-b'), null);
  view('ws-a', { id: 'n-a', viewed_at: 5 }, 'alice');
  assert.equal(viewedAt('n-a'), 5);
});

test('graph writes keep the mark, a full patch can carry it, and hydration returns it', () => {
  view('ws-a', { id: 'n-a', viewed_at: 7 });
  saveNode({ id: 'n-a', workspace_id: 'ws-a', kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0,
    title: 'Renamed', created_at: 1, viewed_at: null });
  applyWorkspaceCommands('ws-a', { operationId: 'graph', commands: [
    { type: 'node.upsert', payload: { id: 'n-a', workspace_id: 'ws-a', kind: 'chat', created_at: 1 } },
    { type: 'node.patch', payload: { id: 'n-a', title: 'Again' } },
  ] });
  assert.equal(viewedAt('n-a'), 7);
  view('ws-a', { id: 'n-a', title: 'With a view', viewed_at: 9 });
  assert.deepEqual([getNode('n-a')?.title, viewedAt('n-a')], ['With a view', 9]);
  const hydrated = loadAllWorkspacesMeta().flatMap((workspace) => workspace.nodes);
  assert.deepEqual(hydrated.filter((node) => node.id === 'n-a').map((node) => node.viewed_at), [9]);
});
