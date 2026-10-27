import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME_SECTION_LIMIT } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { createPage, deletePage, getPage } from '../src/services/pages/repository';
import { applyAgentPageEdits, applyUserPageEdits } from '../src/services/pages/pageWrites';
import { getSpacesHome, setWorkspaceHomeHidden } from '../src/services/pages/homePages';
import {
  actOnHomeReminder, blockLine, chatHubLiveWait, homeConversations, homeSections, lastQuestion, markSpacesHomeLooked, STALLED_AFTER_MS,
  type HomeLiveWaitReader,
} from '../src/services/pages/homeSections';
import { seedConversation, type SeedTurn } from './helpers/homeConversations';
import { applyWorkspaceCommands } from '../src/services/domainCommands';
import { oneValueChange, spaceActivity } from '../src/services/pages/homeActivity';
import { createProgressCard, dismissProgressCard } from '../src/services/pages/progressCards';

const OWNER = LOCAL_AGENT_OWNER_ID;
let dir: string;
let oldData: string | undefined;
let oldCloud: string | undefined;

beforeEach(() => {
  oldData = process.env.MICHI_DATA_DIR;
  oldCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-home-sections-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb(); initDb();
  const insert = getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)');
  insert.run('ws', 'rabbitholes', null);
  insert.run('ws-2', 'sample-notes', null);
  insert.run('ws-x', 'Elsewhere', 'someone-else');
  for (const ws of ['ws', 'ws-2', 'ws-x']) {
    getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,title,status) VALUES (?,?,'chat','Source','idle')").run(`src-${ws}`, ws);
    getDb().prepare("INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES (?,?,?,'active',1,1)")
      .run(`t-${ws}`, `src-${ws}`, `a-${ws}`);
  }
});

