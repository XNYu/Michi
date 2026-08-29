import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  AgentRunCompletionMode,
  AgentRunEventType,
  AgentRunStatus,
  type CreateAgentDefinitionRequestV1,
  type EffectiveAgentDefinitionV1,
} from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { AgentDefinitionsRepository } from '../src/services/agentDefinitionsRepository';
import { AgentRunsRepository } from '../src/services/agentRunsRepository';
import { exportAgentRunBackup, importAgentRunBackup } from '../src/services/agentRunBackup';

const hash = 'a'.repeat(64);
let dataDir: string;

function definition(scope: 'global' | 'workspace', workspaceId: string | null): CreateAgentDefinitionRequestV1 {
  return {
    version: 1, scope, workspaceId, name: `${scope} worker`, description: 'backup fixture', instructions: 'Work safely.',
    runtimeProfile: { version: 1, runtimeId: 'pi', providerId: 'provider', modelId: 'model' }, fallbackChain: [],
    toolRefs: [], skillRefs: [], mcpServerRefs: [], permissionPolicy: null,
    contextPolicy: { version: 1, includeWorkspaceInstructions: true, allowMessageContext: true,
      allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 10_000 },
    defaultRunTtlMs: null,
  };
}

function effective(): EffectiveAgentDefinitionV1 {
  return {
    version: 1, name: 'Ephemeral worker', description: 'fixture', instructions: 'Work.',
    runtimeProfile: { version: 1, runtimeId: 'pi', providerId: 'provider', modelId: 'model' }, fallbackChain: [],
    capabilitySnapshot: { version: 1, entries: [{ id: 'read', kind: 'tool', revision: '1', schemaHash: hash,
      contentHash: null, configHash: hash, publicConfig: {}, credentialBindingIds: ['binding-private'] }] },
    permissionPolicy: { version: 1, preset: 'research', categories: {}, maxDelegationDepth: 0,
      maxConcurrentRuns: 1, maxWallTimeMs: 60_000, maxAttempts: 1 },
    contextPolicy: { version: 1, includeWorkspaceInstructions: true, allowMessageContext: true,
      allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 10_000 },
  };
}

