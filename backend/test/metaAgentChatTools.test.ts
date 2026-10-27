import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime';
/**
 * The Meta agent chat window's tools through its MCP slot: Pages and
 * conversation updates in every workspace (an ordinary chat stays in its
 * own), writes through the page write engine with the chat-window message as
 * their source, and start_conversation on the user's global settings.
 */

import './isolatedConfigDir';
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyTurnEvent, createDurableTurn, type ChatStreamEvent } from 'michi-shared';
import type { AgentRuntime, AgentSession } from '../src/agents/types';
import type { StartRequestedSelfTurnArgs, StartedRequestedSelfTurn } from '../src/agents/chatHub';
import { registerRuntime } from '../src/agents/registry';
import { configureThreadMessaging, type ThreadMessagingDeps } from '../src/agents/threadMessageTool';
import { ensureAssistant } from '../src/assistant/store';
import { assistantTool } from '../src/assistant/tools';
import { startConversationTool } from '../src/services/metaAgent/startConversation';
import { updateMetaAgentSettings } from '../src/services/metaAgent/settings';
import { updateAgentConfig } from '../src/services/agentConfig';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { closeDb, getDb, initDb } from '../src/services/db';
import { beginTurn, finalizeTurn, getNode, saveNode, saveTree, saveWorkspace, setAiGlobalContext } from '../src/services/dbRepository';
import { McpSlotRegistry, buildMcpServerForSlot, type McpSlot } from '../src/services/mcpServer';
import { createDatabase, createPage, getDatabase, getPage, listPages, listSpaces } from '../src/services/pages/repository';
import { applyUserDatabaseEdits } from '../src/services/pages/databaseWrites';
import { openTaskDatabase } from '../src/services/pages/taskDatabase';
import { applyUserPageEdits } from '../src/services/pages/pageWrites';
import { listPageProgressCards } from '../src/services/pages/progressCards';
import { ensureSpacesHomePageId } from '../src/services/pages/homePages';

const OWNER = LOCAL_AGENT_OWNER_ID;

function fakeRuntime(id: string): AgentRuntime {
  return {
    id, label: id,
    descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
    capabilities: {
      modes: false, permissions: true, models: false, providerModels: false,
      reasoning: false, supportedReasoningLevels: [], apiKeys: false, warmSessions: false, saveContext: false, spawnBranches: false, nativeResume: false,
    },
    async warm() {},
    async newSession() { throw new Error('not used'); },
    async releaseSession() {},
    async shutdown() {},
  } as AgentRuntime;
}
for (const id of ['claude', 'codex']) registerRuntime(fakeRuntime(id));

function seedWorkspace(id: string): void {
  saveWorkspace({ id, name: `Project ${id}`, cwd: `/tmp/${id}`, created_at: 1, updated_at: 1, settings: null });
}

function seedChat(id: string, workspaceId: string): void {
  saveTree({ id: `t-${id}`, workspace_id: workspaceId, root_node_id: id, last_active_at: 1, created_at: 1 });
  saveNode({ id, workspace_id: workspaceId, tree_id: `t-${id}`, kind: 'chat', title: `Title ${id}`, status: 'idle',
    minimized: 0, spawned_by_agent: 0, acp_session_id: id, runtime_id: 'claude', created_at: 1 });
}

function activeTurn(nodeId: string, turnId: string, assistantId: string): void {
  getDb().prepare("INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES (?,?,?,'active',1,1)")
    .run(turnId, nodeId, assistantId);
}

const ev = (event: ChatStreamEvent['event'], data: Record<string, unknown>) => ({ event, data }) as ChatStreamEvent;

function completedTurn(nodeId: string, workspaceId: string, id: string): void {
  const turn = createDurableTurn({ turnId: id, assistantId: `a-${id}`, nodeId, workspaceId, displayUserText: `input ${id}`, startedAt: 10 });
  beginTurn(turn);
  const answer = applyTurnEvent(turn, ev('chunk', { seq: turn.lastAppliedSeq + 1, text: `answer ${id}` }));
  finalizeTurn(applyTurnEvent(answer, ev('done', { seq: answer.lastAppliedSeq + 1, stopReason: 'end_turn', completedAt: 100 })));
}