afterEach(() => {
  closeDb();
  if (oldData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldData;
  if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

function source(workspaceId: string) {
  return { kind: 'chat' as const, nodeId: `src-${workspaceId}`, turnId: `t-${workspaceId}`, assistantId: `a-${workspaceId}` };
}

/** A human-edited block the agent then wants to change: one pending proposal. */
function propose(pageId: string, workspaceId: string, owner: string, text: string, now: number): string {
  const page = getPage(pageId, owner);
  const block = page.blocks[0]!;
  applyUserPageEdits({ pageId, ownerUserId: owner, revision: page.revision, now, ops: [
    { op: 'update', id: block.id, expectRev: block.rev, block: { type: 'markdown', text: 'Human' } },
  ] });
  const edited = getPage(pageId, owner).blocks[0]!;
  const result = applyAgentPageEdits({ pageId, workspaceId, ownerUserId: owner, source: source(workspaceId), now: now + 1, ops: [
    { op: 'update', id: block.id, expectRev: edited.rev, block: { type: 'markdown', text } },
  ] });
  assert.equal(result.proposed.length, 1, JSON.stringify(result));
  return result.proposed[0]!.id;
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
/** Before every conversation below, so Just done takes whatever completed. */
const LONG_AGO = 1;

let n = 0;
/** A conversation whose latest turn is `turn`, in `workspaceId`. Returns its node id. */
function chat(turn: Partial<SeedTurn> & Pick<SeedTurn, 'status'>, extra: { workspaceId?: string; title?: string | null; userMessageAt?: number; nodeId?: string } = {}): string {
  const nodeId = extra.nodeId ?? `c${++n}`;
  seedConversation({ nodeId, workspaceId: extra.workspaceId ?? 'ws', title: extra.title, userMessageAt: extra.userMessageAt,
    turns: [{ startedAt: NOW - DAY, ...turn }] });
  return nodeId;
}

const ids = (section: { items: Array<{ id: string }> }) => section.items.map((item) => item.id.replace(/^conversation:/, ''));
const read = (live?: HomeLiveWaitReader, since = LONG_AGO) => homeSections({ ownerUserId: OWNER, now: NOW, since, live });

test('a running turn waits on you only while ChatHub holds an approval or a question for it', () => {
  const approval = chat({ status: 'active', startedAt: NOW - 3_000 });
  const question = chat({ status: 'active', startedAt: NOW - 2_000 });
  const working = chat({ status: 'active', startedAt: NOW - 1_000 });
  const live: HomeLiveWaitReader = (nodeId) => nodeId === approval ? { kind: 'approval', text: 'Run   npm test\nin backend' }
    : nodeId === question ? { kind: 'question', text: 'Which tier ships first?' } : null;
  const sections = read(live);
  assert.deepEqual(ids(sections.waiting), [question, approval]);
  assert.deepEqual(sections.waiting.items.map((item) => item.summary), ['Asked: Which tier ships first?', 'Waiting for your approval: Run npm test in backend']);
  assert.ok(!ids(sections.done).includes(working) && !ids(sections.stalled).includes(working));
  assert.equal(read().waiting.total, 0, 'without the live state a running turn waits for nothing');
});

test('a failed or interrupted last turn waits on you until you write again; a cancel never counts', () => {
  const failed = chat({ status: 'error', error: 'Kiro exited with code 1\nstack…', startedAt: NOW - 5_000 });
  const restarted = chat({ status: 'error', error: 'backend_restarted', startedAt: NOW - 4_000 });
  const cancelled = chat({ status: 'cancelled', stopReason: 'cancelled', startedAt: NOW - 2_000 });
  const answered = chat({ status: 'error', error: 'boom', startedAt: NOW - 1_000 }, { userMessageAt: NOW - 500 });
  const sections = read();
  assert.deepEqual(ids(sections.waiting), [restarted, failed]);
  assert.deepEqual(sections.waiting.items.map((item) => item.summary), [
    'Interrupted: Michi stopped while it was running', 'Failed: Kiro exited with code 1',
  ]);
  for (const id of [cancelled, answered]) assert.ok(![...ids(sections.waiting), ...ids(sections.stalled), ...ids(sections.done)].includes(id));
});

test('an early-ended last turn is Just done, never waiting or stalled; the row says why it stopped', () => {
  const cut = chat({ status: 'completed', stopReason: 'max_tokens', reply: 'Half a', startedAt: NOW - 3_000 });
  const steps = chat({ status: 'completed', stopReason: 'max_turn_requests', reply: 'Still going', startedAt: NOW - 2_000 });
  const refused = chat({ status: 'completed', stopReason: 'refusal', reply: 'I can’t help with that', startedAt: NOW - 9 * DAY });
  const sections = read();
  assert.equal(sections.waiting.total, 0);
  assert.equal(sections.stalled.total, 0);
  assert.deepEqual(ids(sections.done), [steps, cut, refused]);
  assert.deepEqual(sections.done.items.map((item) => item.summary), [
    'Stopped early: it reached its step limit', 'Stopped early: it reached its output limit', 'Stopped: the agent declined to continue',
  ]);
  assert.equal(read(undefined, NOW - DAY).done.total, 2, 'one that ended before the last look is in no section');
});

test('a reply ending in a question waits for your answer; the row quotes the question', () => {
  const asked = chat({ status: 'completed', reply: 'I fixed the parser. Should I also update the docs?  \n', startedAt: NOW - 3_000 });
  const wide = chat({ status: 'completed', reply: '改好了。要继续合并吗？', startedAt: NOW - 2_000 });
  const replied = chat({ status: 'completed', reply: 'Ship it?', startedAt: NOW - 1_000 }, { userMessageAt: NOW - 100 });
  const midReply = chat({ status: 'completed', reply: 'Why? Because the cache was stale.', startedAt: NOW - 500 });
  const sections = read();
  assert.deepEqual(ids(sections.waiting), [wide, asked]);
  assert.deepEqual(sections.waiting.items.map((item) => item.summary), ['Asked: 要继续合并吗？', 'Asked: Should I also update the docs?']);
  assert.deepEqual(ids(sections.done), [midReply], 'a question mid-reply is not one to you; an answered one is neither');
  assert.ok(!ids(sections.waiting).includes(replied));
  assert.equal(lastQuestion('Options:\n- **A** or B?'), '**A** or B?');
  assert.equal(lastQuestion('Done.\n\n1. Keep it?'), 'Keep it?');
  assert.equal(lastQuestion('打包好了。\n\n等你选安装路径：~/.kiro/crew/apps，还是独立目录？'), '等你选安装路径：~/.kiro/crew/apps，还是独立目录？');
  assert.equal(lastQuestion('Use v1.2.3? Or wait for 1.3?'), 'Or wait for 1.3?');
});

test('after three quiet days a waiting conversation moves to Stalled, listed once; a normal completion never stalls', () => {
  const fresh = chat({ status: 'error', error: 'x', startedAt: NOW - STALLED_AFTER_MS + DAY, completedAt: NOW - STALLED_AFTER_MS + 1 });
  const quiet = chat({ status: 'completed', reply: 'Proceed?', startedAt: NOW - 5 * DAY, completedAt: NOW - STALLED_AFTER_MS });
  const old = chat({ status: 'error', error: 'y', startedAt: NOW - 9 * DAY });
  const pending = chat({ status: 'active', startedAt: NOW - 4 * DAY, updatedAt: NOW - 4 * DAY });
  const finished = chat({ status: 'completed', reply: 'All green.', startedAt: NOW - 9 * DAY });
  const sections = read((nodeId) => nodeId === pending ? { kind: 'approval', text: 'Edit file' } : null);
  assert.deepEqual(ids(sections.waiting), [fresh]);
  assert.deepEqual(ids(sections.stalled), [quiet, pending, old]);
  assert.deepEqual([sections.stalled.items[0]!.summary, sections.stalled.items[0]!.at], ['Asked: Proceed?', NOW - STALLED_AFTER_MS]);
  assert.deepEqual(ids(sections.done), [finished], 'it is done (since the start of time here), never stalled');
});

test('Just done lists normal completions after the last look, with the first line of the reply', () => {
  const before = chat({ status: 'completed', reply: 'Old', startedAt: NOW - 3 * DAY });
  const after = chat({ status: 'completed', reply: '\n\nRenamed the table.\nThen ran the suite.', startedAt: NOW - DAY / 2 });
  assert.deepEqual(ids(homeSections({ ownerUserId: OWNER, now: NOW }).done), [after], 'before any look: the last 24 hours');
  markSpacesHomeLooked(OWNER, NOW - 2 * DAY);
  markSpacesHomeLooked('someone-else', NOW);
  const sections = homeSections({ ownerUserId: OWNER, now: NOW });
  assert.equal(sections.doneSince, NOW - 2 * DAY);
  assert.deepEqual(ids(sections.done), [after]);
  assert.equal(sections.done.items[0]!.summary, 'Renamed the table.');
  assert.deepEqual(sections.done.items[0]!.target, { kind: 'conversation', nodeId: after, workspaceId: 'ws', messageId: `${after}-t0-a` });
  markSpacesHomeLooked(OWNER, NOW);
  assert.equal(homeSections({ ownerUserId: OWNER, now: NOW }).done.total, 0);
  assert.ok(!ids(read(undefined, NOW - DAY).done).includes(before));
});

test('Just done leaves out a conversation you had on screen since it completed, by its stored view mark', () => {
  const seen = chat({ status: 'completed', reply: 'Seen', startedAt: NOW - 4_000 });
  const seenWhileRunning = chat({ status: 'completed', reply: 'Seen while it ran', startedAt: NOW - 3_000 });
  const unseen = chat({ status: 'completed', reply: 'Unseen', startedAt: NOW - 2_000 });
  const failed = chat({ status: 'error', error: 'boom', startedAt: NOW - 1_000 });
  const mark = (nodeId: string, at: number) => applyWorkspaceCommands('ws', {
    operationId: `view-${nodeId}`, commands: [{ type: 'node.patch', payload: { id: nodeId, viewed_at: at } }],
  });
  mark(seen, NOW - 4_000 + 10);
  mark(seenWhileRunning, NOW - 3_000 + 5);
  mark(failed, NOW);
  const sections = read();
  assert.deepEqual(ids(sections.done), [unseen, seenWhileRunning]);
  assert.equal(sections.done.total, 2);
  assert.deepEqual(ids(sections.waiting), [failed], 'having seen a failure does not answer it');
  const all = homeConversations({ ownerUserId: OWNER, now: NOW, since: LONG_AGO });
  assert.equal(all.items.find((item) => item.id === `conversation:${seen}`)?.state, null);
  assert.deepEqual(ids(homeConversations({ ownerUserId: OWNER, now: NOW, since: LONG_AGO, state: 'done' })), [unseen, seenWhileRunning]);
});

test('only the latest turn counts, and an untitled conversation is named by its first message', () => {
  seedConversation({ nodeId: 'two', workspaceId: 'ws', title: null, turns: [
    { status: 'error', error: 'old failure', startedAt: NOW - 5_000, userText: 'Fix the flaky test\nplease' },
    { status: 'completed', reply: 'Fixed.', startedAt: NOW - 1_000 },
  ] });
  const sections = read();
  assert.deepEqual([ids(sections.waiting), ids(sections.done)], [[], ['two']]);
  assert.equal(sections.done.items[0]!.title, 'Fix the flaky test');
  assert.equal(sections.done.items[0]!.workspaceName, 'rabbitholes');
});

test('the Meta agent, maintenance runs, scheduled jobs, archived, trashed and hidden conversations never count', () => {
  const failing = { status: 'error' as const, error: 'x' };
  const kept = chat(failing);
  getDb().prepare("INSERT INTO workspaces(id,name,owner_user_id,settings,created_at,updated_at) VALUES ('sys','Spaces',?, ?,1,1)")
    .run(OWNER, JSON.stringify({ system: 'spaces' }));
  chat(failing, { workspaceId: 'sys' });
  seedConversation({ nodeId: 'maint', workspaceId: 'ws', maintenanceJobId: 'job-1', turns: [{ status: 'error', startedAt: NOW - DAY }] });
  seedConversation({ nodeId: 'cron', workspaceId: 'ws', turns: [{ status: 'completed', reply: 'Report?', startedAt: NOW - DAY, scheduledJobId: 'job-2' }] });
  seedConversation({ nodeId: 'cron-then-you', workspaceId: 'ws', turns: [
    { status: 'completed', reply: 'Report', startedAt: NOW - 2 * DAY, scheduledJobId: 'job-2' },
    { status: 'completed', reply: 'Want more?', startedAt: NOW - DAY },
  ] });
  seedConversation({ nodeId: 'archived', workspaceId: 'ws', nodeStatus: 'archived', turns: [{ status: 'error', startedAt: NOW - DAY }] });
  seedConversation({ nodeId: 'tree-archived', workspaceId: 'ws', treeArchivedAt: 5, turns: [{ status: 'error', startedAt: NOW - DAY }] });
  seedConversation({ nodeId: 'trashed', workspaceId: 'ws', deletedAt: 5, turns: [{ status: 'error', startedAt: NOW - DAY }] });
  chat(failing, { workspaceId: 'ws-2', nodeId: 'hidden' });
  setWorkspaceHomeHidden('ws-2', OWNER, true, 5);
  getDb().prepare("INSERT INTO workspaces(id,name,owner_user_id,archived_at,created_at,updated_at) VALUES ('ws-old','Old',NULL,5,1,1)").run();
  chat(failing, { workspaceId: 'ws-old' });
  chat(failing, { workspaceId: 'ws-x', nodeId: 'theirs' });
  getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status) VALUES ('digest','ws','digest','idle')").run();
  getDb().prepare("INSERT INTO turns(turn_id,node_id,assistant_message_id,status,error,started_at,completed_at,updated_at) VALUES ('dt','digest','da','error','x',1,2,2)").run();

  const sections = read();
  assert.deepEqual(ids(sections.waiting).sort(), ['cron-then-you', kept, 'theirs'].sort());
  // Desktop includes legacy cloud-owned workspaces; hidden and system workspaces stay out.
  assert.equal(sections.conversationTotal, 5);
  assert.deepEqual(homeConversations({ ownerUserId: OWNER, now: NOW, since: LONG_AGO }).items.map((item) => item.id.replace('conversation:', '')).sort(),
    ['cron-then-you', kept, 'src-ws', 'src-ws-x', 'theirs'].sort());
  const theirs = homeSections({ ownerUserId: 'someone-else', now: NOW, since: LONG_AGO });
  assert.deepEqual(ids(theirs.waiting), ['theirs']);
  setWorkspaceHomeHidden('ws-2', OWNER, false, 6);
  assert.ok(ids(read().waiting).includes('hidden'), 'showing the workspace again brings it back');
});

test('in cloud mode a workspace with no owner is nobody\'s', () => {
  process.env.MICHI_CLOUD = '1';
  chat({ status: 'error', error: 'x' });
  assert.equal(read().waiting.total, 0);
});

test('counts per workspace cover every item; All threads lists every conversation with its state', () => {
  const many = Array.from({ length: HOME_SECTION_LIMIT + 2 }, (_, i) => chat({ status: 'error', error: 'x', startedAt: NOW - 1_000 * (i + 1) }, { workspaceId: i % 2 ? 'ws-2' : 'ws' }));
  const stalled = chat({ status: 'error', error: 'x', startedAt: NOW - 5 * DAY }, { workspaceId: 'ws-2' });
  const calm = chat({ status: 'completed', reply: 'ok', startedAt: NOW - 5 * DAY });
  const sections = read();
  assert.equal(sections.waiting.items.length, HOME_SECTION_LIMIT);
  assert.equal(sections.waiting.total, many.length);
  assert.deepEqual(sections.byWorkspace, { ws: { waiting: 5, stalled: 0 }, 'ws-2': { waiting: 5, stalled: 1 } });
  const all = homeConversations({ ownerUserId: OWNER, now: NOW, since: NOW - DAY });
  const states = new Map(all.items.map((item) => [item.id.replace('conversation:', ''), item.state]));
  assert.deepEqual([states.get(many[0]!), states.get(stalled), states.get(calm)], ['waiting', 'stalled', null]);
  assert.equal(all.total, many.length + 2 + 3, 'with source chats from all three desktop workspaces');
  const page = homeConversations({ ownerUserId: OWNER, now: NOW, state: 'waiting', limit: 3 });
  assert.deepEqual([page.total, page.items.length, page.items[0]!.state], [many.length, 3, 'waiting']);
  assert.deepEqual(page.items.map((item) => item.id.replace('conversation:', '')), many.slice(0, 3));
});

test('chatHubLiveWait reads the pending permission or question of an active turn only', () => {
  const observation = (waiting: boolean, status = 'active') => ({ chatId: 'chat', inMemoryStatus: status, pendingInteraction: waiting ? { waiting: true, reason: 'r' } : { waiting: false } });
  const hub = (obs: unknown, permission: unknown, input: unknown) => ({
    getSnapshot: () => obs, getPendingPermission: () => permission, getPendingUserInput: () => input,
  }) as unknown as Parameters<typeof chatHubLiveWait>[0];
  assert.deepEqual(chatHubLiveWait(hub(observation(true), { title: 'Run tests' }, null), 'n'), { kind: 'approval', text: 'Run tests' });
  assert.deepEqual(chatHubLiveWait(hub(observation(true), null, { questions: [{ question: 'Which?' }] }), 'n'), { kind: 'question', text: 'Which?' });
  assert.equal(chatHubLiveWait(hub(observation(false), null, null), 'n'), null);
  assert.equal(chatHubLiveWait(hub(observation(true, 'ended'), { title: 'x' }, null), 'n'), null);
  assert.equal(chatHubLiveWait(hub(null, null, null), 'n'), null);
});

test('waiting adds page proposals that wait for confirmation, newest first, capped with a full total', () => {
  const pages = Array.from({ length: HOME_SECTION_LIMIT + 2 }, (_, i) => createPage({ workspaceId: i % 2 ? 'ws-2' : 'ws', ownerUserId: OWNER, title: `Page ${i}`, now: 1 }));
  const changeIds = pages.map((page, i) => propose(page.id, page.workspaceId, OWNER, `Agent idea ${i}`, 2_000 + i * 10));
  const foreign = createPage({ workspaceId: 'ws-x', ownerUserId: 'someone-else', title: 'Not yours' });
  propose(foreign.id, 'ws-x', 'someone-else', 'Elsewhere', 9_000);
  chat({ status: 'error', error: 'x', startedAt: 1_000, completedAt: 1_500 }, { nodeId: 'w-old' });
  chat({ status: 'error', error: 'x', startedAt: 2_000, completedAt: 2_086 }, { nodeId: 'w-new' });

  const { waiting, byWorkspace } = homeSections({ ownerUserId: OWNER, now: 3_000, since: LONG_AGO });
  assert.equal(waiting.total, 2 + pages.length);
  assert.equal(waiting.items.length, HOME_SECTION_LIMIT);
  assert.deepEqual(waiting.items.slice(0, 3).map((item) => item.id), [`change:${changeIds[9]}`, 'conversation:w-new', `change:${changeIds[8]}`]);
  assert.ok(!waiting.items.some((item) => item.id === 'conversation:w-old'), 'older items fall past the cap');
  assert.deepEqual(byWorkspace, { ws: { waiting: 7, stalled: 0 }, 'ws-2': { waiting: 5, stalled: 0 } });
  const newest = waiting.items[0]!;
  assert.equal(newest.kind, 'proposal');
  assert.equal(newest.title, 'Page 9');
  assert.equal(newest.workspaceName, 'sample-notes');
  assert.equal(newest.summary, 'Suggested rewrite: Agent idea 9');
  assert.deepEqual(newest.target, { kind: 'page', pageId: pages[9]!.id, blockId: pages[9]!.blocks[0]!.id, changeId: changeIds[9] });

  // Proposals on trashed pages and archived workspaces stop counting, and so do that workspace's conversations.
  deletePage(pages[9]!.id, OWNER);
  getDb().prepare("UPDATE workspaces SET archived_at=5 WHERE id='ws'").run();
  const after = homeSections({ ownerUserId: OWNER, now: 3_000, since: LONG_AGO });
  assert.deepEqual(after.conversations, { available: true });
  assert.equal(after.waiting.total, 4, 'the four sample-notes proposals left');
});

test('a suggestion row names the section it changes and quotes the suggested text without the title', () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Michi 0.9 发布', now: 1 });
  applyUserPageEdits({ pageId: page.id, ownerUserId: OWNER, revision: page.revision, now: 2, ops: [
    { op: 'insert', after: null, block: { type: 'callout', tone: 'info', title: 'Budget', text: '¥9,800' } },
    { op: 'insert', after: null, block: { type: 'markdown', text: '#### 风险\n\n公证不过就只能发未签名包。' } },
  ] });
  const blocks = getPage(page.id, OWNER).blocks;
  const risk = blocks.find((block) => block.type === 'markdown' && block.text.startsWith('#### 风险'));
  const budget = blocks.find((block) => block.type === 'callout');
  const result = applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: OWNER, source: source('ws'), now: 3, ops: [
    { op: 'update', id: risk!.id, expectRev: risk!.rev, block: { type: 'markdown', text: '#### 风险\n\n公证已解决。剩下 node-pty 没测。' } },
    { op: 'delete', id: budget!.id, expectRev: budget!.rev },
  ] });
  assert.equal(result.proposed.length, 2, JSON.stringify(result));
  const summaries = homeSections({ ownerUserId: OWNER, now: 4, since: LONG_AGO }).waiting.items.map((item) => item.summary).sort();
  assert.deepEqual(summaries, ['Suggested removal of “Budget”', 'Suggested rewrite of “风险”: 公证已解决。剩下 node-pty 没测。']);
});

