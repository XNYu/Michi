import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, test } from 'node:test';
import express from 'express';
import {
  AgentRunCompletionMode,
  AgentRunEventType,
  AgentRunStatus,
  type CreateAgentDefinitionRequestV1,
  type EffectiveAgentDefinitionV1,
} from 'michi-shared';
import { setupAdminRoutes } from '../src/routes/admin';
import { setupBackupRoutes, type BackupPayload } from '../src/routes/backup';
import { AgentDefinitionsRepository } from '../src/services/agentDefinitionsRepository';
import { AgentRunAdministrativeLifecycle } from '../src/services/agentRunAdministrativeLifecycle';
import { AgentRunsRepository } from '../src/services/agentRunsRepository';
import { closeAuditDb, closeDb, getAuditDb, getDb, initDb } from '../src/services/db';

const hash = 'b'.repeat(64);
let dataDir: string;
let server: ReturnType<typeof express.application.listen>;
let baseUrl: string;

function containsHostAbsolutePath(value: unknown): boolean {
  if (typeof value === 'string') return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
  if (Array.isArray(value)) return value.some(containsHostAbsolutePath);
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).some(containsHostAbsolutePath);
  return false;
}

function definition(scope: 'global' | 'workspace', workspaceId: string | null): CreateAgentDefinitionRequestV1 {
  return {
    version: 1, scope, workspaceId, name: `${scope} backup worker`, description: '', instructions: 'Work.',
    runtimeProfile: { version: 1, runtimeId: 'pi', providerId: 'provider', modelId: 'model' }, fallbackChain: [],
    toolRefs: [], skillRefs: [], mcpServerRefs: [], permissionPolicy: null,
    contextPolicy: { version: 1, includeWorkspaceInstructions: true, allowMessageContext: true,
      allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 10_000 }, defaultRunTtlMs: null,
  };
}

function effective(): EffectiveAgentDefinitionV1 {
  return {
    version: 1, name: 'Backup worker', description: 'Backup fixture', instructions: 'Work.',
    runtimeProfile: { version: 1, runtimeId: 'pi', providerId: 'provider', modelId: 'model' }, fallbackChain: [],
    capabilitySnapshot: { version: 1, entries: [] },
    permissionPolicy: { version: 1, preset: 'research', categories: {}, maxDelegationDepth: 0,
      maxConcurrentRuns: 1, maxWallTimeMs: 60_000, maxAttempts: 1 },
    contextPolicy: { version: 1, includeWorkspaceInstructions: true, allowMessageContext: true,
      allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 10_000 },
  };
}

function createAuthUser(id: string): void {
  const db = new DatabaseSync(path.join(dataDir, 'auth.sqlite'));
  db.exec(`
    CREATE TABLE "user" (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE "session" (id TEXT PRIMARY KEY, "userId" TEXT NOT NULL);
    CREATE TABLE "account" (id TEXT PRIMARY KEY, "userId" TEXT NOT NULL);
  `);
  db.prepare('INSERT INTO "user" (id,email,name,created_at) VALUES (?,?,?,1)').run(id, `${id}@example.com`, id);
  db.close();
}