describe('Agent Run backup v2', () => {
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-run-backup-'));
    process.env.MICHI_DATA_DIR = dataDir;
    process.env.MICHI_CLOUD = '1';
    closeDb(); initDb();
    const db = getDb();
    db.prepare("INSERT INTO workspaces (id,name,cwd,owner_user_id,created_at,updated_at) VALUES ('ws-source','Source','/private/source','owner-a',1,1)").run();
    db.prepare("INSERT INTO workspaces (id,name,cwd,owner_user_id,created_at,updated_at) VALUES ('ws-dest','Dest','/destination/workspace','owner-b',1,1)").run();
  });

  afterEach(() => {
    closeDb();
    delete process.env.MICHI_DATA_DIR;
    delete process.env.MICHI_CLOUD;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('sanitizes owner/workspace exports and imports active Runs as archived failed history', () => {
    const definitions = new AgentDefinitionsRepository({ createId: (() => { let n = 0; return () => `definition-${++n}`; })() });
    definitions.create('owner-a', definition('global', null), 'global-op');
    definitions.create('owner-a', definition('workspace', 'ws-source'), 'workspace-op');
    const runs = new AgentRunsRepository({ now: () => 10, createId: (kind) => `${kind}-fixture` });
    const run = runs.createRun({
      operationId: 'run-op', ownerUserId: 'owner-a', workspaceId: 'ws-source', definitionId: null,
      definitionRevision: null, effectiveDefinition: effective(), invocationMode: 'manual',
      completionMode: AgentRunCompletionMode.Detach, parentRunId: null, parentAttemptId: null,
      parentNodeId: null, parentTurnId: null, parentMessageId: null, parentToolCallId: null,
      task: 'Back up this Run', contextManifest: { version: 1, entries: [{ kind: 'file', workspacePath: 'notes.md',
        snapshotPath: '/private/run/snapshot/notes.md', size: 4, sha256: hash }], assembledAt: 1, estimatedChars: 4 },
      expectedResult: null, executionEnvironment: { version: 1, kind: 'git_worktree', cwd: '/private/worktree',
        sourceWorkspaceId: 'ws-source', baseCommit: 'abc123', snapshotHash: hash, createdAt: 1 }, expiresAt: null,
      initialEvent: { type: AgentRunEventType.RunStatusChanged, payload: { version: 1, from: null, to: AgentRunStatus.Queued } },
    });
    const attempt = runs.createAttempt({ operationId: 'attempt-op', ownerUserId: 'owner-a', runId: run.id,
      profileIndex: 0, runtimeProfile: effective().runtimeProfile, publicSessionId: 'public-session', recoveryEnvelope: null });
    getDb().prepare('UPDATE agent_run_attempts SET native_resume_token = ? WHERE id = ?')
      .run(JSON.stringify('private-native-token'), attempt.id);
    runs.createWatch('owner-a', 'ws-source', [run.id], { version: 1, kind: 'all' }, 'notify',
      { parentRunId: null, parentNodeId: null, parentTurnId: null }, 'watch-op');

    const workspace = exportAgentRunBackup('owner-a', 'ws-source');
    const ownerFull = exportAgentRunBackup('owner-a', null);
    assert.equal(workspace.definitions.length, 1);
    assert.equal(ownerFull.definitions.length, 2);
    assert.equal(workspace.runs[0].executionEnvironment.cwd, null);
    assert.equal('snapshotPath' in workspace.runs[0].contextManifest.entries[0], false);
    assert.deepEqual(workspace.runs[0].effectiveDefinition.capabilitySnapshot.entries[0].credentialBindingIds, []);
    assert.equal(JSON.stringify(workspace).includes('private-native-token'), false);
    assert.equal(JSON.stringify(workspace).includes('/private/'), false);

    const imported = importAgentRunBackup({ ownerUserId: 'owner-b', fragment: workspace,
      workspaceIdMap: new Map([['ws-source', 'ws-dest']]), now: 100,
      createId: (kind) => `imported-${kind}-${Math.random().toString(36).slice(2)}` });
    assert.equal(imported.importedDefinitions, 1);
    assert.equal(imported.importedRuns, 1);
    const importedRunId = imported.runIds.get(run.id)!;
    const importedRun = new AgentRunsRepository().getRun('owner-b', importedRunId)!;
    assert.equal(importedRun.status, AgentRunStatus.Failed);
    assert.equal(importedRun.archivedAt, 100);
    assert.equal(importedRun.executionEnvironment.cwd, '.');
    assert.equal(importedRun.definitionId, null);
    const importedAttempts = new AgentRunsRepository().listAttempts('owner-b', importedRunId);
    assert.equal(importedAttempts[0].status, 'failed');
    assert.equal(importedAttempts[0].error?.category, 'import_interrupted');
    const stored = getDb().prepare('SELECT native_resume_token, lease_token FROM agent_run_attempts a JOIN agent_runs r ON r.id = a.run_id WHERE r.id = ?')
      .get(importedRunId) as { native_resume_token: string | null; lease_token: string | null };
    assert.equal(stored.native_resume_token, null);
    assert.equal(stored.lease_token, null);
    const importedDefinition = new AgentDefinitionsRepository().get(
      'owner-b', imported.definitionIds.get('definition-2')!,
    )!;
    assert.equal(importedDefinition.status, 'draft');
    assert.notEqual(importedDefinition.id, 'definition-2');
  });

  test('workspace export omits owner-global Definitions while preserving effective snapshots', () => {
    const definitions = new AgentDefinitionsRepository({ createId: (() => { let n = 0; return () => `definition-${++n}`; })() });
    const global = definitions.create('owner-a', definition('global', null), 'global-op');
    getDb().prepare("UPDATE agent_definitions SET status = 'enabled' WHERE id = ?").run(global.id);
    const enabledGlobal = definitions.get('owner-a', global.id)!;
    definitions.create('owner-a', definition('workspace', 'ws-source'), 'workspace-op');
    const runs = new AgentRunsRepository({ now: () => 10, createId: (kind) => `${kind}-global-fixture` });
    const run = runs.createRun({
      operationId: 'run-global-op', ownerUserId: 'owner-a', workspaceId: 'ws-source', definitionId: enabledGlobal.id,
      definitionRevision: enabledGlobal.revision, effectiveDefinition: effective(), invocationMode: 'manual',
      completionMode: AgentRunCompletionMode.Detach, parentRunId: null, parentAttemptId: null,
      parentNodeId: null, parentTurnId: null, parentMessageId: null, parentToolCallId: null,
      task: 'Use a global definition', contextManifest: { version: 1, entries: [], assembledAt: 1, estimatedChars: 0 },
      expectedResult: null, executionEnvironment: { version: 1, kind: 'shared_workspace', cwd: '/private/source',
        sourceWorkspaceId: 'ws-source', snapshotHash: hash, createdAt: 1 }, expiresAt: null,
      initialEvent: { type: AgentRunEventType.RunStatusChanged, payload: { version: 1, from: null, to: AgentRunStatus.Queued } },
    });

    const workspace = exportAgentRunBackup('owner-a', 'ws-source');
    assert.deepEqual(workspace.definitions.map((item) => item.scope), ['workspace']);
    assert.equal(workspace.runs[0].definitionId, enabledGlobal.id);
    assert.equal(workspace.runs[0].effectiveDefinition.name, 'Ephemeral worker');

    const imported = importAgentRunBackup({ ownerUserId: 'owner-b', fragment: workspace,
      workspaceIdMap: new Map([['ws-source', 'ws-dest']]), now: 100,
      createId: (kind) => `remapped-${kind}-${Math.random().toString(36).slice(2)}` });
    const restored = new AgentRunsRepository().getRun('owner-b', imported.runIds.get(run.id)!)!;
    assert.equal(restored.definitionId, null);
    assert.equal(restored.effectiveDefinition.name, 'Ephemeral worker');
  });
});
