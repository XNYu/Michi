import { afterEach, beforeEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { ClaudeRuntime } from 'michi-runtime/internal/adapters/claude/ClaudeRuntime';
import { saveClaudeForkAnchor } from '../src/services/claudeForkAnchors';
import { NativeResumeUnavailableError } from '../src/services/nativeResume';
import type { ForkAgentSessionOptions } from '../src/agents/types';
import { claudeTestOptions } from './helpers/claudeTestOptions';
import { chatOwner, runOwner } from './helpers/owners';

let directory: string;
let runtime: ClaudeRuntime;
let forks: unknown[];
let loads: any[];
let opts: ForkAgentSessionOptions;
const originalEnv = { ...process.env };

beforeEach((context) => {
  const t = context as TestContext;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-claude-runtime-fork-'));
  process.env.MICHI_DATA_DIR = directory;
  delete process.env.MICHI_CLOUD;
  closeDb(); initDb();
  getDb().exec(`INSERT INTO workspaces (id,name,cwd,created_at,updated_at) VALUES ('ws','Test','/tmp',1,1);
    INSERT INTO nodes (id,workspace_id,kind,status,runtime_id,external_session_id,created_at)
      VALUES ('parent','ws','chat','idle','claude','parent-native',1);
    INSERT INTO nodes (id,workspace_id,parent_node_id,kind,status,created_at)
      VALUES ('child','ws','parent','chat','idle',2);
    INSERT INTO messages (id,node_id,role,content,seq,created_at) VALUES
      ('answer-1','parent','assistant','First answer',1,1),
      ('answer-2','parent','assistant','Later answer',2,2);`);
  getDb().prepare("UPDATE workspaces SET cwd=? WHERE id='ws'").run(directory);
  saveClaudeForkAnchor({ nodeId: 'parent', nativeSessionId: 'parent-native', assistantMessageId: 'answer-1', nativeMessageId: 'first-native' });
  forks = []; loads = [];
  t.mock.method(require('michi-runtime/internal/adapters/claude/claudeSdkHistory'), 'forkClaudeHistory', async (_options: unknown, input: unknown) => {
    forks.push(input); return 'fork-native';
  });
  // Exercise Runtime's orchestration without starting a CLI or its warm pool.
  runtime = Object.create(ClaudeRuntime.prototype);
  const options = claudeTestOptions();
  Object.assign(runtime, { host: options.host, options, backgroundTurns: options.host.backgroundTurns, manager: {
    waitForRelease: async () => {},
    getCompatible: () => undefined,
    loadSession: async (input: unknown) => {
      loads.push(input);
      return { id: 'child', nativeSessionId: 'fork-native', setEnableFollowUps() {} };
    },
  } });
  opts = { sessionId: 'child', owner: chatOwner('child'),
    parentChatId: 'parent', workspaceId: 'ws', cwd: directory,
    sourceNativeSessionId: 'parent-native', anchorMessageId: 'answer-1',
    mergeContexts: ['Explicitly attached reference'],
    branchContext: { parentNodeId: 'parent', kind: 'exact', boundaryMessageId: 'answer-1',
      messages: [{ role: 'assistant', content: 'First answer' }] } };
});

afterEach(() => {
  closeDb(); process.env = { ...originalEnv };
  fs.rmSync(directory, { recursive: true, force: true });
});

test('historical fork resolves the server anchor and resumes the child with its own context', async () => {
  const child = await runtime.forkSession(opts);
  assert.equal(child.nativeSessionId, 'fork-native');
  assert.deepEqual(forks, [{ cwd: directory, sourceNativeSessionId: 'parent-native', nativeMessageId: 'first-native', ownerUserId: undefined }]);
  assert.equal(loads.length, 1);
  assert.equal(loads[0].id, 'child');
  assert.equal(loads[0].externalSessionId, 'fork-native');
  assert.equal(loads[0].parentChatId, 'parent');
  assert.equal(loads[0].workspaceId, 'ws');
  assert.match(loads[0].bootstrapInstructions, /Explicitly attached reference/);
  assert.doesNotMatch(loads[0].bootstrapInstructions, /First answer|Later answer|Inherited branch transcript/,
    'native copied history must not also be injected as a textual ancestor');
});

test('unknown historical anchor fails explicitly without forking latest or creating a child', async () => {
  await assert.rejects(runtime.forkSession({ ...opts, anchorMessageId: 'missing' }), NativeResumeUnavailableError);
  assert.equal(forks.length, 0);
  assert.equal(loads.length, 0);
});

test('a retained anchor cannot be used across workspace or owner boundaries', async () => {
  await assert.rejects(runtime.forkSession({ ...opts, workspaceId: 'other' }), NativeResumeUnavailableError);
  await assert.rejects(runtime.forkSession({ ...opts, ownerUserId: 'other-owner' }), NativeResumeUnavailableError);
  assert.equal(forks.length, 0);
});

test('Run owners cannot inherit chat native history', async () => {
  await assert.rejects(runtime.forkSession({ ...opts, owner: runOwner('run', 'attempt') }), NativeResumeUnavailableError);
  assert.equal(forks.length, 0);
});

test('a mismatched parent native binding cannot fork another transcript', async () => {
  await assert.rejects(runtime.forkSession({ ...opts, anchorMessageId: undefined,
    sourceNativeSessionId: 'other-native' }), NativeResumeUnavailableError);
  assert.equal(forks.length, 0);
});

test('a child cannot use a different persisted parent or cwd', async () => {
  await assert.rejects(runtime.forkSession({ ...opts, parentChatId: 'missing' }), NativeResumeUnavailableError);
  await assert.rejects(runtime.forkSession({ ...opts, cwd: '/other-project' }), NativeResumeUnavailableError);
  assert.equal(forks.length, 0);
});

test('cloud native fork declines before history writes or child resume so exact text fallback remains available', async () => {
  process.env.MICHI_CLOUD = '1';
  getDb().prepare("UPDATE workspaces SET owner_user_id='alice' WHERE id='ws'").run();
  for (const anchorMessageId of ['answer-1', undefined]) {
    await assert.rejects(runtime.forkSession({ ...opts, ownerUserId: 'alice', anchorMessageId }),
      (error: unknown) => error instanceof NativeResumeUnavailableError && /cloud native fork/.test(error.message));
  }
  assert.equal(forks.length, 0);
  assert.equal(loads.length, 0);
  assert.equal(getDb().prepare("SELECT external_session_id FROM nodes WHERE id='child'").get()?.external_session_id, null);
});
