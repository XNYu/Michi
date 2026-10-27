import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROGRESS_CARD_TTL_MS } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { PageWriteError } from '../src/services/pages/core';
import { createPage } from '../src/services/pages/repository';
import { getSpacesHome } from '../src/services/pages/homePages';
import {
  chatHubLiveTurn, configureProgressCardLiveTurns, createProgressCard, dismissProgressCard, listHomeProgressCards, listPageProgressCards,
  markProgressCardSeen, type ProgressCardLiveTurn,
} from '../src/services/pages/progressCards';

let dir: string;
let oldData: string | undefined;
let oldCloud: string | undefined;

beforeEach(() => {
  oldData = process.env.MICHI_DATA_DIR;
  oldCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-progress-cards-'));
  process.env.MICHI_DATA_DIR = dir;
  process.env.MICHI_CLOUD = '1';
  closeDb(); initDb();
  const insert = getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)');
  insert.run('ws', 'rabbitholes', 'alice');
  insert.run('ws-2', 'sample-notes', 'alice');
  insert.run('ws-b', 'Bob', 'bob');
});

afterEach(() => {
  closeDb();
  if (oldData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldData;
  if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

const status = (code: number) => (error: unknown) => error instanceof PageWriteError && error.status === code;
const HOUR = 60 * 60 * 1000;

function thread(id: string, workspaceId = 'ws', title = 'Run the rollback tests'): string {
  getDb().prepare("INSERT INTO nodes(id,workspace_id,tree_id,kind,title,status,runtime_id) VALUES (?,?,NULL,'chat',?,'idle','claude')").run(id, workspaceId, title);
  return id;
}
function turn(nodeId: string, turnId: string, state: string, startedAt: number): void {
  getDb().prepare('INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(turnId, nodeId, `${turnId}-a`, state, startedAt, startedAt);
}
function reply(nodeId: string, seq: number, content: string, blocks: unknown[] | null = null): void {
  getDb().prepare("INSERT INTO messages(id,node_id,role,content,blocks,seq) VALUES (?,?, 'assistant',?,?,?)")
    .run(`${nodeId}-m${seq}`, nodeId, content, blocks ? JSON.stringify(blocks) : null, seq);
}

test('a card reads its status and summary from the thread node every time and keeps no copy', () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Michi 0.9' });
  thread('n1');
  const created = createProgressCard({ ownerUserId: 'alice', threadNodeId: 'n1', startedFromPageId: page.id, now: 100 });
  assert.equal(created.status, 'idle');
  assert.equal(created.workspaceName, 'rabbitholes');
  assert.equal(created.title, 'Run the rollback tests');
  assert.equal(created.runtimeId, 'claude');
  assert.deepEqual(Object.keys(getDb().prepare('SELECT * FROM page_progress_cards').get() as object).sort(),
    ['created_at', 'dismissed_at', 'owner_user_id', 'seen_at', 'started_from_page_id', 'thread_node_id']);

  turn('n1', 't1', 'active', 110);
  reply('n1', 1, 'Reading the code so far');
  const running = listPageProgressCards(page.id, 'alice', 120)[0]!;
  assert.equal(running.status, 'running');
  assert.equal(running.summary, null, 'a running conversation shows no message content');

  getDb().prepare("UPDATE turns SET status='completed' WHERE turn_id='t1'").run();
  reply('n1', 2, `I'll run the rollback tests first.\n\n\`\`\`\nnpm test\n\`\`\`\n\n## Result\n\nAll 14 rollback tests pass.\n   Ran them **twice**.`);
  const done = listHomeProgressCards('alice', 130)[0]!;
  assert.equal(done.status, 'done');
  assert.equal(done.summary, 'All 14 rollback tests pass. Ran them twice.', 'the reply\'s conclusion, not its first working note');

  turn('n1', 't2', 'error', 140);
  assert.equal(listHomeProgressCards('alice', 150)[0]!.status, 'failed');
  reply('n1', 3, 'y'.repeat(500));
  const long = listHomeProgressCards('alice', 150)[0]!.summary!;
  assert.equal(long.length, 240);
  assert.ok(long.endsWith('…'));
});

test('a card previews what the final reply concluded, and a short sign-off keeps the paragraph before it', () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Release' });
  thread('c');
  createProgressCard({ ownerUserId: 'alice', threadNodeId: 'c', startedFromPageId: page.id, now: 10 });
  turn('c', 't1', 'completed', 20);
  // Answer segments around tool calls are stored run together; the blocks keep where each segment ends.
  reply('c', 1, 'I\'ll investigate the test setup.The working directory is empty.I could not run the rollback test: node-pty does not build here.',
    [{ id: 'a1', kind: 'answer', rawText: 'I\'ll investigate the test setup.' }, { id: 't1', kind: 'tool', toolCallId: 'x', section: 'answer', rawOffset: 0 },
      { id: 'a2', kind: 'answer', rawText: 'The working directory is empty.' }, { id: 't2', kind: 'tool', toolCallId: 'y', section: 'answer', rawOffset: 0 },
      { id: 'a3', kind: 'answer', rawText: 'I could not run the rollback test: node-pty does not build here.' }]);
  const card = listHomeProgressCards('alice', 30)[0]!;
  assert.equal(card.status, 'done', 'a reply that says it could not do the task still finished normally');
  assert.equal(card.summary, 'I could not run the rollback test: node-pty does not build here.');
  assert.equal(card.error, null);

  reply('c', 2, 'Checked the three cases.\n\n- Duplicate submit passes\n- Rollback is not covered yet\n\nWant me to go on?');
  assert.equal(listHomeProgressCards('alice', 30)[0]!.summary, 'Duplicate submit passes Rollback is not covered yet Want me to go on?');

  // Michi's metadata sentinels at the end of a reply are not its conclusion.
  reply('c', 3, 'The log file does not exist, so I cannot tell.', [{ id: 'a1', kind: 'answer', rawText: 'The log file does not exist, so I cannot tell.\n\n[BRANCH-OVERVIEW: read the log; it is missing]' }]);
  assert.equal(listHomeProgressCards('alice', 30)[0]!.summary, 'The log file does not exist, so I cannot tell.');

  // The summary the turn ended with wins over the reply's closing offer; one from an earlier turn does not.
  reply('c', 4, '## Not found\n\nI cannot tell whether the test passed.\n\n如果你愿意，我可以搜索整个工作区。');
  getDb().prepare('UPDATE nodes SET branch_overview=? WHERE id=?').run(JSON.stringify([{ at: 5, text: 'Earlier turn' }]), 'c');
  assert.equal(listHomeProgressCards('alice', 30)[0]!.summary, 'I cannot tell whether the test passed. 如果你愿意，我可以搜索整个工作区。');
  getDb().prepare('UPDATE nodes SET branch_overview=? WHERE id=?').run(JSON.stringify([{ at: 5, text: 'Earlier turn' }, { at: 25, text: 'Read the log: it is missing, so no result.' }]), 'c');
  assert.equal(listHomeProgressCards('alice', 30)[0]!.summary, 'Read the log: it is missing, so no result.');
});

test('a failed or stopped conversation says so, and only a normal end counts as done', () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Release' });
  thread('f');
  createProgressCard({ ownerUserId: 'alice', threadNodeId: 'f', startedFromPageId: page.id, now: 10 });
  reply('f', 1, 'Starting on it.');
  turn('f', 't1', 'error', 20);
  getDb().prepare("UPDATE turns SET error=? WHERE turn_id='t1'").run('\nspawn kiro-cli ENOENT\n    at ChildProcess.spawn');
  const failed = listHomeProgressCards('alice', 30)[0]!;
  assert.deepEqual([failed.status, failed.error], ['failed', 'spawn kiro-cli ENOENT']);

  turn('f', 't2', 'cancelled', 40);
  const stopped = listHomeProgressCards('alice', 50)[0]!;
  assert.deepEqual([stopped.status, stopped.error], ['cancelled', null]);

  turn('f', 't3', 'completed', 60);
  getDb().prepare("UPDATE turns SET stop_reason='max_tokens' WHERE turn_id='t3'").run();
  const cut = listHomeProgressCards('alice', 70)[0]!;
  assert.deepEqual([cut.status, cut.error], ['failed', 'The reply reached its length limit before it finished.']);
  getDb().prepare("UPDATE turns SET stop_reason='end_turn' WHERE turn_id='t3'").run();
  assert.deepEqual([listHomeProgressCards('alice', 70)[0]!.status, listHomeProgressCards('alice', 70)[0]!.error], ['done', null]);
});

test('cards show on their page and on Home until dismissed or 24 hours after they were seen', () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Release' });
  const other = createPage({ workspaceId: 'ws-2', ownerUserId: 'alice', title: 'Kyoto' });
  const home = getSpacesHome('alice');
  createProgressCard({ ownerUserId: 'alice', threadNodeId: thread('a'), startedFromPageId: page.id, now: 1_000 });
  createProgressCard({ ownerUserId: 'alice', threadNodeId: thread('b', 'ws-2'), startedFromPageId: other.id, now: 2_000 });
  createProgressCard({ ownerUserId: 'alice', threadNodeId: thread('c', 'ws-2'), startedFromPageId: home.page.id, now: 3_000 });
  assert.deepEqual(listPageProgressCards(page.id, 'alice', 4_000).map((card) => card.threadNodeId), ['a']);
  assert.deepEqual(listPageProgressCards(home.page.id, 'alice', 4_000).map((card) => card.threadNodeId), ['c']);
  assert.deepEqual(listHomeProgressCards('alice', 4_000).map((card) => card.threadNodeId), ['c', 'b', 'a']);

  const seen = markProgressCardSeen('alice', 'a', 10_000);
  assert.equal(seen.seenAt, 10_000);
  assert.equal(seen.expiresAt, 10_000 + PROGRESS_CARD_TTL_MS);
  assert.equal(markProgressCardSeen('alice', 'a', 20_000).seenAt, 10_000, 'seeing again does not extend it');
  assert.deepEqual(listPageProgressCards(page.id, 'alice', 10_000 + 23 * HOUR).map((card) => card.threadNodeId), ['a']);
  assert.deepEqual(listPageProgressCards(page.id, 'alice', 10_000 + PROGRESS_CARD_TTL_MS).map((card) => card.threadNodeId), []);

  assert.equal(dismissProgressCard('alice', 'b', 5_000).dismissedAt, 5_000);
  assert.deepEqual(listHomeProgressCards('alice', 6_000).map((card) => card.threadNodeId), ['c', 'a']);
  getDb().prepare('UPDATE nodes SET deleted_at=1 WHERE id=?').run('c');
  assert.deepEqual(listHomeProgressCards('alice', 6_000).map((card) => card.threadNodeId), ['a']);
});

