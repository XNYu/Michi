import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentDefinitionStatus, type CreateAgentDefinitionRequestV1 } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { AgentCapabilityCatalog } from '../src/services/agentCapabilityCatalog';
import { AgentDefinitionsRepository } from '../src/services/agentDefinitionsRepository';

let tmpDir: string;
let nextId = 0;
let now = 100;

function request(workspaceId: string | null = 'ws-a'): CreateAgentDefinitionRequestV1 {
  return {
    version: 1, scope: workspaceId ? 'workspace' : 'global', workspaceId,
    name: 'Researcher', description: 'Researches', instructions: 'Research carefully',
    runtimeProfile: { version: 1, runtimeId: 'pi' }, fallbackChain: [],
    toolRefs: [], skillRefs: [], mcpServerRefs: [], permissionPolicy: null,
    contextPolicy: { version: 1, includeWorkspaceInstructions: true, allowMessageContext: true,
      allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 1000 },
    defaultRunTtlMs: null,
  };
}

function seedWorkspace(id: string, owner: string): void {
  getDb().prepare('INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
    .run(id, id, owner);
}

describe('AgentDefinitionsRepository', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-agent-definitions-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb(); initDb(); nextId = 0; now = 100;
    seedWorkspace('ws-a', 'owner-a'); seedWorkspace('ws-b', 'owner-b');
  });
  afterEach(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function repo(): AgentDefinitionsRepository {
    return new AgentDefinitionsRepository({
      now: () => ++now, createId: () => `def-${++nextId}`,
      capabilityCatalog: new AgentCapabilityCatalog([], () => true),
    });
  }

  test('requires matching owner/workspace and hides wrong-owner IDs', () => {
    const definitions = repo();
    const created = definitions.create('owner-a', request(), 'create-owner');
    assert.equal(definitions.get('owner-b', created.id), null);
    assert.throws(() => definitions.create('owner-a', request('ws-b'), 'wrong-workspace'), /workspace not found/);
    assert.equal((getDb().prepare("SELECT COUNT(*) AS count FROM command_receipts WHERE operation_id = 'agent-definition:wrong-workspace'").get() as { count: number }).count, 0);
    assert.throws(() => definitions.get('', created.id), /ownerUserId/);
  });

  test('uses optimistic revisions for edit and enable transitions', () => {
    const definitions = repo();
    const created = definitions.create('owner-a', request(), 'create-revision');
    const updated = definitions.update('owner-a', created.id,
      { version: 1, expectedRevision: 1, description: 'Updated' }, 'update-1')!;
    assert.equal(updated.revision, 2);
    assert.throws(() => definitions.update('owner-a', created.id,
      { version: 1, expectedRevision: 1, description: 'Stale' }, 'update-stale'), /revision conflict/);
    const enabled = definitions.setStatus('owner-a', created.id, AgentDefinitionStatus.Enabled, 2, 'enable-1')!;
    assert.equal(enabled.status, AgentDefinitionStatus.Enabled);
    assert.equal(enabled.revision, 3);
  });
});