test('a Spaces Home proposal counts too and names no workspace', () => {
  const home = getSpacesHome(OWNER);
  const assistantNode = getDb().prepare("SELECT id FROM nodes WHERE workspace_id=? AND kind='chat'").get(home.page.workspaceId) as { id: string };
  getDb().prepare("INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES ('t-home',?,'a-home','active',1,1)").run(assistantNode.id);
  const added = applyUserPageEdits({ pageId: home.page.id, ownerUserId: OWNER, revision: home.page.revision, now: 5, ops: [
    { op: 'insert', after: null, block: { type: 'markdown', text: 'Mine' } },
  ] });
  const block = getPage(home.page.id, OWNER).blocks[0]!;
  assert.equal(added.applied.length, 1);
  const proposed = applyAgentPageEdits({ pageId: home.page.id, workspaceId: home.page.workspaceId, ownerUserId: OWNER, now: 6,
    source: { kind: 'chat', nodeId: assistantNode.id, turnId: 't-home', assistantId: 'a-home' },
    ops: [{ op: 'update', id: block.id, expectRev: block.rev, block: { type: 'markdown', text: 'Better' } }] });
  assert.equal(proposed.proposed.length, 1);
  const { waiting, byWorkspace } = homeSections({ ownerUserId: OWNER, live: (nodeId) => nodeId === assistantNode.id ? { kind: 'approval', text: 'x' } : null });
  assert.equal(waiting.total, 1, 'the assistant\'s own running conversation is not one of yours');
  assert.equal(waiting.items[0]!.workspaceId, null);
  assert.equal(waiting.items[0]!.workspaceName, '');
  assert.equal(waiting.items[0]!.title, 'Home');
  assert.deepEqual(byWorkspace, {});
});

