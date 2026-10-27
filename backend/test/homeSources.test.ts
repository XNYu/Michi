import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { closeDb, getDb, initDb } from '../src/services/db';
import { setupSpacesHomeRoutes } from '../src/routes/spacesHome';
import { SOURCE_TEXT_MAX, homeSource } from '../src/services/pages/homeSources';

let dataDir: string;
let server: Server | undefined;
let previousDataDir: string | undefined;
let previousCloud: string | undefined;
let baseUrl = '';
const owner = LOCAL_AGENT_OWNER_ID;

beforeEach(async () => {
  previousDataDir = process.env.MICHI_DATA_DIR;
  previousCloud = process.env.MICHI_CLOUD;
  process.env.MICHI_CLOUD = '1';
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-home-sources-'));
  process.env.MICHI_DATA_DIR = dataDir;
  closeDb();
  initDb();
  const db = getDb();
  const workspace = db.prepare('INSERT INTO workspaces(id,name,owner_user_id,settings,archived_at,deleted_at,created_at,updated_at) VALUES (?,?,?,?,?,?,1,1)');
  workspace.run('ws-a', 'rabbitholes', owner, null, null, null);
  workspace.run('ws-old', 'old', owner, null, 5, null);
  workspace.run('ws-bob', 'bob', 'bob', null, null, null);
  workspace.run('ws-sys', 'assistant', owner, JSON.stringify({ system: 'assistant' }), null, null);
  const node = db.prepare("INSERT INTO nodes(id,workspace_id,kind,title,status,runtime_id,external_session_id,deleted_at,created_at) VALUES (?,?,'chat',?,'idle',?,?,?,?)");
  node.run('n-a', 'ws-a', '排查公证失败', 'claude', 'native-a', null, 10);
  node.run('n-trash', 'ws-a', 'Trashed', 'kiro', 'native-t', 7, 11);
  node.run('n-old', 'ws-old', 'Archived', 'codex', null, null, 12);
  node.run('n-bob', 'ws-bob', 'Bob', 'claude', 'native-b', null, 13);
  node.run('n-sys', 'ws-sys', 'Assistant', 'claude', 'native-s', null, 14);
  const message = db.prepare('INSERT INTO messages(id,node_id,role,content,seq,created_at) VALUES (?,?,?,?,?,?)');
  message.run('m1', 'n-a', 'user', 'notarytool keeps saying Invalid', 1, 100);
  message.run('m2', 'n-a', 'assistant', '  Notarized (Accepted).  ', 2, 200);
  message.run('m-long', 'n-a', 'assistant', 'x'.repeat(SOURCE_TEXT_MAX + 50), 3, 300);
  db.prepare("INSERT INTO turns(turn_id,node_id,user_message_id,assistant_message_id,status,started_at,updated_at) VALUES ('t2','n-a','m1','m2','completed',1,1)").run();
  db.prepare("INSERT INTO claude_fork_anchors(node_id,native_session_id,message_id,message_role,native_message_id) VALUES ('n-a','native-a','m2','assistant','uuid-m2')").run();
  const app = express();
  app.use((req, _res, next) => { (req as any).user = { id: req.header('x-user-id') ?? owner }; next(); });
  app.use('/api', setupSpacesHomeRoutes());
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
  closeDb();
  if (previousDataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = previousDataDir;
  if (previousCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = previousCloud;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a Michi message reads with its conversation, workspace, runtime, turn and trimmed text', () => {
  assert.deepEqual(homeSource({ ownerUserId: owner, nodeId: 'n-a', messageId: 'm2' }), {
    nodeId: 'n-a', workspaceId: 'ws-a', workspaceName: 'rabbitholes', title: '排查公证失败', runtimeId: 'claude', state: 'live',
    message: { id: 'm2', role: 'assistant', text: 'Notarized (Accepted).', truncated: false, turnId: 't2', at: 200 },
  });
  const long = homeSource({ ownerUserId: owner, nodeId: 'n-a', messageId: 'm-long' }).message!;
  assert.equal(long.text.length, SOURCE_TEXT_MAX);
  assert.equal(long.truncated, true);
  assert.equal(homeSource({ ownerUserId: owner, nodeId: 'n-a' }).message, null);
  assert.equal(homeSource({ ownerUserId: owner, nodeId: 'n-a', messageId: 'missing' }).message, null);
});

test('trashed and archived conversations say so; other owners and bad queries are refused', async () => {
  assert.equal(homeSource({ ownerUserId: owner, nodeId: 'n-trash' }).state, 'deleted');
  assert.equal(homeSource({ ownerUserId: owner, nodeId: 'n-old' }).state, 'archived');
  getDb().prepare("INSERT INTO trees(id,workspace_id,root_node_id,archived_at,last_active_at,created_at) VALUES ('tr','ws-a','n-a',9,1,1)").run();
  getDb().prepare("UPDATE nodes SET tree_id='tr' WHERE id='n-a'").run();
  assert.equal(homeSource({ ownerUserId: owner, nodeId: 'n-a' }).state, 'archived');

  const ok = await fetch(`${baseUrl}/spaces-home/source?nodeId=n-a&messageId=m2`);
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { message: { id: string } }).message.id, 'm2');
  assert.equal((await fetch(`${baseUrl}/spaces-home/source?nodeId=n-bob`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/spaces-home/source?nodeId=n-bob`, { headers: { 'x-user-id': 'bob' } })).status, 200);
  assert.equal((await fetch(`${baseUrl}/spaces-home/source?nodeId=n-a&sessionId=claude:native-a`)).status, 400);
  assert.equal((await fetch(`${baseUrl}/spaces-home/source`)).status, 400);
  assert.equal((await fetch(`${baseUrl}/spaces-home/source?nodeId=n-a&extra=1`)).status, 400);
});
