import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import {
  AgentDefinitionStatus,
  AgentRunCompletionMode,
  AgentRunEventType,
  AgentRunInvocationMode,
  type EffectiveAgentDefinitionV1,
} from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { AgentRunActionError, AgentRunActionsService } from '../src/services/agentRunActions';
import { AgentRunsRepository, type CreateAgentRunInput } from '../src/services/agentRunsRepository';
import { mountAgentRunActionRoutes } from '../src/routes/agentRunActions';

const HASH = 'a'.repeat(64);
const definition: EffectiveAgentDefinitionV1 = {
  version: 1,
  name: 'Ephemeral Researcher',
  description: 'Researches durable state',
  instructions: 'Inspect the selected evidence carefully.',
  runtimeProfile: { version: 1, runtimeId: 'pi' },
  fallbackChain: [],
  capabilitySnapshot: { version: 1, entries: [] },
  permissionPolicy: {
    version: 1, preset: 'research', categories: {}, maxDelegationDepth: 1,
    maxConcurrentRuns: 2, maxWallTimeMs: 60_000, maxAttempts: 2,
  },
  contextPolicy: {
    version: 1, includeWorkspaceInstructions: true, allowMessageContext: true,
    allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 20_000,
  },
};

let tmpDir: string;
let idCounts: Record<string, number>;
let server: ReturnType<typeof express.application.listen> | null;

function runInput(operationId: string, parentNodeId: string | null): CreateAgentRunInput {
  return {
    operationId, ownerUserId: 'owner-a', workspaceId: 'ws-a', definitionId: null,
    definitionRevision: null, effectiveDefinition: definition,
    invocationMode: parentNodeId ? AgentRunInvocationMode.Delegated : AgentRunInvocationMode.Manual,
    completionMode: AgentRunCompletionMode.Detach,
    parentRunId: null, parentAttemptId: null, parentNodeId,
    parentTurnId: parentNodeId ? 'turn-parent' : null,
    parentMessageId: parentNodeId ? 'message-parent' : null,
    parentToolCallId: null, task: 'Check the lease implementation',
    contextManifest: { version: 1, entries: [], assembledAt: 1, estimatedChars: 0 },
    expectedResult: null,
    executionEnvironment: {
      version: 1, kind: 'shared_workspace', cwd: '/tmp/ws-a', sourceWorkspaceId: 'ws-a',
      snapshotHash: HASH, createdAt: 1,
    },
    expiresAt: null,
    initialEvent: { type: AgentRunEventType.Assistant, payload: { text: 'Transcript evidence' } },
  };
}

function continueRequest(fallback: 'error' | 'new_thread' = 'error') {
  return {
    version: 1 as const, workspaceId: 'ws-a', includeTask: true,
    includeResult: true, includeTranscript: true, fallback,
  };
}