function seedOwner(ownerUserId = 'owner-a'): { runId: string } {
  getDb().prepare('INSERT INTO workspaces (id,name,cwd,folders,settings,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?,1,1)')
    .run('ws-a', 'Workspace', '/source/workspace', JSON.stringify([
      { id: 'folder-source', path: '/Users/source/project', label: 'Project', addedAt: 1 },
    ]), JSON.stringify({ sessionToken: 'workspace-session-secret', repository: '/Users/source/repository' }), ownerUserId);
  getDb().prepare(`INSERT INTO nodes
    (id,workspace_id,kind,status,minimized,spawned_by_agent,created_at)
    VALUES ('node-source','ws-a','chat','idle',0,0,1)`).run();
  getDb().prepare(`INSERT INTO messages
    (id,node_id,role,content,tool_calls,metadata,seq,created_at)
    VALUES ('message-source','node-source','assistant','safe',?,?,0,1)`).run(
      JSON.stringify({ authToken: 'message-auth-secret', directory: '/private/message-directory' }),
      JSON.stringify({ token: 'message-token-secret' }),
    );
  const definitions = new AgentDefinitionsRepository({ createId: (() => { let index = 0; return () => `definition-${++index}`; })() });
  definitions.create(ownerUserId, definition('global', null), 'global-op');
  definitions.create(ownerUserId, definition('workspace', 'ws-a'), 'workspace-op');
  const runs = new AgentRunsRepository({ now: () => 10, createId: (kind) => `${kind}-backup-admin` });
  const run = runs.createRun({
    operationId: 'run-op', ownerUserId, workspaceId: 'ws-a', definitionId: null, definitionRevision: null,
    effectiveDefinition: effective(), invocationMode: 'manual', completionMode: AgentRunCompletionMode.Detach,
    parentRunId: null, parentAttemptId: null, parentNodeId: null, parentTurnId: null,
    parentMessageId: null, parentToolCallId: null, task: 'Persist me',
    contextManifest: { version: 1, entries: [{ kind: 'file', workspacePath: '/Users/source/note.txt',
      snapshotPath: '/private/snapshot/note.txt', size: 1, sha256: hash }], assembledAt: 1, estimatedChars: 1 },
    expectedResult: null, executionEnvironment: { version: 1, kind: 'git_worktree', cwd: '/private/worktree',
      sourceWorkspaceId: 'ws-a', baseCommit: 'abc', snapshotHash: hash, createdAt: 1 }, expiresAt: null,
    initialEvent: { type: AgentRunEventType.RunStatusChanged, payload: { version: 1, from: null, to: AgentRunStatus.Queued } },
  });
  getDb().prepare(`UPDATE agent_runs SET status = 'running', started_at = 10,
    lease_token = 'lease-secret', lease_owner = 'worker', lease_expires_at = 999 WHERE id = ?`).run(run.id);
  getDb().prepare(`INSERT INTO agent_run_events (run_id, seq, attempt_id, type, payload, created_at)
    VALUES (?, 1, NULL, 'tool_call', ?, 11)`).run(run.id, JSON.stringify({
      version: 1,
      sessionToken: 'session-secret-value',
      authToken: 'auth-secret-value',
      repository: '/Users/source/private-repository',
      directory: '/private/run-directory',
    }));
  getDb().prepare('UPDATE agent_runs SET latest_event_seq = 1 WHERE id = ?').run(run.id);
  getDb().prepare(`INSERT INTO contexts
    (id, workspace_id, name, file_path, auto_inject, source, url, created_at, updated_at)
    VALUES ('context-source','ws-a','Source file','/Users/source/context.txt',0,'user',
      'https://example.com/file?token=signed-secret#private',1,1)`).run();
  return { runId: run.id };
}

async function request(method: string, route: string, body?: unknown, owner = 'owner-a') {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': owner },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, body: await response.json() as any };
}