type AskUser = NonNullable<McpSlot['onAskUser']>;

function slotFor(nodeId: string, workspaceId: string, extra: Record<string, unknown> = {}, onAskUser?: AskUser): McpSlot {
  return new McpSlotRegistry().create(nodeId, '/tmp', null, {
    owner: { mode: 'interactive', key: nodeId },
    onSpawnBranches: async () => [],
    onSaveArtifact: () => null,
    onUpdateArtifact: () => null,
    ...(onAskUser ? { onAskUser } : {}),
    ...extra,
  } as never, { nodeId, workspaceId });
}

function tools(slot: McpSlot): Record<string, { handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }> {
  return (buildMcpServerForSlot(slot) as any)._registeredTools;
}

async function call(slot: McpSlot, name: string, args: Record<string, unknown> = {}) {
  const tool = tools(slot)[name];
  assert.ok(tool, `${name} is registered`);
  const result = await tool.handler(args, {});
  const text = result.content.map((part) => part.text).join('');
  let body: any;
  try { body = JSON.parse(text); } catch { body = undefined; }
  return { text, body, isError: result.isError === true };
}

interface Harness { deps: ThreadMessagingDeps; ensured: Array<{ workspaceId: string; nodeId: string }>; started: StartRequestedSelfTurnArgs[] }

function harness(): Harness {
  const ensured: Harness['ensured'] = [];
  const started: StartRequestedSelfTurnArgs[] = [];
  return {
    ensured, started,
    deps: {
      ensureSession: async (input) => {
        ensured.push(input);
        return { id: input.nodeId, runtimeId: getNode(input.nodeId)!.runtime_id } as unknown as AgentSession;
      },
      startTurn: async (args): Promise<StartedRequestedSelfTurn> => {
        started.push(args);
        return { turnId: args.turnId, assistantId: `self-${args.nodeId}-${args.turnId}`, done: Promise.resolve(), existing: false };
      },
      acquireRestoreLock: async () => () => {},
      newTurnId: () => 'turn-new',
      startWaitMs: 50,
    },
  };
}