test('Space activity groups page changes by write, adds conversations started from a page, newest first and bounded', () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Release', now: 1 });
  const block = page.blocks[0]!;
  applyUserPageEdits({ pageId: page.id, ownerUserId: OWNER, revision: page.revision, now: 100, ops: [
    { op: 'update', id: block.id, expectRev: block.rev, block: { type: 'markdown', text: 'First draft' } },
    { op: 'insert', after: block.id, block: { type: 'heading', text: 'Risks' } },
  ] });
  const after = getPage(page.id, OWNER);
  applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: OWNER, source: source('ws'), now: 200, ops: [
    { op: 'insert', after: null, block: { type: 'callout', title: 'Note', text: 'Agent added this' } },
  ] });
  getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,title,status) VALUES ('started','ws-2','chat','Rollback run','idle')").run();
  createProgressCard({ ownerUserId: OWNER, threadNodeId: 'started', startedFromPageId: page.id, now: 150 });
  dismissProgressCard(OWNER, 'started', 160);
  const foreign = createPage({ workspaceId: 'ws-x', ownerUserId: 'someone-else', title: 'Hidden' });
  applyUserPageEdits({ pageId: foreign.id, ownerUserId: 'someone-else', revision: foreign.revision, now: 300, ops: [
    { op: 'update', id: foreign.blocks[0]!.id, expectRev: foreign.blocks[0]!.rev, block: { type: 'markdown', text: 'x' } },
  ] });

  const items = spaceActivity(OWNER);
  assert.deepEqual(items.map((item) => [item.kind, item.at]), [['page-change', 200], ['conversation', 150], ['page-change', 100]]);
  const [agent, conversation, user] = items;
  assert.ok(agent?.kind === 'page-change' && user?.kind === 'page-change' && conversation?.kind === 'conversation');
  assert.deepEqual({ actor: agent.actor, sourceKind: agent.sourceKind, node: agent.sourceNodeId, count: agent.count, summary: agent.summary },
    { actor: 'agent', sourceKind: 'chat', node: 'src-ws', count: 1, summary: 'Note: Agent added this' });
  assert.deepEqual({ actor: user.actor, count: user.count, ops: user.ops.sort(), page: user.pageTitle, workspace: user.workspaceName },
    { actor: 'user', count: 2, ops: ['insert', 'update'], page: 'Release', workspace: 'rabbitholes' });
  assert.deepEqual({ title: conversation.title, workspace: conversation.workspaceName, from: conversation.startedFromPageTitle },
    { title: 'Rollback run', workspace: 'sample-notes', from: 'Release' });
  assert.equal(after.revision, page.revision + 1);
  assert.deepEqual(spaceActivity(OWNER, { limit: 1 }).map((item) => item.at), [200]);
  assert.equal(spaceActivity(OWNER, { limit: 500 }).length, 3);
  deletePage(page.id, OWNER);
  assert.deepEqual(spaceActivity(OWNER).map((item) => item.kind), ['conversation']);
});