function startApp(lifecycle?: AgentRunAdministrativeLifecycle): void {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.user = { id: req.header('x-test-user') ?? 'owner-a', email: 'admin@example.com' }; next(); });
  app.use('/api', setupBackupRoutes());
  app.use('/api/admin', setupAdminRoutes({ agentRunLifecycle: lifecycle }));
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('Custom Agent backup and administration routes', () => {
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-agent-backup-admin-'));
    process.env.MICHI_DATA_DIR = dataDir;
    process.env.MICHI_CLOUD = '1';
    closeDb(); closeAuditDb(); initDb();
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb(); closeAuditDb();
    delete process.env.MICHI_DATA_DIR;
    delete process.env.MICHI_CLOUD;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('exports v2 owner/workspace Agent fragments and accepts legacy v1 imports', async () => {
    seedOwner();
    startApp();
    const full = await request('GET', '/api/backup/export');
    assert.equal(full.response.status, 200);
    assert.equal(full.body.version, 2);
    assert.equal(full.body.agents.scope, 'owner_full');
    assert.equal(full.body.agents.definitions.length, 2);
    assert.equal(containsHostAbsolutePath(full.body), false);
    const encoded = JSON.stringify(full.body);
    for (const forbidden of ['lease-secret', 'session-secret-value', 'auth-secret-value', 'workspace-session-secret',
      'message-auth-secret', 'message-token-secret', 'signed-secret', 'sessionToken', 'authToken']) {
      assert.equal(encoded.includes(forbidden), false, `${forbidden} must not be exported`);
    }
    assert.equal(full.body.workspaces[0].workspace.cwd, null);
    assert.equal(full.body.workspaces[0].workspace.folders, '[]');
    assert.equal(full.body.workspaces[0].contexts[0].file_path, 'context.txt');
    assert.equal(full.body.agents.runs[0].contextManifest.entries[0].workspacePath, 'note.txt');

    const workspace = await request('GET', '/api/backup/export/ws-a');
    assert.equal(workspace.body.agents.scope, 'workspace');
    assert.deepEqual(workspace.body.agents.definitions.map((item: any) => item.scope), ['workspace']);

    const legacy: BackupPayload = { version: 1, exportedAt: 1, app: 'michi', workspaces: [] };
    const imported = await request('POST', '/api/backup/import', legacy);
    assert.equal(imported.response.status, 200);
    assert.deepEqual(imported.body, { imported: true, workspaceCount: 0, importedDefinitions: 0,
      importedRuns: 0, workspaceIds: {} });

    const adversarial = structuredClone(full.body);
    adversarial.agents.events[1].payload = {
      version: 1,
      sessionToken: 'crafted-session-token',
      authToken: 'crafted-auth-token',
      repository: '/Users/attacker/repository',
      directory: '/private/attacker-directory',
    };
    adversarial.agents.runs[0].contextManifest.entries[0].workspacePath = '/Users/attacker/context.txt';
    adversarial.agents.runs[0].effectiveDefinition.runtimeProfile.options = {
      sessionToken: 'crafted-runtime-token', directory: '/private/runtime-directory',
    };
    adversarial.agents.definitions[0].runtimeProfile.options = {
      authToken: 'crafted-definition-token', repository: '/Users/attacker/definition-repository',
    };
    const restored = await request('POST', '/api/backup/import', adversarial);
    assert.equal(restored.response.status, 200, JSON.stringify(restored.body));
    const importedWorkspaceId = restored.body.workspaceIds['ws-a'];
    assert.notEqual(importedWorkspaceId, 'ws-a');
    const importedRun = getDb().prepare(`SELECT id, status, lease_token, active_attempt_id, execution_environment
      FROM agent_runs WHERE workspace_id = ?`).get(importedWorkspaceId) as {
        id: string; status: string; lease_token: string | null; active_attempt_id: string | null;
        execution_environment: string;
      };
    assert.equal(importedRun.status, 'failed');
    assert.equal(importedRun.lease_token, null);
    assert.equal(importedRun.active_attempt_id, null);
    assert.equal(JSON.parse(importedRun.execution_environment).cwd, '.');
    const importedContext = JSON.parse((getDb().prepare('SELECT context_manifest FROM agent_runs WHERE id = ?')
      .get(importedRun.id) as { context_manifest: string }).context_manifest);
    assert.equal(importedContext.entries[0].workspacePath, 'context.txt');
    const storedAgentPayload = JSON.stringify({
      definitions: getDb().prepare('SELECT runtime_profile FROM agent_definitions WHERE owner_user_id = ?').all('owner-a'),
      events: getDb().prepare('SELECT payload FROM agent_run_events WHERE run_id = ?').all(importedRun.id),
      run: getDb().prepare('SELECT effective_definition, context_manifest FROM agent_runs WHERE id = ?').get(importedRun.id),
    });
    for (const forbidden of ['crafted-session-token', 'crafted-auth-token', 'crafted-runtime-token',
      'crafted-definition-token', '/Users/attacker', '/private/attacker', '/private/runtime']) {
      assert.equal(storedAgentPayload.includes(forbidden), false, `${forbidden} must not be imported`);
    }
    const claim = new AgentRunsRepository().claimRun('owner-a', importedRun.id, 'attacker-worker',
      'attacker-lease', Date.now() + 60_000, 2);
    assert.equal(claim, null, 'an imported Run must never become claimable');
  });

  test('import remaps the full graph and cannot overwrite another owner through colliding IDs', async () => {
    getDb().prepare(`INSERT INTO workspaces (id,name,cwd,owner_user_id,created_at,updated_at)
      VALUES ('victim-ws','Victim','/victim/private','owner-b',1,1)`).run();
    getDb().prepare(`INSERT INTO nodes
      (id,workspace_id,kind,status,minimized,spawned_by_agent,created_at)
      VALUES ('victim-node','victim-ws','chat','idle',0,0,1)`).run();
    startApp();
    const payload: BackupPayload = {
      version: 1,
      exportedAt: 1,
      app: 'michi',
      workspaces: [{
        workspace: { id: 'victim-ws', name: 'Imported', cwd: '/source/private', folders: JSON.stringify([
          { id: 'folder', path: '/source/folder', label: 'Source', addedAt: 1 },
        ]), active_tree_id: 'tree-source', created_at: 1, updated_at: 1, owner_user_id: 'owner-b' },
        trees: [{ id: 'tree-source', workspace_id: 'victim-ws', root_node_id: 'node-root',
          last_active_at: 1, created_at: 1 }],
        nodes: [
          { id: 'node-root', workspace_id: 'victim-ws', tree_id: 'tree-source', parent_node_id: null,
            kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 },
          { id: 'node-child', workspace_id: 'victim-ws', tree_id: 'tree-source', parent_node_id: 'node-root',
            follow_ups_source_message_id: 'message-source', kind: 'chat', status: 'idle', minimized: 0,
            spawned_by_agent: 0, created_at: 1 },
        ],
        edges: [{ id: 'edge-source', workspace_id: 'victim-ws', source_node_id: 'node-root',
          target_node_id: 'node-child', kind: 'branch', anchor_message_id: 'message-source', created_at: 1 }],
        messages: [{ id: 'message-source', node_id: 'node-root', role: 'user', content: 'hello', seq: 0, created_at: 1 }],
        contexts: [{ id: 'context-source', workspace_id: 'victim-ws', name: 'File',
          file_path: '/source/context.txt', auto_inject: 0, source: 'user', origin_node_id: 'node-root',
          origin_message_id: 'message-source', created_at: 1, updated_at: 1 }],
      }],
    };

    const imported = await request('POST', '/api/backup/import', payload, 'owner-a');
    assert.equal(imported.response.status, 200, JSON.stringify(imported.body));
    const workspaceId = imported.body.workspaceIds['victim-ws'];
    assert.notEqual(workspaceId, 'victim-ws');
    const victim = getDb().prepare('SELECT name, owner_user_id FROM workspaces WHERE id = ?').get('victim-ws') as {
      name: string; owner_user_id: string;
    };
    assert.equal(victim.name, 'Victim');
    assert.equal(victim.owner_user_id, 'owner-b');
    const importedWorkspace = getDb().prepare('SELECT cwd, folders, owner_user_id, active_tree_id FROM workspaces WHERE id = ?')
      .get(workspaceId) as { cwd: string | null; folders: string; owner_user_id: string; active_tree_id: string };
    assert.equal(importedWorkspace.cwd, null);
    assert.equal(importedWorkspace.folders, '[]');
    assert.equal(importedWorkspace.owner_user_id, 'owner-a');
    assert.notEqual(importedWorkspace.active_tree_id, 'tree-source');
    const tree = getDb().prepare('SELECT id, root_node_id FROM trees WHERE workspace_id = ?').get(workspaceId) as { id: string; root_node_id: string };
    const nodes = getDb().prepare('SELECT id, parent_node_id, follow_ups_source_message_id FROM nodes WHERE workspace_id = ? ORDER BY parent_node_id IS NOT NULL')
      .all(workspaceId) as Array<{ id: string; parent_node_id: string | null; follow_ups_source_message_id: string | null }>;
    const message = getDb().prepare(`SELECT m.id, m.node_id FROM messages m JOIN nodes n ON n.id = m.node_id
      WHERE n.workspace_id = ?`).get(workspaceId) as { id: string; node_id: string };
    const edge = getDb().prepare('SELECT id, source_node_id, target_node_id, anchor_message_id FROM edges WHERE workspace_id = ?')
      .get(workspaceId) as { id: string; source_node_id: string; target_node_id: string; anchor_message_id: string };
    const context = getDb().prepare('SELECT id, file_path, origin_node_id, origin_message_id FROM contexts WHERE workspace_id = ?')
      .get(workspaceId) as { id: string; file_path: string; origin_node_id: string; origin_message_id: string };
    const root = nodes.find((node) => node.parent_node_id === null)!;
    const child = nodes.find((node) => node.parent_node_id !== null)!;
    assert.notEqual(tree.id, 'tree-source');
    assert.equal(tree.root_node_id, root.id);
    assert.equal(child.parent_node_id, root.id);
    assert.equal(child.follow_ups_source_message_id, message.id);
    assert.equal(edge.source_node_id, root.id);
    assert.equal(edge.target_node_id, child.id);
    assert.equal(edge.anchor_message_id, message.id);
    assert.equal(context.origin_node_id, root.id);
    assert.equal(context.origin_message_id, message.id);
    assert.equal(context.file_path, 'context.txt');
    for (const sourceId of ['tree-source', 'node-root', 'node-child', 'edge-source', 'message-source', 'context-source']) {
      assert.equal(JSON.stringify({ tree, nodes, edge, message, context }).includes(sourceId), false);
    }
  });

  test('backup import is rejected while the owner deletion gate is active', async () => {
    getDb().prepare(`INSERT INTO agent_owner_deletions
      (owner_user_id, deletion_token, lease_owner, started_at, expires_at)
      VALUES ('owner-a','deletion-token','admin-instance',?,?)`).run(Date.now(), Date.now() + 60_000);
    startApp();
    const payload: BackupPayload = { version: 1, exportedAt: 1, app: 'michi', workspaces: [] };
    const imported = await request('POST', '/api/backup/import', payload);
    assert.equal(imported.response.status, 409);
    assert.equal(imported.body.error, 'Agent owner data is being deleted');
  });

  test('backup import rejects graph references that cross Workspace boundaries', async () => {
    startApp();
    const payload: BackupPayload = {
      version: 1,
      exportedAt: 1,
      app: 'michi',
      workspaces: [{
        workspace: { id: 'source-ws', name: 'Source', created_at: 1, updated_at: 1 },
        trees: [],
        nodes: [{ id: 'foreign-node', workspace_id: 'different-ws', kind: 'chat', status: 'idle',
          minimized: 0, spawned_by_agent: 0, created_at: 1 }],
        edges: [],
        messages: [],
        contexts: [],
      }],
    };
    const imported = await request('POST', '/api/backup/import', payload);
    assert.equal(imported.response.status, 400);
    assert.match(imported.body.error, /belongs to a different Workspace/);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM workspaces').get() as { count: number }).count, 0);
  });

  test('admin export includes sanitized Agents and delete quiesces then reports retryable cleanup failures', async () => {
    createAuthUser('owner-a');
    const { runId } = seedOwner();
    const quiesced: string[] = [];
    const lifecycle = new AgentRunAdministrativeLifecycle({
      quiesceRun: async (_owner, id) => {
        quiesced.push(id);
        getDb().prepare(`UPDATE agent_runs SET status = 'cancelled', completed_at = 20,
          lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL WHERE id = ?`).run(id);
      },
      cleanupRun: async (_id, resources) => {
        assert.equal((resources.executionEnvironment as { cwd: string }).cwd, '/private/worktree');
        throw new Error('worktree busy');
      },
    });
    startApp(lifecycle);

    const exported = await request('POST', '/api/admin/users/owner-a/export');
    assert.equal(exported.response.status, 200);
    assert.equal(exported.body.agents.scope, 'owner_full');
    assert.equal(exported.body.agents.runs.length, 1);
    assert.equal(containsHostAbsolutePath(exported.body), false);
    const adminEncoded = JSON.stringify(exported.body);
    for (const forbidden of ['lease-secret', 'workspace-session-secret', 'message-auth-secret',
      'message-token-secret', 'sessionToken', 'authToken']) {
      assert.equal(adminEncoded.includes(forbidden), false, `${forbidden} must not appear in admin export`);
    }

    const deleted = await request('DELETE', '/api/admin/users/owner-a');
    assert.equal(deleted.response.status, 200);
    assert.deepEqual(quiesced, [runId]);
    assert.equal(deleted.body.deleted.agentRuns, 1);
    assert.deepEqual(deleted.body.cleanupFailures, [{ runId, message: 'worktree busy', retryable: true }]);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM agent_runs').get() as { count: number }).count, 0);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM agent_definitions').get() as { count: number }).count, 0);
    const audit = getAuditDb().prepare("SELECT metadata_json FROM audit_log WHERE action = 'admin.user.delete' ORDER BY id DESC LIMIT 1")
      .get() as { metadata_json: string };
    assert.deepEqual(JSON.parse(audit.metadata_json).agentCleanupFailures,
      [{ runId, message: 'worktree busy', retryable: true }]);
  });

  test('admin deletion refuses Agent rows without an injected lifecycle', async () => {
    createAuthUser('owner-a');
    seedOwner();
    startApp();
    const deleted = await request('DELETE', '/api/admin/users/owner-a');
    assert.equal(deleted.response.status, 503);
    assert.equal(deleted.body.error, 'agent_run_lifecycle_required');
    assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM workspaces').get() as { count: number }).count, 1);
  });
});
