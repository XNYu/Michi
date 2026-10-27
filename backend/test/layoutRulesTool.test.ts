/**
 * The chat window's layout_rules tool: the owner, workspace and turn checks
 * of a page write, the user's message as the rule's source, and read_page
 * listing a page's rules.
 */

import './isolatedConfigDir';
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureAssistant } from '../src/assistant/store';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { closeDb, getDb, initDb } from '../src/services/db';
import { saveNode, saveTree, saveWorkspace } from '../src/services/dbRepository';
import { McpSlotRegistry, buildMcpServerForSlot, type McpSlot } from '../src/services/mcpServer';
import { createPage } from '../src/services/pages/repository';
import { ensureSpacesHomePageId } from '../src/services/pages/homePages';
import { listLayoutRules, saveLayoutPreferences } from '../src/services/pages/layoutRules';

const OWNER = LOCAL_AGENT_OWNER_ID;

function seedWorkspace(id: string, owner: string | null = null): void {
  saveWorkspace({ id, name: `Project ${id}`, cwd: `/tmp/${id}`, created_at: 1, updated_at: 1, settings: null });
  if (owner) getDb().prepare('UPDATE workspaces SET owner_user_id=? WHERE id=?').run(owner, id);
}

function seedChat(id: string, workspaceId: string): void {
  saveTree({ id: `t-${id}`, workspace_id: workspaceId, root_node_id: id, last_active_at: 1, created_at: 1 });
  saveNode({ id, workspace_id: workspaceId, tree_id: `t-${id}`, kind: 'chat', title: `Title ${id}`, status: 'idle',
    minimized: 0, spawned_by_agent: 0, acp_session_id: id, runtime_id: 'claude', created_at: 1 });
}

function activeTurn(nodeId: string, turnId: string, assistantId: string, userMessageId: string | null = null): void {
  getDb().prepare("INSERT INTO turns(turn_id,node_id,user_message_id,assistant_message_id,status,started_at,updated_at) VALUES (?,?,?,?,'active',1,1)")
    .run(turnId, nodeId, userMessageId, assistantId);
}

function slotFor(nodeId: string, workspaceId: string, extra: Record<string, unknown> = {}): McpSlot {
  return new McpSlotRegistry().create(nodeId, '/tmp', null, {
    owner: { mode: 'interactive', key: nodeId },
    onSpawnBranches: async () => [],
    onSaveArtifact: () => null,
    onUpdateArtifact: () => null,
    ...extra,
  } as never, { nodeId, workspaceId });
}

type Registered = Record<string, { handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }>;
const tools = (slot: McpSlot): Registered => (buildMcpServerForSlot(slot) as any)._registeredTools;