/** Another active turn of a node, so one conversation can write in two turns. */
function turn(nodeId: string, turnId: string) {
  getDb().prepare("INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES (?,?,?,'active',1,1)").run(turnId, nodeId, `a-${turnId}`);
  return { kind: 'chat' as const, nodeId, turnId, assistantId: `a-${turnId}` };
}
const MIN = 60_000;
const pageItems = (pageId: string) => spaceActivity(OWNER, { now: NOW }).filter((item) => item.kind === 'page-change' && item.pageId === pageId);

test('Space activity groups a page\'s changes by turn, run or stretch of the person\'s edits, and says what each did', () => {
  getDb().prepare("UPDATE nodes SET title='京都住宿对比' WHERE id='src-ws'").run();
  const page = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: '京都 5 日', now: NOW - 300 * MIN });
  const edit = (ops: unknown[], now: number) => applyUserPageEdits({ pageId: page.id, ownerUserId: OWNER, revision: getPage(page.id, OWNER).revision, now, ops });
  const first = page.blocks[0]!;
  edit([{ op: 'update', id: first.id, expectRev: first.rev, block: { type: 'markdown', text: '#### 第 3 天\n\n早上去竹林。' } }], NOW - 200 * MIN);
  const day3 = getPage(page.id, OWNER).blocks[0]!;
  edit([{ op: 'update', id: day3.id, expectRev: day3.rev, block: { type: 'markdown', text: '#### 第 3 天\n\n早上 7 点前去竹林。' } }], NOW - 195 * MIN);
  const a = turn('src-ws', 't-a');
  applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: OWNER, source: a, now: NOW - 120 * MIN, ops: [
    { op: 'insert', after: null, block: { type: 'callout', title: '预算', text: '已花 ¥9,800 / 预算 ¥14,000。' } },
  ] });
  const budget = getPage(page.id, OWNER).blocks.find((block) => block.type === 'callout')!;
  const b = turn('src-ws', 't-b');
  applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: OWNER, source: b, now: NOW - 60 * MIN, ops: [
    { op: 'update', id: budget.id, expectRev: budget.rev, block: { type: 'callout', title: '预算', text: '已花 ¥11,600 / 预算 ¥14,000。Day 3 住宿多了 ¥1,800。' } },
  ] });
  const [value, added, mine] = pageItems(page.id);
  assert.equal(pageItems(page.id).length, 3, 'two turns and one stretch of edits');
  assert.ok(value?.kind === 'page-change' && added?.kind === 'page-change' && mine?.kind === 'page-change');
  assert.deepEqual(value.detail, { by: { kind: 'conversation', title: '京都住宿对比' }, action: 'rewrote', names: ['预算'], targets: 1, undone: false,
    value: { name: '预算', from: '¥9,800', to: '¥11,600' } });
  assert.deepEqual({ ...added.detail, count: added.count }, { by: { kind: 'conversation', title: '京都住宿对比' }, action: 'added', names: ['预算'], targets: 1, undone: false, count: 1 });
  assert.deepEqual({ ...mine.detail, count: mine.count, actor: mine.actor }, { by: { kind: 'user' }, action: 'rewrote', names: ['第 3 天'], targets: 1, undone: false, count: 2, actor: 'user' });

  // The same writer much later is a new group.
  const later = getPage(page.id, OWNER).blocks.find((block) => block.type === 'markdown')!;
  edit([{ op: 'update', id: later.id, expectRev: later.rev, block: { type: 'markdown', text: '#### 第 3 天\n\n早上 6 点去竹林。' } }], NOW - 10 * MIN);
  assert.equal(pageItems(page.id).length, 4);
});

