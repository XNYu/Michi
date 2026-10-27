import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { deleteWorkspace, saveNode } from '../src/services/dbRepository';
import { createDatabase, createPage, deletePage, getDatabase, getPage, listPageTrash, listPages, listSpaces, purgePageDeletionGroup, purgeWorkspacePages, restorePageDeletionGroup, savePageContent, updatePageMetadata } from '../src/services/pages/repository';

let dir: string;
let oldData: string | undefined;
let oldCloud: string | undefined;
beforeEach(() => {
  oldData = process.env.MICHI_DATA_DIR;
  oldCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-pages-repository-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb(); initDb();
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('ws','Workspace','alice');
});
afterEach(() => {
  closeDb();
  if (oldData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldData;
  if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('creates databases with native views and preserves view metadata and config', () => {
  const views = [
    { id: 'table-view', name: 'All items', type: 'table' as const, position: 2, edit: { at: 42 }, config: { filters: [], match: 'all' as const, sorts: [], visible: ['name'] } },
    { id: 'board-view', name: 'By status', type: 'board' as const, position: 7, config: { filters: [], match: 'any' as const, sorts: [], group: 'status', visible: ['name', 'status'] } },
  ];
  const created = createDatabase({
    workspaceId: 'ws', ownerUserId: 'alice', title: 'Items', now: 50,
    columns: [{ id: 'name', name: 'Name', type: 'text' }, { id: 'status', name: 'Status', type: 'select', options: [{ value: 'todo' }] }],
    views,
  });

  assert.deepEqual(created.views, views);
  assert.deepEqual(getDatabase(created.id, 'alice').views, views);
});

test('creates nested template pages with revision snapshots, refs and owner-scoped space aggregates', () => {
  const root = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Release', template: 'release', now: 10 });
  const child = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Notes', parentId: root.id, now: 11 });
  const dbRef = root.blocks.find((block) => block.type === 'database-ref');
  assert.ok(dbRef && dbRef.type === 'database-ref');
  const updatedChild = { ...child, revision: child.revision + 1, blocks: [...child.blocks, { ...dbRef, id: 'shared-ref' }] };
  savePageContent(child.id, 'alice', updatedChild, { source: { kind: 'user' }, now: 12, expectedRevision: child.revision });
  assert.equal(getDatabase(dbRef.databaseId, 'alice').rows.length, 1);
  assert.equal(listPages('ws', 'alice', { parentId: root.id }).items[0]?.id, child.id);
  const space = listSpaces('alice', { workspaceId: 'ws' }).items[0];
  assert.equal(space?.pageCount, 2);
  assert.equal(space?.databaseCount, 1);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM page_revisions WHERE page_id=?').get(root.id)?.n, 1);
  const stale = { ...getPage(root.id, 'alice'), title: 'Changed' };
  assert.throws(() => updatePageMetadata(root.id, 'alice', { title: 'Changed' }, { expectedRevision: 99 }), /revision changed/);
  assert.equal(getPage(root.id, 'alice').title, 'Release');
  assert.throws(() => listPages('ws', 'bob'), /Workspace not found/);
  assert.equal(stale.id, root.id);
});

test('delete and restore preserve independently trashed children and shared databases', () => {
  const root = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Release', template: 'release', now: 20 });
  const child = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Child', parentId: root.id, now: 21 });
  const other = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Other', now: 22 });
  const ref = root.blocks.find((block) => block.type === 'database-ref');
  assert.ok(ref && ref.type === 'database-ref');
  savePageContent(other.id, 'alice', { ...other, revision: other.revision + 1, blocks: [...other.blocks, { ...ref, id: 'other-shared-ref' }] }, { source: { kind: 'user' }, now: 23 });
  const childGroup = deletePage(child.id, 'alice', { now: 24 });
  const rootGroup = deletePage(root.id, 'alice', { now: 25 });
  assert.equal(getDatabase(ref.databaseId, 'alice').revision, 1, 'database remains active because another page references it');
  assert.equal(listPageTrash('ws', 'alice').items.length, 2);
  restorePageDeletionGroup(rootGroup, 'alice', { now: 26 });
  assert.equal(getPage(root.id, 'alice').title, 'Release');
  assert.throws(() => getPage(child.id, 'alice'), /Page not found/);
  assert.ok(listPageTrash('ws', 'alice').items.some((group) => group.deletionGroupId === childGroup));
  assert.equal(listSpaces('alice', { workspaceId: 'ws' }).items[0]?.pageCount, 1);
  purgePageDeletionGroup(childGroup, 'alice');
  assert.throws(() => getPage(child.id, 'alice', { includeDeleted: true }), /Page not found/);
});

test('trash restores page helper bindings and helper chat as one deletion group', () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'With helper', now: 60 });
  getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,page_id) VALUES ('helper','ws','chat','idle',?)").run(page.id);
  getDb().prepare('UPDATE pages SET helper_node_id=? WHERE id=?').run('helper', page.id);
  const group = deletePage(page.id, 'alice', { now: 61 });
  const trashed = getDb().prepare("SELECT deleted_at,deletion_group_id,page_id FROM nodes WHERE id='helper'").get() as { deleted_at: number; deletion_group_id: string; page_id: string };
  assert.equal(trashed.deleted_at, 61);
  assert.equal(trashed.deletion_group_id, group);
  assert.equal(trashed.page_id, page.id);
  assert.equal(getPage(page.id, 'alice', { includeDeleted: true }).helperNodeId, 'helper');
  restorePageDeletionGroup(group, 'alice', { now: 62 });
  const restored = getDb().prepare("SELECT deleted_at,page_id FROM nodes WHERE id='helper'").get() as { deleted_at: number | null; page_id: string };
  assert.equal(restored.deleted_at, null);
  assert.equal(restored.page_id, page.id);
  const purgeGroup = deletePage(page.id, 'alice', { now: 63 });
  purgePageDeletionGroup(purgeGroup, 'alice');
  const purged = getDb().prepare("SELECT purged_at,page_id FROM nodes WHERE id='helper'").get() as { purged_at: number; page_id: string | null };
  assert.ok(purged.purged_at !== null);
  assert.equal(purged.page_id, null);
});