test('cards are owner-isolated and only track ordinary conversations started from a readable page', () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Release' });
  const other = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Other' });
  thread('n');
  thread('nb', 'ws-b');
  assert.throws(() => createProgressCard({ ownerUserId: 'alice', threadNodeId: 'nb', startedFromPageId: page.id }), status(404));
  assert.throws(() => createProgressCard({ ownerUserId: 'bob', threadNodeId: 'nb', startedFromPageId: page.id }), status(404));
  assert.throws(() => createProgressCard({ ownerUserId: 'alice', threadNodeId: 'missing', startedFromPageId: page.id }), status(404));
  const systemId = getSpacesHome('alice').page.workspaceId;
  thread('sys', systemId);
  assert.throws(() => createProgressCard({ ownerUserId: 'alice', threadNodeId: 'sys', startedFromPageId: page.id }), status(404));

  const card = createProgressCard({ ownerUserId: 'alice', threadNodeId: 'n', startedFromPageId: page.id, now: 5 });
  assert.deepEqual(createProgressCard({ ownerUserId: 'alice', threadNodeId: 'n', startedFromPageId: page.id, now: 9 }), card);
  assert.throws(() => createProgressCard({ ownerUserId: 'alice', threadNodeId: 'n', startedFromPageId: other.id }), status(409));
  assert.deepEqual(listHomeProgressCards('bob'), []);
  assert.throws(() => listPageProgressCards(page.id, 'bob'), status(404));
  assert.throws(() => markProgressCardSeen('bob', 'n'), status(404));
  assert.throws(() => dismissProgressCard('bob', 'n'), status(404));
});