test('Space activity names the Meta agent, counts entries a list gained, labels suggestions and marks what is new since the last look', () => {
  const home = getSpacesHome(OWNER, NOW - 300 * MIN);
  const assistantNode = (getDb().prepare("SELECT id FROM nodes WHERE workspace_id=? AND kind='chat'").get(home.page.workspaceId) as { id: string }).id;
  const page = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'rabbitholes', now: NOW - 300 * MIN });
  const meta = turn(assistantNode, 't-meta');
  applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: OWNER, source: meta, now: NOW - 100 * MIN, ops: [
    { op: 'insert', after: null, block: { type: 'timeline', title: '进展', items: [{ title: 'Michi 合入 dev', at: 1 }] } },
  ] });
  applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: OWNER, source: meta, now: NOW - 99 * MIN, ops: [
    { op: 'insert', after: null, block: { type: 'callout', title: '还没修的', text: '首屏 2.1s。' } },
  ] });
  const [both] = pageItems(page.id);
  assert.ok(both?.kind === 'page-change');
  assert.deepEqual({ ...both.detail, count: both.count, ops: both.ops }, { by: { kind: 'meta-agent' }, action: 'added', names: ['进展', '还没修的'], targets: 2, undone: false, count: 2, ops: ['insert'] });

  markSpacesHomeLooked(OWNER, NOW - 50 * MIN);
  const timeline = getPage(page.id, OWNER).blocks.find((block) => block.type === 'timeline')!;
  const notarize = turn('src-ws', 't-notarize');
  applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: OWNER, source: notarize, now: NOW - 20 * MIN, ops: [
    { op: 'update', id: timeline.id, expectRev: timeline.rev, block: { type: 'timeline', title: '进展', items: [{ title: '审阅改了结论', at: 3 }, { title: '增量读取接上', at: 2 }, { title: 'Michi 合入 dev', at: 1 }] } },
  ] });
  const changeId = propose(createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Michi 0.9 发布', now: NOW - 30 * MIN }).id, 'ws', OWNER, '公证已解决。', NOW - 5 * MIN);
  const items = spaceActivity(OWNER, { now: NOW }).filter((item) => item.kind === 'page-change');
  const [suggestion, yours, entries, older] = items;
  assert.ok(suggestion?.kind === 'page-change' && yours?.kind === 'page-change' && entries?.kind === 'page-change' && older?.kind === 'page-change');
  assert.deepEqual({ action: suggestion.detail?.action, by: suggestion.detail?.by, pending: suggestion.pending, fresh: suggestion.fresh },
    { action: 'suggested', by: { kind: 'conversation', title: 'Source' }, pending: 1, fresh: true });
  assert.deepEqual({ by: yours.detail?.by, fresh: yours.fresh }, { by: { kind: 'user' }, fresh: false }, 'the person\'s own edit is not news to them');
  assert.deepEqual({ action: entries.detail?.action, entries: entries.detail?.entries, names: entries.detail?.names, fresh: entries.fresh },
    { action: 'updated', entries: { added: 2, removed: 0 }, names: ['进展'], fresh: true });
  assert.equal(older.fresh, false, 'written before the last look');

  getDb().prepare("UPDATE page_changes SET proposal_state='accepted',application_state='applied' WHERE id=?").run(changeId);
  const accepted = spaceActivity(OWNER, { now: NOW }).find((item) => item.kind === 'page-change' && item.batchId === suggestion.batchId);
  assert.deepEqual({ action: accepted?.kind === 'page-change' && accepted.detail?.action, fresh: accepted?.fresh }, { action: 'accepted', fresh: false });
});