describe('AgentRunActionsService', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-agent-run-actions-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
    idCounts = {};
    server = null;
    getDb().prepare('INSERT INTO workspaces (id, name, owner_user_id, active_tree_id, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)')
      .run('ws-a', 'A', 'owner-a', 'tree-parent');
    getDb().prepare('INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
      .run('ws-b', 'B', 'owner-b');
    getDb().prepare('INSERT INTO trees (id, workspace_id, root_node_id, last_active_at, created_at) VALUES (?, ?, ?, 1, 1)')
      .run('tree-parent', 'ws-a', 'parent-node');
    getDb().prepare(`INSERT INTO nodes
      (id, workspace_id, tree_id, kind, status, minimized, spawned_by_agent, created_at)
      VALUES (?, ?, ?, 'chat', 'idle', 0, 0, 1)`).run('parent-node', 'ws-a', 'tree-parent');
    getDb().prepare("INSERT INTO messages (id, node_id, role, content, seq, created_at) VALUES (?, ?, 'assistant', 'Parent answer', 0, 1)")
      .run('message-parent', 'parent-node');
    getDb().prepare(`INSERT INTO turns
      (turn_id, node_id, assistant_message_id, status, last_seq, started_at, completed_at, updated_at)
      VALUES (?, ?, ?, 'completed', 0, 1, 1, 1)`).run('turn-parent', 'parent-node', 'message-parent');
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    delete process.env.MICHI_CLOUD;
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runs(): AgentRunsRepository {
    return new AgentRunsRepository({ createId: (kind) => `${kind}-${idCounts[kind] = (idCounts[kind] ?? 0) + 1}` });
  }

  function actions(repository: AgentRunsRepository): AgentRunActionsService {
    return new AgentRunActionsService({
      runs: repository,
      now: () => 5_000,
      nextId: (kind) => `${kind}-${idCounts[kind] = (idCounts[kind] ?? 0) + 1}`,
    });
  }

  test('creates one ordinary child Branch with only the explicitly selected Run context and leaves the Run separate', () => {
    const repository = runs();
    const run = repository.createRun(runInput('spawn-parented', 'parent-node'));
    const resultBundle = {
      version: 1, status: 'completed', source: 'submitted',
      handoff: { conclusion: 'Lease is correct', artifactsOrChanges: 'No changes', unresolvedIssues: '' },
      artifacts: [], resourceMutations: [], externalActions: [],
    };
    getDb().prepare("UPDATE agent_runs SET status = 'completed', result_bundle = ?, completed_at = 4 WHERE id = ?")
      .run(JSON.stringify(resultBundle), run.id);
    const service = actions(repository);

    const first = service.continueAsBranch('owner-a', run.id, continueRequest(), 'continue-1');
    const replay = service.continueAsBranch('owner-a', run.id, continueRequest(), 'continue-1');

    assert.deepEqual(replay, first);
    assert.equal(first.mode, 'branch');
    assert.equal(first.parentNodeId, 'parent-node');
    assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM nodes WHERE parent_node_id = ?').get('parent-node') as any).count, 1);
    assert.deepEqual(
      { ...(getDb().prepare('SELECT source_node_id, target_node_id, kind, anchor_message_id FROM edges WHERE target_node_id = ?').get(first.nodeId) as Record<string, unknown>) },
      { source_node_id: 'parent-node', target_node_id: first.nodeId, kind: 'branch', anchor_message_id: 'message-parent' },
    );
    const draft = JSON.parse((getDb().prepare('SELECT composer_draft FROM nodes WHERE id = ?').get(first.nodeId) as any).composer_draft);
    assert.deepEqual(draft.mentions, []);
    assert.match(draft.value, /Selected Run task[\s\S]*Check the lease implementation/);
    assert.match(draft.value, /Selected Result Bundle[\s\S]*Lease is correct/);
    assert.match(draft.value, /Selected Run transcript[\s\S]*Transcript evidence/);
    assert.equal(repository.getRun('owner-a', run.id)?.parentNodeId, 'parent-node');
    assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM agent_runs').get() as any).count, 1);
  });

  test('offers an actionable missing-Parent error and idempotently creates a new-thread fallback', () => {
    const repository = runs();
    const run = repository.createRun(runInput('spawn-missing-parent', 'parent-node'));
    getDb().prepare('UPDATE nodes SET deleted_at = 10 WHERE id = ?').run('parent-node');
    const service = actions(repository);

    assert.throws(
      () => service.continueAsBranch('owner-a', run.id, continueRequest('error'), 'continue-error'),
      (error) => error instanceof AgentRunActionError
        && error.code === 'parent_unavailable'
        && /new thread/.test(error.message),
    );
    const first = service.continueAsBranch('owner-a', run.id, continueRequest('new_thread'), 'continue-fallback');
    const replay = service.continueAsBranch('owner-a', run.id, continueRequest('new_thread'), 'continue-fallback');
    assert.deepEqual(replay, first);
    assert.equal(first.mode, 'new_thread');
    assert.equal(first.parentNodeId, null);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM trees WHERE id = ?').get(first.treeId) as any).count, 1);
    assert.equal((getDb().prepare('SELECT active_tree_id FROM workspaces WHERE id = ?').get('ws-a') as any).active_tree_id, first.treeId);
  });

  test('saves an immutable ephemeral snapshot as one Draft and scopes every action to owner and Workspace', async () => {
    const repository = runs();
    const run = repository.createRun(runInput('spawn-save', 'parent-node'));
    const snapshotBefore = JSON.stringify(repository.getRun('owner-a', run.id)?.effectiveDefinition);
    const service = actions(repository);

    const first = await service.saveAsAgent('owner-a', run.id, { version: 1, workspaceId: 'ws-a', name: 'Saved Researcher' }, 'save-1');
    const replay = await service.saveAsAgent('owner-a', run.id, { version: 1, workspaceId: 'ws-a', name: 'Saved Researcher' }, 'save-1');
    assert.equal(first.definition.id, replay.definition.id);
    assert.equal(first.definition.status, AgentDefinitionStatus.Draft);
    assert.equal(first.definition.workspaceId, 'ws-a');
    assert.equal(first.definition.name, 'Saved Researcher');
    assert.equal(JSON.stringify(repository.getRun('owner-a', run.id)?.effectiveDefinition), snapshotBefore);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM agent_definitions').get() as any).count, 1);

    await assert.rejects(
      () => service.saveAsAgent('owner-b', run.id, { version: 1, workspaceId: 'ws-a' }, 'wrong-owner'),
      (error) => error instanceof AgentRunActionError && error.code === 'not_found',
    );
    assert.throws(
      () => service.continueAsBranch('owner-a', run.id, { ...continueRequest(), workspaceId: 'ws-b' }, 'wrong-workspace'),
      (error) => error instanceof AgentRunActionError && error.code === 'not_found',
    );
  });

  test('HTTP actions hide wrong-owner and cross-Workspace references behind 404', async () => {
    const repository = runs();
    const run = repository.createRun(runInput('spawn-route-scope', 'parent-node'));
    const actionService = actions(repository);
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.user = { id: req.header('x-test-owner') }; next(); });
    const router = express.Router();
    mountAgentRunActionRoutes(router, { actions: actionService, operationId: (req) => req.header('x-idempotency-key') ?? 'route-op' });
    app.use('/api', router);
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const post = (owner: string, workspaceId: string) => fetch(`${base}/agent-runs/${run.id}/continue-as-branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-owner': owner, 'x-idempotency-key': `${owner}-${workspaceId}` },
      body: JSON.stringify({ ...continueRequest(), workspaceId }),
    });

    assert.equal((await post('owner-b', 'ws-a')).status, 404);
    assert.equal((await post('owner-a', 'ws-b')).status, 404);
  });
});
