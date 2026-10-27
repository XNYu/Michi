import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { applyTurnEvent, createDurableTurn, type ChatStreamEvent, type DurableTurnSnapshot } from 'michi-shared';
import { closeDb, getDb, getDbPath, initDb } from '../src/services/db';
import { beginTurn, finalizeTurn, moveTreeToWorkspace } from '../src/services/dbRepository';
import { dbWorker, initDbWorker, shutdownDbWorker } from '../src/services/dbWorkerClient';
import { conversationCompletionCounter, readConversationUpdates } from '../src/services/conversationUpdates';
import { setupConversationUpdatesRoutes } from '../src/routes/conversationUpdates';
import { readConversationUpdatesTool } from '../src/agents/conversationUpdatesTool';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { McpSlotRegistry, buildMcpServerForSlot } from '../src/services/mcpServer';
import { buildPiTools } from '../src/agents/pi/piTools';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { chatOwner } from './helpers/owners';

const caller = { workspaceId: 'ws', ownerUserId: LOCAL_AGENT_OWNER_ID, backendConnectionId: 'local' };
const ev = (event: ChatStreamEvent['event'], data: Record<string, unknown>) => ({ event, data }) as ChatStreamEvent;

function seed(workspaceId: string, nodeId = workspaceId): void {
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO workspaces(id,name,created_at,updated_at,owner_user_id) VALUES (?,?,1,1,?)').run(workspaceId, workspaceId, 'alice');
  db.prepare('INSERT INTO trees(id,workspace_id,root_node_id,last_active_at,created_at) VALUES (?,?,?,1,1)').run(`tree-${nodeId}`, workspaceId, nodeId);
  db.prepare("INSERT INTO nodes(id,workspace_id,tree_id,kind,status,created_at) VALUES (?,?,?,'chat','idle',1)").run(nodeId, workspaceId, `tree-${nodeId}`);
}

function start(id: string, overrides: Partial<Parameters<typeof createDurableTurn>[0]> = {}): DurableTurnSnapshot {
  const turn = createDurableTurn({ turnId: id, assistantId: `a-${id}`, nodeId: 'ws', workspaceId: 'ws', displayUserText: `input ${id}`, startedAt: 10, ...overrides });
  beginTurn(turn);
  return turn;
}

function done(turn: DurableTurnSnapshot, text = 'answer', completedAt = 100): DurableTurnSnapshot {
  const answer = applyTurnEvent(turn, ev('chunk', { seq: turn.lastAppliedSeq + 1, text }));
  return applyTurnEvent(answer, ev('done', { seq: answer.lastAppliedSeq + 1, stopReason: 'end_turn', completedAt }));
}