test('one changed value is found only when every other value of the old text is still there', () => {
  assert.deepEqual(oneValueChange('已花 ¥9,800 / 预算 ¥14,000。', '已花 ¥11,600 / 预算 ¥14,000。Day 3 多了 ¥1,800。'), { from: '¥9,800', to: '¥11,600' });
  assert.equal(oneValueChange('6 of 12 done, 3 left', '7 of 12 done, 2 left'), null);
  assert.equal(oneValueChange('No numbers', 'Still none'), null);
  assert.equal(oneValueChange('Was 40%', 'Now done'), null);
});

test('metrics, next-steps and timeline blocks summarise as one line', () => {
  assert.equal(blockLine({ type: 'metrics', id: 'm', rev: 1, items: [{ label: 'Branches', value: '6' }, { label: 'Ahead', value: '22 commits', tone: 'accent' }] }), 'Branches 6 · Ahead 22 commits');
  assert.equal(blockLine({ type: 'next-steps', id: 'n', rev: 1, title: 'Next steps', items: [{ who: 'user', text: 'Confirm' }, { who: 'agent', text: 'Run tests' }] }), 'Next steps · Confirm · Run tests');
  assert.equal(blockLine({ type: 'timeline', id: 't', rev: 1, items: [{ title: 'Merged', at: 1 }] }), 'Merged');
});