async function call(slot: McpSlot, name: string, args: Record<string, unknown> = {}) {
  const tool = tools(slot)[name];
  assert.ok(tool, `${name} is registered`);
  const result = await tool.handler(args, {});
  const text = result.content.map((part) => part.text).join('');
  let body: any;
  try { body = JSON.parse(text); } catch { body = undefined; }
  return { text, body, isError: result.isError === true };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-layout-rules-'));
  process.env.MICHI_DATA_DIR = tmpDir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  seedWorkspace('ws-a');
  seedWorkspace('ws-x', 'someone-else');
  seedChat('n-a1', 'ws-a');
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('the chat window layout_rules tool', () => {
  let assistant: ReturnType<typeof ensureAssistant>;
  let meta: McpSlot;

  beforeEach(() => {
    assistant = ensureAssistant();
    activeTurn(assistant.nodeId, 'meta-turn', 'meta-assistant', 'meta-user');
    activeTurn('n-a1', 'a-turn', 'a-assistant');
    meta = slotFor(assistant.nodeId, assistant.workspaceId, {
      restricted: true, getActivePageTurnAttribution: () => ({ turnId: 'meta-turn', assistantId: 'meta-assistant' }),
    });
  });

  test('adds a Stalled limit on the Spaces Home from the user\'s message, lists it and removes it', async () => {
    const home = ensureSpacesHomePageId(OWNER);
    const added = await call(meta, 'layout_rules', { action: 'add', pageId: home, text: 'Stalled: only the last 3 days', section: 'stalled', maxAgeDays: 3 });
    assert.equal(added.isError, false, added.text);
    assert.deepEqual(added.body.added.sectionLimit, { section: 'stalled', maxAgeDays: 3 });
    assert.match(added.body.next, /Michi now lists Stalled/);
    const [stored] = listLayoutRules(home, OWNER);
    assert.equal(stored.createdBy, 'agent');
    assert.deepEqual(stored.sourceMessage, { nodeId: assistant.nodeId, turnId: 'meta-turn', messageId: 'meta-user' });
    assert.equal(getDb().prepare('SELECT updated_by FROM pages WHERE id=?').get(home)!.updated_by, 'agent');

    const listed = await call(meta, 'layout_rules', { action: 'list', pageId: home });
    assert.deepEqual(listed.body.layoutRules.map((rule: { id: string }) => rule.id), [stored.id]);
    assert.equal(listed.body.page.id, home);

    const removed = await call(meta, 'layout_rules', { action: 'remove', pageId: home, ruleId: stored.id });
    assert.equal(removed.isError, false, removed.text);
    assert.deepEqual(removed.body.layoutRules, []);
    assert.ok((await call(meta, 'layout_rules', { action: 'remove', pageId: home, ruleId: stored.id })).text.includes('Layout rule not found'));
  });

  test('a text rule on a workspace page asks for the blocks to be re-laid out; read_page lists it', async () => {
    const page = createPage({ workspaceId: 'ws-a', ownerUserId: OWNER, title: 'Release' });
    const added = await call(meta, 'layout_rules', { action: 'add', pageId: page.id, text: 'Progress: at most 3 items' });
    assert.equal(added.isError, false, added.text);
    assert.match(added.body.next, /edit_page/);
    const preferences = saveLayoutPreferences({ pageId: page.id, ownerUserId: OWNER, text: 'Put risks first', expectedRevision: 0, actor: 'user' });
    const read = await call(meta, 'read_page', { pageId: page.id });
    assert.deepEqual(read.body.layoutRules, [{ id: added.body.added.id, text: 'Progress: at most 3 items' }]);
    assert.deepEqual(read.body.layoutPreferences, preferences);
    assert.ok(Array.isArray(read.body.blocks));
    const limited = await call(meta, 'layout_rules', { action: 'add', pageId: page.id, text: 'Stalled 3 days', section: 'stalled', maxAgeDays: 3 });
    assert.ok(limited.isError);
    assert.match(limited.text, /Only the Spaces Home/);
  });

  test('arguments are checked before anything is read or written', async () => {
    const home = ensureSpacesHomePageId(OWNER);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ action: 'add', pageId: home }, /text is required/],
      [{ action: 'add', pageId: home, text: 'x', maxAgeDays: 3 }, /section is required/],
      [{ action: 'add', pageId: home, text: 'x', section: 'stalled' }, /sets maxAgeDays, maxItems or both/],
      [{ action: 'add', pageId: home, text: 'x', section: 'stalled', maxItems: 9 }, /maxItems/],
      [{ action: 'remove', pageId: home }, /ruleId is required/],
      [{ action: 'rename', pageId: home }, /action/],
    ];
    for (const [args, message] of cases) {
      const result = await call(meta, 'layout_rules', args);
      assert.ok(result.isError, JSON.stringify(args));
      assert.match(result.text, message);
    }
    assert.deepEqual(listLayoutRules(home, OWNER), []);
  });

  test('writes need the window\'s active turn and a writable workspace; another owner\'s page reads as missing', async () => {
    const page = createPage({ workspaceId: 'ws-a', ownerUserId: OWNER, title: 'Release' });
    const noTurn = slotFor(assistant.nodeId, assistant.workspaceId, { restricted: true, getActivePageTurnAttribution: () => null });
    assert.match((await call(noTurn, 'layout_rules', { action: 'add', pageId: page.id, text: 'x' })).text, /no active owning chat turn/);
    assert.equal((await call(noTurn, 'layout_rules', { action: 'list', pageId: page.id })).isError, false, 'listing needs no turn');

    getDb().prepare('UPDATE workspaces SET archived_at=5 WHERE id=?').run('ws-a');
    assert.match((await call(meta, 'layout_rules', { action: 'add', pageId: page.id, text: 'x' })).text, /read-only/);
    assert.deepEqual(listLayoutRules(page.id, OWNER), []);

    const theirs = createPage({ workspaceId: 'ws-x', ownerUserId: 'someone-else', title: 'Theirs' });
    const denied = await call(meta, 'layout_rules', { action: 'list', pageId: theirs.id });
    assert.ok(denied.isError);
    assert.match(denied.text, /Page not found/);
  });

  test('an ordinary chat never gets the tool', () => {
    const ordinary = slotFor('n-a1', 'ws-a', { getActivePageTurnAttribution: () => ({ turnId: 'a-turn', assistantId: 'a-assistant' }) });
    assert.equal(tools(ordinary).layout_rules, undefined);
  });
});