test('exclusive template databases restore with their group and purge with the page', () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Release', template: 'release', now: 70 });
  const ref = page.blocks.find((block) => block.type === 'database-ref');
  assert.ok(ref && ref.type === 'database-ref');
  const first = deletePage(page.id, 'alice', { now: 71 });
  assert.throws(() => getDatabase(ref.databaseId, 'alice'), /Database not found/);
  restorePageDeletionGroup(first, 'alice', { now: 72 });
  assert.equal(getDatabase(ref.databaseId, 'alice').id, ref.databaseId);
  const second = deletePage(page.id, 'alice', { now: 73 });
  purgePageDeletionGroup(second, 'alice');
  assert.throws(() => getDatabase(ref.databaseId, 'alice', { includeDeleted: true }), /Database not found/);
});

test('workspace purge accepts a deleted workspace and clears its native records with owner checks', () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Workspace page', now: 80 });
  getDb().prepare("INSERT INTO page_component_libraries(workspace_id,owner_user_id,revision,updated_at) VALUES ('ws','alice',1,80)").run();
  getDb().prepare("INSERT INTO page_components(id,owner_user_id,workspace_id,name,description,enabled,active_version,latest_version,library_revision,created_at,updated_at) VALUES ('cmp','alice','ws','Chart','',1,1,1,1,80,80)").run();
  getDb().prepare("INSERT INTO scheduled_jobs(id,owner_user_id,workspace_id,name,prompt,schedule,created_at,updated_at) VALUES ('job','alice','ws','Maintenance','prompt','{\"kind\":\"every\"}',80,80)").run();
  getDb().prepare("INSERT INTO page_maintenance_configs(workspace_id,owner_user_id,job_id,completion_cursor,updated_at) VALUES ('ws','alice','job',0,80)").run();
  getDb().prepare("INSERT INTO page_maintenance_exclusions(workspace_id,owner_user_id,space_id,excluded_at) VALUES ('ws','alice',?,80)").run(page.id);
  getDb().prepare("INSERT INTO page_maintenance_plans(id,workspace_id,owner_user_id,job_id,config_revision,generation,after_seq,through_seq,state,created_at,updated_at) VALUES ('plan','ws','alice','job',1,1,0,0,'terminal',80,80)").run();
  getDb().prepare("INSERT INTO page_maintenance_sources(plan_id,source_turn_id,completion_seq,evidence_json,manifest_json,state,routing_complete,candidates_json,updated_at) VALUES ('plan','turn',1,'[]','[]','terminal',1,'[]',80)").run();
  getDb().prepare(`INSERT INTO page_maintenance_receipts(receipt_key,plan_id,job_id,source_turn_id,resource_kind,resource_id,generation,payload_hash,payload_json,assigned_ids_json,result_json,outcome,execution_json,evidence_json,committed_at)
    VALUES ('receipt','plan','job','turn','page',?,1,?, '{}','{}','{}','written','{}','[]',80)`).run(page.id, 'a'.repeat(64));
  getDb().prepare('UPDATE workspaces SET deleted_at=81,archived_at=80 WHERE id=?').run('ws');
  assert.throws(() => purgeWorkspacePages('ws', 'bob'), /Workspace not found/);
  assert.equal(purgeWorkspacePages('ws', 'alice'), 1);
  assert.throws(() => getPage(page.id, 'alice', { includeDeleted: true }), /Page not found/);
  for (const [table, field] of [['pages','workspace_id'], ['page_databases','workspace_id'], ['page_components','workspace_id'], ['page_component_libraries','workspace_id'], ['page_maintenance_configs','workspace_id'], ['page_maintenance_exclusions','workspace_id'], ['page_maintenance_plans','workspace_id']] as const) {
    const result = getDb().prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${field}=?`).get('ws') as { count: number };
    assert.equal(result.count, 0, `${table} should be cleared`);
  }
  assert.equal((getDb().prepare("SELECT COUNT(*) AS count FROM page_maintenance_receipts WHERE job_id='job'").get() as { count: number }).count, 0);
  getDb().prepare("INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at,settings) VALUES ('system-ws','System','alice',1,1,'{\"system\":\"assistant\"}')").run();
  getDb().prepare("INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at,purged_at) VALUES ('purged-ws','Purged','alice',1,1,81)").run();
  assert.throws(() => purgeWorkspacePages('system-ws', 'alice'), /Workspace not found/);
  assert.throws(() => purgeWorkspacePages('purged-ws', 'alice'), /Workspace not found/);
});

test('deleteWorkspace purges native page state before tombstoning without reviving helper bindings', () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Release', template: 'release', now: 90 });
  const ref = page.blocks.find((block) => block.type === 'database-ref');
  assert.ok(ref && ref.type === 'database-ref');
  saveNode({
    id: 'workspace-helper', workspace_id: 'ws', tree_id: null, parent_node_id: null, kind: 'chat', title: 'Helper', status: 'idle',
    position_x: null, position_y: null, minimized: 0, deleted_at: null, deletion_group_id: null, spawned_by_agent: 0, current_mode_id: null,
    pane_width: null, digest: null, follow_ups: null, acp_session_id: null, runtime_id: null, provider_id: null, model_id: null,
    reasoning: null, resume_fingerprint: null, composer_draft: null, external_session_id: null, trim_snapshot: null, created_at: 90,
  });
  getDb().prepare("UPDATE nodes SET page_id=? WHERE id='workspace-helper'").run(page.id);
  getDb().prepare("UPDATE pages SET helper_node_id='workspace-helper' WHERE id=?").run(page.id);
  getDb().prepare("INSERT INTO page_component_libraries(workspace_id,owner_user_id,revision,updated_at) VALUES ('ws','alice',1,90)").run();
  getDb().prepare("INSERT INTO page_components(id,owner_user_id,workspace_id,name,description,enabled,active_version,latest_version,library_revision,created_at,updated_at) VALUES ('purge-component','alice','ws','Chart','',1,1,1,1,90,90)").run();
  getDb().prepare("INSERT INTO scheduled_jobs(id,owner_user_id,workspace_id,name,prompt,schedule,created_at,updated_at) VALUES ('purge-job','alice','ws','Maintenance','prompt','{\"kind\":\"every\"}',90,90)").run();
  getDb().prepare("INSERT INTO page_maintenance_configs(workspace_id,owner_user_id,job_id,completion_cursor,updated_at) VALUES ('ws','alice','purge-job',0,90)").run();
  getDb().prepare('UPDATE workspaces SET deleted_at=91 WHERE id=?').run('ws');

  deleteWorkspace('ws', 'alice');

  assert.ok((getDb().prepare("SELECT purged_at FROM workspaces WHERE id='ws'").get() as { purged_at: number }).purged_at !== null);
  assert.equal((getDb().prepare("SELECT COUNT(*) AS count FROM pages WHERE workspace_id='ws'").get() as { count: number }).count, 0);
  assert.equal((getDb().prepare("SELECT COUNT(*) AS count FROM page_databases WHERE workspace_id='ws'").get() as { count: number }).count, 0);
  assert.equal((getDb().prepare("SELECT COUNT(*) AS count FROM page_components WHERE workspace_id='ws'").get() as { count: number }).count, 0);
  assert.equal((getDb().prepare("SELECT COUNT(*) AS count FROM page_maintenance_configs WHERE workspace_id='ws'").get() as { count: number }).count, 0);
  assert.equal((getDb().prepare("SELECT COUNT(*) AS count FROM scheduled_jobs WHERE id='purge-job'").get() as { count: number }).count, 0);
  const tombstone = getDb().prepare("SELECT purged_at,page_id FROM nodes WHERE id='workspace-helper'").get() as { purged_at: number; page_id: string | null };
  assert.ok(tombstone.purged_at !== null);
  assert.equal(tombstone.page_id, null);
  saveNode({
    id: 'workspace-helper', workspace_id: 'ws', tree_id: null, parent_node_id: null, kind: 'chat', title: 'Stale helper', status: 'idle',
    position_x: null, position_y: null, minimized: 0, deleted_at: null, deletion_group_id: null, spawned_by_agent: 0, current_mode_id: null,
    pane_width: null, digest: null, follow_ups: null, acp_session_id: null, runtime_id: null, provider_id: null, model_id: null,
    reasoning: null, resume_fingerprint: null, composer_draft: null, external_session_id: null, trim_snapshot: null, created_at: 92,
  });
  const stillGone = getDb().prepare("SELECT purged_at,page_id FROM nodes WHERE id='workspace-helper'").get() as { purged_at: number; page_id: string | null };
  assert.ok(stillGone.purged_at !== null);
  assert.equal(stillGone.page_id, null);
});