test('cloud home conversations remain isolated by exact owner, including local-user', () => {
  process.env.MICHI_CLOUD = '1';
  getDb().prepare('UPDATE workspaces SET owner_user_id=? WHERE id=?').run(OWNER, 'ws');
  chat({ status: 'error', error: 'x' }, { nodeId: 'own' });
  chat({ status: 'error', error: 'x' }, { nodeId: 'foreign', workspaceId: 'ws-x' });
  chat({ status: 'error', error: 'x' }, { nodeId: 'unowned', workspaceId: 'ws-2' });
  assert.deepEqual(ids(read().waiting), ['own']);
  assert.deepEqual(ids(homeSections({ ownerUserId: 'someone-else', now: NOW, since: LONG_AGO }).waiting), ['foreign']);
  assert.equal(homeConversations({ ownerUserId: OWNER, now: NOW }).items.some(item => item.workspaceId === 'ws-x'), false);
});

test('attention choices persist, update counts, preserve conversations, expire and allow new activity', () => {
  const nodeId = chat({ status: 'error', error: 'Failed', completedAt: NOW - 100 });
  const item = read().waiting.items.find(item => item.target.kind === 'conversation' && item.target.nodeId === nodeId)!;
  const input = { ownerUserId: OWNER, now: NOW, itemId: item.id, version: item.reminderVersion! };
  actOnHomeReminder({ ...input, action: 'dismiss' });
  closeDb(); initDb();
  assert.equal(read().waiting.total, 0);
  assert.equal(read().byWorkspace?.ws?.waiting ?? 0, 0);
  assert.ok(homeConversations({ ownerUserId: OWNER, now: NOW }).items.some(item => item.id === input.itemId));
  actOnHomeReminder({ ...input, action: 'restore' });
  assert.equal(read().waiting.total, 1);
  actOnHomeReminder({ ...input, action: 'snooze' });
  assert.equal(read().waiting.total, 0);
  assert.equal(homeSections({ ownerUserId: OWNER, now: NOW + DAY }).waiting.total, 1);
  actOnHomeReminder({ ...input, action: 'dismiss' });
  getDb().prepare('UPDATE turns SET completed_at=? WHERE node_id=?').run(NOW + 1, nodeId);
  assert.equal(read().waiting.total, 1);
  assert.throws(() => actOnHomeReminder({ ...input, action: 'dismiss' }), /reminder changed/);
  process.env.MICHI_CLOUD = '1';
  assert.throws(() => actOnHomeReminder({ ...input, ownerUserId: 'someone-else', action: 'dismiss' }), /not found/);
});
