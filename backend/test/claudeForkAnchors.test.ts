import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { saveClaudeForkAnchor, readClaudeForkAnchor } from '../src/services/claudeForkAnchors';

let directory: string;
const originalEnv = { ...process.env };
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-claude-anchors-'));
  process.env.MICHI_DATA_DIR = directory;
  delete process.env.MICHI_CLOUD;
  closeDb(); initDb();
  getDb().exec(`INSERT INTO workspaces (id,name,cwd,created_at,updated_at) VALUES ('ws','Test','/tmp',1,1);
    INSERT INTO nodes (id,workspace_id,kind,status,runtime_id,external_session_id,created_at)
      VALUES ('parent','ws','chat','idle','claude','native-parent',1);
    INSERT INTO messages (id,node_id,role,content,seq,created_at) VALUES
      ('user-1','parent','user','prompt',1,1), ('assistant-1','parent','assistant','reply',2,1);`);
});
afterEach(() => {
  closeDb(); process.env = { ...originalEnv };
  fs.rmSync(directory, { recursive: true, force: true });
});

const saveInput = { nodeId: 'parent', nativeSessionId: 'native-parent', assistantMessageId: 'assistant-1',
  nativeMessageId: 'native-assistant', userMessageId: 'user-1' };
const readInput = { nodeId: 'parent', nativeSessionId: 'native-parent', messageId: 'assistant-1', workspaceId: 'ws' };

test('retains an assistant boundary across database reopening without exposing public metadata', () => {
  saveClaudeForkAnchor(saveInput);
  closeDb(); initDb();
  assert.equal(readClaudeForkAnchor(readInput), 'native-assistant');
  assert.equal(getDb().prepare("SELECT metadata FROM messages WHERE id='assistant-1'").get()?.metadata, null);
  assert.equal(readClaudeForkAnchor({ ...readInput, messageId: 'user-1' }), null,
    'a user cut must not inherit the later assistant answer');
});

test('user UUIDs receive their own position and cannot be forged by swapping roles', () => {
  saveClaudeForkAnchor({ ...saveInput, nativeUserMessageId: 'native-user' });
  assert.equal(readClaudeForkAnchor({ ...readInput, messageId: 'user-1' }), 'native-user');
  saveClaudeForkAnchor({ ...saveInput, assistantMessageId: 'user-1', userMessageId: undefined, nativeMessageId: 'wrong-role' });
  assert.equal(readClaudeForkAnchor({ ...readInput, messageId: 'user-1' }), 'native-user');
});

test('changed runtime bindings and other workspaces cannot reuse a retained native anchor', () => {
  saveClaudeForkAnchor(saveInput);
  assert.equal(readClaudeForkAnchor({ ...readInput, workspaceId: 'different' }), null);
  assert.equal(readClaudeForkAnchor({ ...readInput, nodeId: 'different' }), null);
  assert.equal(readClaudeForkAnchor({ ...readInput, nativeSessionId: 'different' }), null);
  getDb().prepare("UPDATE nodes SET external_session_id='new-native' WHERE id='parent'").run();
  assert.equal(readClaudeForkAnchor(readInput), null);
  saveClaudeForkAnchor({ ...saveInput, nativeMessageId: 'stale-overwrite' });
  assert.equal(getDb().prepare('SELECT native_message_id FROM claude_fork_anchors').get()?.native_message_id, 'native-assistant');
});

test('owner isolation, archived workspaces and removed messages invalidate lookup', () => {
  process.env.MICHI_CLOUD = '1';
  getDb().exec("UPDATE workspaces SET owner_user_id='alice' WHERE id='ws'");
  saveClaudeForkAnchor(saveInput);
  assert.equal(readClaudeForkAnchor({ ...readInput, ownerUserId: 'bob' }), null);
  assert.equal(readClaudeForkAnchor({ ...readInput, ownerUserId: 'alice' }), 'native-assistant');
  getDb().exec("UPDATE workspaces SET archived_at=1 WHERE id='ws'");
  assert.equal(readClaudeForkAnchor({ ...readInput, ownerUserId: 'alice' }), null);
  getDb().exec("UPDATE workspaces SET archived_at=NULL WHERE id='ws'; DELETE FROM messages WHERE id='assistant-1'");
  assert.equal(readClaudeForkAnchor({ ...readInput, ownerUserId: 'alice' }), null);
});

test('node deletion cascades retained runtime positions', () => {
  saveClaudeForkAnchor(saveInput);
  getDb().exec("DELETE FROM nodes WHERE id='parent'");
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM claude_fork_anchors').get()?.count, 0);
});

test('changing a public message role cannot reinterpret an assistant anchor as a user cut', () => {
  saveClaudeForkAnchor(saveInput);
  getDb().exec("UPDATE messages SET role='user' WHERE id='assistant-1'");
  assert.equal(readClaudeForkAnchor(readInput), null);
});