describe('Meta agent chat window tools', () => {
  let tmpDir: string;
  let assistant: ReturnType<typeof ensureAssistant>;
  let meta: McpSlot;
  let ordinary: McpSlot;

  test('ordinary and Assistant MCP catalogs can customize the same owner Home', async () => {
    const initial = await call(meta, 'read_home');
    assert.equal(initial.isError, false, initial.text);
    const changed = await call(meta, 'edit_home', { expectedRevision: initial.body.revision, greetingMode: 'hidden', cardsMode: 'hidden' });
    assert.equal(changed.isError, false, changed.text);
    const ordinaryRead = await call(ordinary, 'read_home');
    assert.equal(ordinaryRead.isError, false, ordinaryRead.text);
    assert.equal(ordinaryRead.body.preferences.greetingMode, 'hidden');
    assert.equal(ordinaryRead.body.preferences.cardsMode, 'hidden');
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-meta-chat-tools-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
    seedWorkspace('ws-a');
    seedWorkspace('ws-b');
    seedChat('n-a1', 'ws-a');
    seedChat('n-b1', 'ws-b');
    assistant = ensureAssistant();
    activeTurn(assistant.nodeId, 'meta-turn', 'meta-assistant');
    activeTurn('n-a1', 'a-turn', 'a-assistant');
    meta = slotFor(assistant.nodeId, assistant.workspaceId, {
      restricted: true, getActivePageTurnAttribution: () => ({ turnId: 'meta-turn', assistantId: 'meta-assistant' }),
    }, async (qs) => ({ [qs[0].question]: 'Send' }));
    ordinary = slotFor('n-a1', 'ws-a', { getActivePageTurnAttribution: () => ({ turnId: 'a-turn', assistantId: 'a-assistant' }) });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('page reads reach every workspace for the Meta agent and stay in one for an ordinary chat', async () => {
    const pageA = createPage({ workspaceId: 'ws-a', ownerUserId: OWNER, title: 'Alpha notes' });
    const pageB = createPage({ workspaceId: 'ws-b', ownerUserId: OWNER, title: 'Beta plan' });

    const listedB = await call(meta, 'list_pages', { workspaceId: 'ws-b' });
    assert.equal(listedB.isError, false, listedB.text);
    assert.deepEqual(listedB.body.items.map((item: { id: string }) => item.id), [pageB.id]);
    assert.match((await call(meta, 'list_pages', {})).text, /workspaceId/, 'the Meta agent names the workspace');
    for (const workspaceId of [assistant.workspaceId, 'ws-missing']) {
      const refused = await call(meta, 'list_pages', { workspaceId });
      assert.ok(refused.isError, workspaceId);
      assert.match(refused.text, /Workspace not found/);
    }
    assert.match((await call(meta, 'list_pages', { workspaceId: 't-x' })).text, /thread or node id/);
    for (const page of [pageA, pageB]) {
      const read = await call(meta, 'read_page', { pageId: page.id });
      assert.equal(read.body.title, page.title);
    }

    // The ordinary chat in ws-a: a named workspace is ignored, another workspace's page reads as missing.
    const ordinaryList = await call(ordinary, 'list_pages', { workspaceId: 'ws-b' });
    assert.deepEqual(ordinaryList.body.items.map((item: { id: string }) => item.id), [pageA.id]);
    const denied = await call(ordinary, 'read_page', { pageId: pageB.id });
    assert.ok(denied.isError);
    assert.match(denied.text, /Page not found/);
    assert.doesNotMatch(denied.text, /Beta plan/);
  });

  test('an ordinary chat cannot write another workspace\'s pages', async () => {
    const pageB = createPage({ workspaceId: 'ws-b', ownerUserId: OWNER, title: 'Beta plan' });
    const edit = await call(ordinary, 'edit_page', { pageId: pageB.id, ops: [{ op: 'insert', after: null, block: { type: 'markdown', text: 'From A' } }] });
    assert.ok(edit.isError);
    assert.equal(getPage(pageB.id, OWNER).revision, pageB.revision);
    const created = await call(ordinary, 'create_page', { workspaceId: 'ws-b', title: 'Sneaky' });
    assert.equal(created.isError, false, created.text);
    assert.equal(created.body.page.workspaceId, 'ws-a', 'a named workspace never moves an ordinary chat');
    assert.equal(listPages('ws-b', OWNER).items.length, 1);
    const child = await call(ordinary, 'create_page', { parentId: pageB.id, title: 'Child' });
    assert.ok(child.isError);
    assert.equal(listPages('ws-b', OWNER).items.length, 1);
  });

  test("the Meta agent opens a named workspace's task database and lists tasks across workspaces", async () => {
    const opened = await call(meta, 'open_task_database', { workspaceId: 'ws-b' });
    assert.equal(opened.isError, false, opened.text);
    assert.equal(opened.body.workspaceId, 'ws-b');
    assert.equal(opened.body.created, true);
    assert.match((await call(meta, 'open_task_database', {})).text, /workspaceId/, 'the Meta agent names the workspace');
    const alpha = openTaskDatabase({ workspaceId: 'ws-a', ownerUserId: OWNER });
    applyUserDatabaseEdits({ databaseId: alpha.database.id, ownerUserId: OWNER, revision: alpha.database.revision, now: 20,
      ops: [{ op: 'row.add', id: 'ra', values: { task: 'Alpha task', status: 'todo', threads: ['n-a1'] } }] });
    const written = await call(meta, 'edit_database', { databaseId: opened.body.databaseId, ops: [
      { op: 'row.add', values: { task: 'Beta task', status: 'waiting', threads: ['n-b1'] } },
    ] });
    assert.equal(written.isError, false, written.text);

    const all = await call(meta, 'list_tasks', {});
    assert.equal(all.isError, false, all.text);
    assert.deepEqual(all.body.items.map((item: { task: string; workspaceId: string }) => [item.task, item.workspaceId]).sort(),
      [['Alpha task', 'ws-a'], ['Beta task', 'ws-b']]);
    const waiting = await call(meta, 'list_tasks', { needsYou: true });
    assert.deepEqual(waiting.body.items.map((item: { task: string; statusSetBy: string }) => [item.task, item.statusSetBy]), [['Beta task', 'agent']]);
    assert.deepEqual((await call(meta, 'list_tasks', { workspaceIds: ['ws-a'] })).body.items.map((item: { task: string }) => item.task), ['Alpha task']);
    for (const workspaceIds of [[assistant.workspaceId], ['ws-missing'], [], 'ws-a']) {
      assert.ok((await call(meta, 'list_tasks', { workspaceIds })).isError, JSON.stringify(workspaceIds));
    }

    // Where "Let AI navigate this workspace" is off, the Meta agent cannot open its tasks, and list_tasks says it left them out.
    setAiGlobalContext('ws-b', false);
    const off = await call(meta, 'open_task_database', { workspaceId: 'ws-b' });
    assert.ok(off.isError);
    assert.match(off.text, /NAVIGATION_DISABLED/);
    const skipped = await call(meta, 'list_tasks', {});
    assert.deepEqual(skipped.body.items.map((item: { task: string }) => item.task), ['Alpha task']);
    assert.deepEqual(skipped.body.skippedWorkspaces, [{ workspaceId: 'ws-b', workspaceName: 'Project ws-b', reason: 'navigation-off' }]);

    // An ordinary chat reads its own workspace, whatever it names.
    const own = await call(ordinary, 'list_tasks', { workspaceIds: ['ws-b'] });
    assert.deepEqual(own.body.items.map((item: { task: string }) => item.task), ['Alpha task']);
    assert.equal((await call(ordinary, 'open_task_database', { workspaceId: 'ws-b' })).body.workspaceId, 'ws-a');
  });

  test("the Meta agent's task writes name their workspace and count the tasks; a workspace hidden from AI navigation keeps its tasks to itself", async () => {
    const { database } = openTaskDatabase({ workspaceId: 'ws-b', ownerUserId: OWNER });
    const written = await call(meta, 'edit_database', { databaseId: database.id, ops: [
      { op: 'row.add', values: { task: 'Beta task', status: 'todo', threads: ['n-b1'] } },
    ] });
    assert.equal(written.isError, false, written.text);
    assert.equal(written.body.michiPageWrite.workspaceId, 'ws-b');
    assert.deepEqual(written.body.michiPageWrite.tasks, { added: 1, updated: 0, removed: 0 });

    setAiGlobalContext('ws-b', false);
    for (const [name, args] of [
      ['read_database', { databaseId: database.id }],
      ['edit_database', { databaseId: database.id, ops: [{ op: 'row.add', values: { task: 'Hidden' } }] }],
    ] as Array<[string, Record<string, unknown>]>) {
      const refused = await call(meta, name, args);
      assert.ok(refused.isError, name);
      assert.match(refused.text, /NAVIGATION_DISABLED/);
    }
    assert.equal(getDatabase(database.id, OWNER).rows.length, 1);
    const plain = createDatabase({ workspaceId: 'ws-b', ownerUserId: OWNER, title: 'Plain', columns: [{ id: 'name', name: 'Name', type: 'text' }], views: [] });
    assert.equal((await call(meta, 'read_database', { databaseId: plain.id })).isError, false, 'its other databases read as before');
  });

  test('Meta agent writes go through the engine, record the chat-window message and name the page\'s workspace', async () => {
    const pageB = createPage({ workspaceId: 'ws-b', ownerUserId: OWNER, title: 'Beta plan' });
    const inserted = await call(meta, 'edit_page', { pageId: pageB.id, ops: [{ op: 'insert', after: null, block: { type: 'markdown', text: 'Progress: 3 items' } }] });
    assert.equal(inserted.isError, false, inserted.text);
    assert.equal(inserted.body.michiPageWrite.appliedCount, 1);
    assert.equal(inserted.body.michiPageWrite.workspaceId, 'ws-b');
    assert.equal(inserted.body.michiPageWrite.atomic, true);
    assert.equal(inserted.body.michiPageWrite.commitStatus, 'committed');
    assert.equal(inserted.body.michiPageWrite.viewVersion, getPage(pageB.id, OWNER).viewVersion);
    const milestoneA = getPage(pageB.id, OWNER);
    const rejected = await call(meta, 'edit_page', { pageId: pageB.id, atomic: false, ops: [
      { op: 'delete', id: milestoneA.blocks[0]!.id, expectRev: milestoneA.blocks[0]!.rev },
      { op: 'insert', after: 'missing-anchor', block: { type: 'markdown', text: 'Incomplete B' } },
    ] });
    assert.equal(rejected.body.michiPageWrite.atomic, true, 'the assistant cannot opt out of complete updates');
    assert.equal(rejected.body.michiPageWrite.commitStatus, 'rejected');
    assert.equal(rejected.body.michiPageWrite.appliedCount, 0);
    assert.deepEqual(getPage(pageB.id, OWNER), milestoneA);
    const changes = getDb().prepare('SELECT source, source_node_id, workspace_id FROM page_changes WHERE page_id = ?').all(pageB.id) as
      Array<{ source: string; source_node_id: string; workspace_id: string }>;
    assert.ok(changes.length > 0);
    for (const change of changes) {
      assert.deepEqual(JSON.parse(change.source), { kind: 'chat', nodeId: assistant.nodeId, turnId: 'meta-turn', assistantId: 'meta-assistant' });
      assert.equal(change.source_node_id, assistant.nodeId);
      assert.equal(change.workspace_id, 'ws-b');
    }
    const block = getPage(pageB.id, OWNER).blocks.find((candidate) => candidate.type === 'markdown')!;
    assert.ok(block.sources?.some((source) => source.nodeId === assistant.nodeId && source.turnId === 'meta-turn'));

    // Once the user edits the block, the Meta agent only proposes.
    const current = getPage(pageB.id, OWNER);
    applyUserPageEdits({ pageId: pageB.id, ownerUserId: OWNER, revision: current.revision, ops: [
      { op: 'update', id: block.id, expectRev: block.rev, block: { type: 'markdown', text: 'Mine now' } },
    ] });
    const edited = getPage(pageB.id, OWNER).blocks.find((candidate) => candidate.id === block.id)!;
    const proposal = await call(meta, 'edit_page', { pageId: pageB.id, ops: [
      { op: 'update', id: block.id, expectRev: edited.rev, block: { type: 'markdown', text: 'Agent rewrite' } },
    ] });
    assert.equal(proposal.isError, false, proposal.text);
    assert.equal(proposal.body.michiPageWrite.appliedCount, 0);
    assert.equal(proposal.body.michiPageWrite.proposedCount, 1);
    const after = getPage(pageB.id, OWNER);
    assert.equal((after.blocks.find((candidate) => candidate.id === block.id) as { text?: string }).text, 'Mine now');
    assert.equal(after.pendingProposals, 1);

    const noTurn = slotFor(assistant.nodeId, assistant.workspaceId, { restricted: true, getActivePageTurnAttribution: () => null });
    const refused = await call(noTurn, 'edit_page', { pageId: pageB.id, ops: [{ op: 'insert', after: null, block: { type: 'markdown', text: 'x' } }] });
    assert.ok(refused.isError);
    assert.match(refused.text, /no active owning chat turn/);
  });

  test('the Meta agent writes metrics, next-steps and timeline blocks; a human-edited one only gets a proposal', async () => {
    const schema = JSON.stringify(assistantTool('edit_page')?.parameters);
    for (const type of ['metrics {', 'next-steps {', 'timeline {']) assert.ok(schema.includes(type), type);
    const pageB = createPage({ workspaceId: 'ws-b', ownerUserId: OWNER, title: 'Beta home' });
    const blocks = [
      { type: 'metrics', items: [{ label: 'Branches in dev', value: '6', note: 'Scheduled jobs' }] },
      { type: 'next-steps', title: 'Next steps', items: [{ who: 'agent', text: 'Run the rollback cases', unblocks: 'Merge to dev' }] },
      { type: 'timeline', title: 'Progress', items: [{ title: 'Merged', at: '2026-10-22T05:35', tone: 'success' }] },
    ];
    const inserted = await call(meta, 'edit_page', { pageId: pageB.id, ops: blocks.map((block) => ({ op: 'insert', after: null, block })) });
    assert.equal(inserted.isError, false, inserted.text);
    assert.equal(inserted.body.michiPageWrite.appliedCount, 3);
    const steps = getPage(pageB.id, OWNER).blocks.find((candidate) => candidate.type === 'next-steps')!;
    applyUserPageEdits({ pageId: pageB.id, ownerUserId: OWNER, revision: getPage(pageB.id, OWNER).revision, ops: [
      { op: 'update', id: steps.id, expectRev: steps.rev, block: { type: 'next-steps', title: 'Next steps', items: [{ who: 'user', text: 'Mine now' }] } },
    ] });
    const edited = getPage(pageB.id, OWNER).blocks.find((candidate) => candidate.id === steps.id)!;
    const proposal = await call(meta, 'edit_page', { pageId: pageB.id, ops: [
      { op: 'update', id: steps.id, expectRev: edited.rev, block: { type: 'next-steps', items: [{ who: 'agent', text: 'Agent rewrite' }] } },
    ] });
    assert.equal(proposal.isError, false, proposal.text);
    assert.equal(proposal.body.michiPageWrite.proposedCount, 1);
    assert.deepEqual((getPage(pageB.id, OWNER).blocks.find((candidate) => candidate.id === steps.id) as { items: unknown }).items, [{ who: 'user', text: 'Mine now' }]);
    const invalid = await call(meta, 'edit_page', { pageId: pageB.id, ops: [{ op: 'insert', after: null, block: { type: 'timeline', items: [{ title: 'When?', at: 'yesterday' }] } }] });
    assert.ok(invalid.isError || invalid.body?.michiPageWrite?.appliedCount === 0, invalid.text);
  });

  test('the Meta agent creates pages in a named workspace or under a parent, never in a system workspace', async () => {
    const created = await call(meta, 'create_page', { workspaceId: 'ws-b', title: '性能' });
    assert.equal(created.isError, false, created.text);
    assert.equal(created.body.page.workspaceId, 'ws-b');
    assert.equal(created.body.michiPageWrite.workspaceId, 'ws-b');
    const page = getPage(created.body.page.id, OWNER);
    assert.equal(page.updatedBy, 'agent');

    const child = await call(meta, 'create_page', { parentId: page.id, title: 'Child' });
    assert.equal(child.body.page.workspaceId, 'ws-b');
    assert.equal(child.body.page.parentId, page.id);
    const mismatch = await call(meta, 'create_page', { parentId: page.id, workspaceId: 'ws-a', title: 'Elsewhere' });
    assert.ok(mismatch.isError);

    const system = await call(meta, 'create_page', { workspaceId: assistant.workspaceId, title: 'Hidden' });
    assert.ok(system.isError);
    assert.match((await call(meta, 'create_page', { title: 'Nowhere' })).text, /workspaceId/);
  });

  test('a Space says who made it: a person, the Meta agent\'s chat or an ordinary conversation', async () => {
    const byPerson = createPage({ workspaceId: 'ws-b', ownerUserId: OWNER, title: 'Mine' });
    const byMeta = await call(meta, 'create_page', { workspaceId: 'ws-b', title: '性能' });
    const byChat = await call(ordinary, 'create_page', { title: 'From a chat' });
    assert.equal(byMeta.isError || byChat.isError, false, `${byMeta.text} ${byChat.text}`);
    const createdBy = (workspaceId: string, id: string) => listSpaces(OWNER, { workspaceId }).items.find((space) => space.id === id)?.createdBy;
    assert.equal(createdBy('ws-b', byPerson.id), 'user');
    assert.equal(createdBy('ws-b', byMeta.body.page.id), 'meta-agent');
    assert.equal(createdBy('ws-a', byChat.body.page.id), 'agent');
    // A later edit by someone else does not change who made it.
    await call(meta, 'edit_page', { pageId: byPerson.id, ops: [{ op: 'insert', after: null, block: { type: 'markdown', text: 'Agent text' } }] });
    assert.equal(createdBy('ws-b', byPerson.id), 'user');
  });

  test('the Meta agent reads and edits the Spaces Home by id; an ordinary chat cannot reach it', async () => {
    const homeId = ensureSpacesHomePageId(OWNER);
    const read = await call(meta, 'read_page', { pageId: homeId });
    assert.equal(read.isError, false, read.text);
    const edit = await call(meta, 'edit_page', { pageId: homeId, ops: [{ op: 'insert', after: null, block: { type: 'markdown', text: 'Global summary' } }] });
    assert.equal(edit.isError, false, edit.text);
    assert.equal(edit.body.michiPageWrite.appliedCount, 1);
    assert.ok((await call(ordinary, 'read_page', { pageId: homeId })).isError);
  });

  test('read_conversation_updates reads the named workspace, with its own cursor and navigation setting', async () => {
    completedTurn('n-b1', 'ws-b', 'b-1');
    completedTurn('n-a1', 'ws-a', 'a-1');
    completedTurn('n-a1', 'ws-a', 'a-2');

    const b = await call(meta, 'read_conversation_updates', { workspaceId: 'ws-b', after: 0 });
    assert.equal(b.isError, false, b.text);
    assert.deepEqual(b.body.turns.map((turn: { turnId: string }) => turn.turnId), ['b-1']);
    const a = await call(meta, 'read_conversation_updates', { workspaceId: 'ws-a', after: 0 });
    assert.deepEqual(a.body.turns.map((turn: { turnId: string }) => turn.turnId), ['a-1', 'a-2']);

    assert.match((await call(meta, 'read_conversation_updates', { after: 0 })).text, /workspaceId is required/);
    assert.match((await call(meta, 'read_conversation_updates', { workspaceId: assistant.workspaceId, after: 0 })).text, /not_found/);
    assert.match((await call(meta, 'read_conversation_updates', { workspaceId: 't-x', after: 0 })).text, /thread or node id/);
    setAiGlobalContext('ws-b', false);
    const off = await call(meta, 'read_conversation_updates', { workspaceId: 'ws-b', after: 0 });
    assert.ok(off.isError);
    assert.match(off.text, /navigation_disabled/);
    assert.doesNotMatch(off.text, /input b-1/);

    // An ordinary chat reads its own workspace whatever it names.
    const own = await call(ordinary, 'read_conversation_updates', { workspaceId: 'ws-b', after: 0 });
    assert.deepEqual(own.body.turns.map((turn: { turnId: string }) => turn.turnId), ['a-1', 'a-2']);
  });

  test('start_conversation opens an ordinary conversation on the global settings, never the Meta agent\'s', async () => {
    updateAgentConfig({ runtime: 'codex', modelByRuntime: { codex: 'codex-global-model' } });
    updateMetaAgentSettings({ runtimeId: 'claude', modelId: 'meta-model' });
    const page = createPage({ workspaceId: 'ws-b', ownerUserId: OWNER, title: 'Beta plan' });
    const h = harness();
    const questions: string[] = [];
    const result = await startConversationTool(
      { ownerUserId: null, workspaceId: assistant.workspaceId, nodeId: assistant.nodeId },
      { workspaceId: 'ws-b', text: 'Run the transaction rollback tests\nand report failures.', pageId: page.id },
      async (request) => { questions.push(`${request.targetTitle} in ${request.targetWorkspaceName}: ${request.text}`); return { approved: true }; },
      h.deps,
    );
    assert.equal(result.isError, undefined, result.content[0].text);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.status, 'started');
    const { conversation } = body;
    assert.equal(conversation.kind, 'michiConversationStart');
    assert.equal(conversation.workspaceId, 'ws-b');
    assert.equal(conversation.title, 'Run the transaction rollback tests');
    assert.equal(conversation.runtimeId, 'codex');
    assert.equal(conversation.startedFromPageId, page.id);
    assert.match(questions[0], /^New conversation · Run the transaction rollback tests in Project ws-b: Run the transaction/);

    const node = getNode(conversation.nodeId)!;
    assert.equal(node.workspace_id, 'ws-b');
    assert.equal(node.kind, 'chat');
    assert.equal(node.runtime_id, 'codex');
    assert.equal(node.model_id, 'codex-global-model');
    assert.deepEqual(h.ensured, [{ ownerUserId: OWNER, workspaceId: 'ws-b', nodeId: conversation.nodeId }]);
    assert.equal(h.started.length, 1);
    assert.equal(h.started[0].nodeId, conversation.nodeId);
    assert.equal(h.started[0].text, 'Run the transaction rollback tests\nand report failures.');
    assert.equal(h.started[0].displayText, h.started[0].text, 'the first message is a visible user message');
    assert.equal(h.started[0].userMetadata, undefined, 'an ordinary input, so conversation updates count it');
    assert.deepEqual(listPageProgressCards(page.id, OWNER).map((card) => card.threadNodeId), [conversation.nodeId]);
  });

  test('start_conversation asks first, and refuses system workspaces and other callers', async () => {
    const h = harness();
    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number }).n;
    const declined = await startConversationTool(
      { ownerUserId: null, workspaceId: assistant.workspaceId, nodeId: assistant.nodeId },
      { workspaceId: 'ws-b', text: 'hi' }, async () => ({ approved: false, reason: 'declined' }), h.deps);
    assert.equal(JSON.parse(declined.content[0].text).status, 'declined');

    const approve = async () => ({ approved: true as const });
    const system = await startConversationTool({ ownerUserId: null, workspaceId: assistant.workspaceId, nodeId: assistant.nodeId },
      { workspaceId: assistant.workspaceId, text: 'hi' }, approve, h.deps);
    assert.match(system.content[0].text, /^NOT_FOUND/);
    const ordinaryCaller = await startConversationTool({ ownerUserId: null, workspaceId: 'ws-a', nodeId: 'n-a1' },
      { workspaceId: 'ws-b', text: 'hi' }, approve, h.deps);
    assert.match(ordinaryCaller.content[0].text, /^UNSUPPORTED/);
    getDb().prepare('UPDATE workspaces SET archived_at = 5 WHERE id = ?').run('ws-b');
    const archived = await startConversationTool({ ownerUserId: null, workspaceId: assistant.workspaceId, nodeId: assistant.nodeId },
      { workspaceId: 'ws-b', text: 'hi' }, approve, h.deps);
    assert.match(archived.content[0].text, /^READ_ONLY/);

    assert.equal(h.started.length, 0);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number }).n, before);
  });

  test('start_conversation through the slot asks in the chat window and leaves no thread when the session fails', async () => {
    const h = harness();
    h.deps.ensureSession = async () => { throw new Error('runtime down'); };
    configureThreadMessaging(h.deps);
    try {
      const questions: string[] = [];
      const slot = slotFor(assistant.nodeId, assistant.workspaceId, { restricted: true },
        async (qs) => { questions.push(qs[0].question); return { [qs[0].question]: 'Send' }; });
      const before = (getDb().prepare('SELECT COUNT(*) AS n FROM trees').get() as { n: number }).n;
      const failed = await call(slot, 'start_conversation', { workspaceId: 'ws-b', text: 'Run it' });
      assert.ok(failed.isError);
      assert.match(failed.text, /runtime down/);
      assert.match(questions[0], /"New conversation · Run it" in Project ws-b\?/);
      assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM trees').get() as { n: number }).n, before);
    } finally {
      configureThreadMessaging(null);
    }
  });
});