describe('conversation completion increments', () => {
  let dir: string;
  let oldCloud: string | undefined;
  let oldData: string | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-increments-'));
    oldCloud = process.env.MICHI_CLOUD;
    oldData = process.env.MICHI_DATA_DIR;
    delete process.env.MICHI_CLOUD;
    process.env.MICHI_DATA_DIR = dir;
    closeDb(); initDb(); seed('ws');
  });
  afterEach(async () => {
    __resetRuntimeDeps();
    await shutdownDbWorker();
    closeDb();
    if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
    if (oldData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldData;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('allocates once in commit order independently per workspace; excludes self/error/cancel and survives restart', () => {
    const first = start('first');
    const second = start('second');
    finalizeTurn(done(second, 'second', 200));
    finalizeTurn(done(first, 'first', 1));
    finalizeTurn(done(first, 'first', 1));
    finalizeTurn(done(start('self', { selfInitiated: true, keepUserMessage: false })));
    finalizeTurn(done(start('scheduled', { selfInitiated: true, keepUserMessage: true, userMetadata: { scheduledJobId: 'job' } })));
    const scheduled = start('scheduled-metadata-rewrite', { selfInitiated: true, keepUserMessage: true, userMetadata: { scheduledJobId: 'job' } });
    getDb().prepare('UPDATE messages SET metadata = ? WHERE id = ?').run('{"quotedText":"renderer rewrite"}', scheduled.userMessage!.id);
    finalizeTurn(done(scheduled));
    const cancelled = start('cancel');
    finalizeTurn({ ...cancelled, status: 'cancelled' });
    finalizeTurn({ ...start('error'), status: 'error', error: 'failure' });
    seed('other');
    finalizeTurn(done(start('other', { workspaceId: 'other', nodeId: 'other' })));
    assert.equal(conversationCompletionCounter('ws'), 2);
    assert.equal(conversationCompletionCounter('other'), 1);
    assert.deepEqual(readConversationUpdates(caller, { after: 0 }).turns.map(t => [t.turnId, t.completionSeq]), [['second', 1], ['first', 2]]);
    closeDb(); initDb();
    assert.equal(readConversationUpdates(caller, { after: 2 }).nextAfter, 2);
  });

  test('rolls back messages, counter and turn together on a failed final update', () => {
    const turn = done(start('rollback'), 'final');
    getDb().exec("CREATE TRIGGER fail_finalize BEFORE UPDATE ON turns WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'test rollback'); END");
    assert.throws(() => finalizeTurn(turn), /test rollback/);
    assert.equal(conversationCompletionCounter('ws'), 0);
    assert.equal((getDb().prepare('SELECT content FROM messages WHERE id = ?').get('a-rollback') as { content: string }).content, '');
    getDb().exec('DROP TRIGGER fail_finalize');
    finalizeTurn(turn);
    assert.equal(conversationCompletionCounter('ws'), 1);
  });

  test('upgrade leaves existing turns and jobs outside the new consumer state', () => {
    finalizeTurn(done(start('pre-upgrade')));
    // Recreate the schema immediately before 0033 in this disposable database.
    getDb().exec(`DROP INDEX idx_turns_node_completion;
      ALTER TABLE turns DROP COLUMN completion_seq;
      ALTER TABLE scheduled_jobs DROP COLUMN conversation_cursor;
      DELETE FROM meta WHERE key LIKE 'conversation_completion_seq:%';
      DELETE FROM schema_migrations WHERE version = '0033_conversation_completion_seq';`);
    getDb().prepare(`INSERT INTO scheduled_jobs(id,workspace_id,name,prompt,schedule,created_at,updated_at)
      VALUES ('old-job','ws','Old','Prompt','{"kind":"every","everySeconds":3600}',1,1)`).run();
    closeDb(); initDb();
    assert.equal((getDb().prepare('SELECT completion_seq FROM turns WHERE turn_id = ?').get('pre-upgrade') as any).completion_seq, null);
    assert.equal((getDb().prepare('SELECT conversation_cursor FROM scheduled_jobs WHERE id = ?').get('old-job') as any).conversation_cursor, null);
    assert.equal(readConversationUpdates(caller, { after: 0 }).totalTurns, 0);
    finalizeTurn(done(start('post-upgrade')));
    assert.equal(readConversationUpdates(caller, { after: 0 }).turns[0].turnId, 'post-upgrade');
  });

  test('worker and main thread share transactional allocation and repeated finalization', async () => {
    const a = done(start('worker-a'));
    const b = done(start('worker-b'));
    const c = done(start('main'));
    await initDbWorker(getDbPath());
    const pending = Promise.all([dbWorker.finalizeTurn(a), dbWorker.finalizeTurn(b)]);
    finalizeTurn(c);
    await pending;
    await dbWorker.finalizeTurn(a);
    const page = readConversationUpdates(caller, { after: 0 });
    assert.deepEqual(page.turns.map(t => t.completionSeq), [1, 2, 3]);
    assert.equal(new Set(page.turns.map(t => t.turnId)).size, 3);
  });

  test('fixed upper bound, actual counts, archive/trash gaps, empty tail and future cursors', () => {
    finalizeTurn(done(start('one')));
    seed('ws', 'archived');
    finalizeTurn(done(start('two', { nodeId: 'archived' })));
    getDb().prepare("UPDATE nodes SET status = 'archived' WHERE id = 'archived'").run();
    finalizeTurn(done(start('three')));
    const first = readConversationUpdates(caller, { after: 0, limit: 1 });
    assert.equal(first.totalTurns, 2);
    assert.equal(first.through, 3);
    assert.deepEqual(first.byNode, [{ nodeId: 'ws', treeId: 'tree-ws', newTurnCount: 2 }]);
    finalizeTurn(done(start('four')));
    const last = readConversationUpdates(caller, { after: first.nextAfter, through: first.through, limit: 1 });
    assert.deepEqual(last.turns.map(t => t.turnId), ['three']);
    assert.equal(last.nextAfter, 3);
    assert.equal(last.hasMore, false);
    getDb().prepare("UPDATE nodes SET deleted_at = 1, deletion_group_id = 'arch-test' WHERE id = 'ws'").run();
    const empty = readConversationUpdates(caller, { after: 3 });
    assert.equal(empty.totalTurns, 0);
    assert.equal(empty.nextAfter, 4);
    for (const input of [{ after: 5 }, { after: 2, through: 1 }, { after: 0, through: 5 }]) {
      assert.throws(() => readConversationUpdates(caller, input), (e: any) => e.code === 'cursor_invalid');
    }
  });

  test('current owner and navigation gate apply even to empty reads and bound tools', () => {
    finalizeTurn(done(start('private')));
    process.env.MICHI_CLOUD = '1';
    assert.throws(() => readConversationUpdates({ ...caller, ownerUserId: 'bob' }, { after: 0 }), (e: any) => e.code === 'not_found');
    assert.throws(() => readConversationUpdates({ ...caller, ownerUserId: '' }, { after: 0 }), (e: any) => e.code === 'not_found');
    assert.equal(readConversationUpdates({ ...caller, ownerUserId: 'alice' }, { after: 0 }).totalTurns, 1);
    getDb().prepare('UPDATE workspaces SET settings = ? WHERE id = ?').run('{"aiGlobalContext":false}', 'ws');
    assert.throws(() => readConversationUpdates({ ...caller, ownerUserId: 'alice' }, { after: 1 }), (e: any) => e.code === 'navigation_disabled');
    const result = readConversationUpdatesTool({ workspaceId: 'ws', ownerUserId: 'alice', backendConnectionId: 'local' }, { after: 0 });
    assert.equal(result.isError, true);
  });

  test('includes accepted steering and user metadata, without thoughts, tool results or neighboring turns', () => {
    finalizeTurn(done(start('previous'), 'previous answer'));
    const quoteSource = { type: 'artifact', filePath: '/doc.txt', snapshot: { hashKind: 'sha256-text-utf8', contentHash: 'abc123', backendConnectionId: 'local', projectId: 'ws', treeId: 'tree-ws', resolvedFilePath: '/doc.txt' } };
    let turn = start('steered', { userMetadata: { quotedText: 'quote', quoteSource } });
    turn = applyTurnEvent(turn, ev('steer_accepted', { seq: 1, messageId: 'steer', text: 'correction', createdAt: 11 }));
    finalizeTurn(done(turn, 'corrected answer'));
    finalizeTurn(done(start('next'), 'next answer'));
    const page = readConversationUpdates(caller, { after: 1, through: 2, includeMessages: true });
    assert.deepEqual(page.turns[0].messages?.map(m => m.id), ['u-a-steered', 'steer', 'a-steered']);
    assert.deepEqual(page.turns[0].messages?.map(m => m.content), ['input steered', 'correction', 'corrected answer']);
    assert.deepEqual(page.turns[0].messages?.[0].metadata, { quotedText: 'quote', quoteSource });
  });

  test('MCP and Pi registrations return the same bound increment without accepting a workspace override', async () => {
    finalizeTurn(done(start('bound')));
    seed('other');
    finalizeTurn(done(start('other-bound', { workspaceId: 'other', nodeId: 'other' })));
    const registry = new McpSlotRegistry();
    const slot = registry.create('session', dir, null, {
      owner: chatOwner('ws'),
      onSpawnBranches: async () => [], onSaveArtifact: () => null, onUpdateArtifact: () => null,
      onShowImage: () => ({ error: 'not supported' }),
    }, { workspaceId: 'ws', nodeId: 'ws' });
    const server = buildMcpServerForSlot(slot);
    const tools = (server as any)._registeredTools;
    const mcp = await tools.read_conversation_updates.handler({ after: 0, workspaceId: 'other' });
    configureRuntimeDeps({ dataDir: dir,
      historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null,
        getWorkspaceInstructions: () => null, hasGrant: () => false, grantPermission: () => {} },
      agentConfig: { getAgentConfig: () => ({ runtime: 'pi', provider: '', modelByRuntime: {}, reasoningByRuntime: {} }),
        resolveModel: () => '', resolveReasoning: () => undefined },
    });
    const Type = new Proxy({}, { get: () => () => ({}) });
    const pi = buildPiTools({ bridge: {} as any, cwd: dir, parentChatId: 'session', workspaceId: 'ws',
      owner: chatOwner('ws'), enableFollowUps: false, imageQuota: { usedBytes: 0, limitBytes: 1 } as any,
      seenPaths: new Set(), Type }).find(t => t.name === 'read_conversation_updates');
    const result = await pi.execute('read', { after: 0, workspaceId: 'other' });
    assert.deepEqual(JSON.parse(mcp.content[0].text), JSON.parse(result.content[0].text));
    assert.deepEqual(JSON.parse(result.content[0].text).turns.map((t: any) => t.turnId), ['bound']);
    assert.equal((await tools.report_conversation_no_change.handler({ batchToken: 'none', turnIds: ['bound'], reason: 'none' })).isError, true);
  });

  test('budget advances only over complete turns; giant or missing source blocks progress', () => {
    finalizeTurn(done(start('small'), 'ok'));
    finalizeTurn(done(start('giant', { displayUserText: '界'.repeat(30000) }), 'large input'));
    const page = readConversationUpdates(caller, { after: 0, includeMessages: true });
    assert.deepEqual(page.turns.map(t => t.turnId), ['small']);
    assert.equal(page.nextAfter, 1);
    const blocked = readConversationUpdates(caller, { after: 1, includeMessages: true });
    assert.equal(blocked.turns[0].contentTooLarge, true);
    assert.equal(blocked.turns[0].messages, undefined);
    assert.equal(blocked.nextAfter, 1);
    getDb().prepare('DELETE FROM messages WHERE id = ?').run('u-a-giant');
    assert.equal(readConversationUpdates(caller, { after: 1, includeMessages: true }).turns[0].contentUnavailable, true);
  });

  test('moving a tree clears source sequence only across workspaces', () => {
    finalizeTurn(done(start('moved')));
    moveTreeToWorkspace('tree-ws', 'ws', 'ws');
    assert.equal(readConversationUpdates(caller, { after: 0 }).totalTurns, 1);
    seed('target');
    moveTreeToWorkspace('tree-ws', 'ws', 'target');
    assert.equal(readConversationUpdates(caller, { after: 0 }).totalTurns, 0);
    assert.equal(readConversationUpdates({ ...caller, workspaceId: 'target' }, { after: 0 }).totalTurns, 0);
    finalizeTurn(done(start('new-target', { workspaceId: 'target' })));
    assert.equal(readConversationUpdates({ ...caller, workspaceId: 'target' }, { after: 0 }).turns[0].completionSeq, 1);
  });

  test('HTTP validates query types and uses authenticated ownership', async () => {
    process.env.MICHI_CLOUD = '1';
    const app = express();
    app.use((req, _res, next) => { req.user = { id: 'alice' } as any; next(); });
    app.use('/api', setupConversationUpdatesRoutes());
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/workspaces`;
    try {
      for (const query of ['after=-1', 'after=NaN', 'after=1.2', 'after=0&includeMessages=1', 'after=0&limit=101', 'after=9007199254740992', '']) {
        assert.equal((await fetch(`${base}/ws/conversation-updates?${query}`)).status, 400, query);
      }
      assert.equal((await fetch(`${base}/ws/conversation-updates?after=0`)).status, 200);
      seed('foreign');
      getDb().prepare("UPDATE workspaces SET owner_user_id = 'bob' WHERE id = 'foreign'").run();
      assert.equal((await fetch(`${base}/foreign/conversation-updates?after=0`)).status, 404);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });
});