test('an untitled thread takes its first message as the title; a finished one says when it finished', () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Release' });
  getDb().prepare("INSERT INTO nodes(id,workspace_id,tree_id,kind,title,status,runtime_id) VALUES ('u','ws',NULL,'chat',NULL,'idle','kiro')").run();
  getDb().prepare("INSERT INTO messages(id,node_id,role,content,seq) VALUES ('u-q','u','user',?,0)").run('  把 Intel 机器手测的步骤写出来\nand keep it short');
  const card = createProgressCard({ ownerUserId: 'alice', threadNodeId: 'u', startedFromPageId: page.id, now: 10 });
  assert.equal(card.title, '把 Intel 机器手测的步骤写出来');
  assert.equal(card.finishedAt, null);
  turn('u', 't1', 'completed', 20);
  getDb().prepare('UPDATE turns SET completed_at=95 WHERE turn_id=?').run('t1');
  const done = listHomeProgressCards('alice', 100)[0]!;
  assert.equal(done.finishedAt, 95);
  assert.equal(done.statusLine, null);
  assert.equal(done.awaiting, null);
  getDb().prepare("UPDATE nodes SET title='Intel 手测步骤' WHERE id='u'").run();
  assert.equal(listHomeProgressCards('alice', 100)[0]!.title, 'Intel 手测步骤');
});

test('a running card reads what the conversation does from its live turn, approvals and questions included', () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Release' });
  thread('r');
  createProgressCard({ ownerUserId: 'alice', threadNodeId: 'r', startedFromPageId: page.id, now: 10 });
  turn('r', 't1', 'active', 20);
  const read = () => listHomeProgressCards('alice', 30)[0]!;
  assert.deepEqual([read().statusLine, read().awaiting, read().finishedAt], ['Working…', null, null], 'without a live turn it only knows the thread runs');

  let live: ProgressCardLiveTurn | null = { awaiting: null, reply: { content: '', blocks: [{ kind: 'answer' }], toolCalls: [{ status: 'in_progress', kind: 'execute', title: 'npm test' }] } };
  try {
    configureProgressCardLiveTurns((nodeId) => (nodeId === 'r' ? live : null));
    assert.deepEqual([read().statusLine, read().awaiting], ['Running tests…', null]);
    live = { awaiting: 'approval', awaitingDetail: 'Run npm test', reply: null };
    assert.deepEqual([read().statusLine, read().awaiting, read().awaitingDetail], ['Waiting for your approval…', 'approval', 'Run npm test']);
    live = { awaiting: 'question', awaitingDetail: 'Which branch should I use?', reply: null };
    assert.deepEqual([read().statusLine, read().awaitingDetail], ['Waiting for your answer…', 'Which branch should I use?']);
    live = { awaiting: null, awaitingDetail: 'stale', reply: null };
    assert.equal(read().awaitingDetail, null, 'a detail shows only while it waits');
    getDb().prepare("UPDATE turns SET status='completed',completed_at=40 WHERE turn_id='t1'").run();
    assert.deepEqual([read().statusLine, read().awaiting, read().finishedAt], [null, null, 40], 'a finished turn is not asked for its live state');
  } finally {
    configureProgressCardLiveTurns(null);
  }
});

test('ChatHub\'s live turn says which kind of answer it waits for', () => {
  const snapshot = (durableStatus: string, waiting: boolean) => ({ chatId: 'c', durableStatus, pendingInteraction: { waiting },
    snapshot: { assistantMessage: { id: 'a', role: 'assistant', content: 'x', blocks: [], toolCalls: [], createdAt: 1 } } });
  const hub = (observation: unknown, permission: unknown = null, input: unknown = null) => ({
    getSnapshot: () => observation, getPendingPermission: () => permission, getPendingUserInput: () => input,
  }) as unknown as Parameters<typeof chatHubLiveTurn>[0];
  assert.equal(chatHubLiveTurn(hub(null), 'n'), null);
  assert.equal(chatHubLiveTurn(hub(snapshot('completed', false)), 'n'), null);
  assert.equal(chatHubLiveTurn(hub(snapshot('active', false)), 'n')?.awaiting, null);
  assert.equal(chatHubLiveTurn(hub(snapshot('active', true), { requestId: 1 }), 'n')?.awaiting, 'approval');
  assert.equal(chatHubLiveTurn(hub(snapshot('active', true), null, { requestId: 2 }), 'n')?.awaiting, 'question');
  const approval = chatHubLiveTurn(hub(snapshot('active', true), { requestId: 1, title: 'Run   npm test\nin backend' }), 'n');
  assert.deepEqual([approval?.awaiting, approval?.awaitingDetail], ['approval', 'Run npm test in backend']);
  const question = chatHubLiveTurn(hub(snapshot('active', true), null, { requestId: 2, questions: [{ header: 'Branch', question: 'Which branch should I test?', options: [], multiSelect: false }] }), 'n');
  assert.deepEqual([question?.awaiting, question?.awaitingDetail], ['question', 'Which branch should I test?']);
  assert.equal(chatHubLiveTurn(hub(snapshot('active', false)), 'n')?.reply?.content, 'x');
});
