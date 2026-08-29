import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { AgentRuntime, AgentSession, NewAgentSessionOptions } from '../src/agents/types';
import { registerRuntime } from '../src/agents/registry';
import { closeDb, getDb, initDb } from '../src/services/db';
import { AgentDefinitionService } from '../src/services/agentDefinitionService';
import { ChatManager } from '../src/services/chatManager';
import { setupMichiRoutes } from '../src/routes/michi';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { clearAllSessions } from '../src/agents/sessionRegistry';

let tmpDir: string;
let server: ReturnType<typeof express.application.listen>;
let baseUrl: string;
let captured: NewAgentSessionOptions[];

const runtime: AgentRuntime = {
  id: 'primary-test', label: 'Primary Test',
  capabilities: {
    modes: false, permissions: true, models: false, providerModels: false,
    reasoning: true, supportedReasoningLevels: ['low', 'high'], apiKeys: false,
    warmSessions: false, saveContext: false, spawnBranches: false, nativeResume: false,
  },
  async warm() {},
  async newSession(options) {
    captured.push(options);
    const session: AgentSession = {
      id: options.sessionId!, runtimeId: runtime.id,
      runtimeProfileHash: options.profileHash ?? null,
      currentModelId: options.model ?? null, getHistory: () => [],
      getPendingAssistant: () => undefined,
      async *send() {}, async cancel() {},
    };
    return session;
  },
  async releaseSession() {},
  async shutdown() {},
};

function seedWorkspace(id: string): void {
  getDb().prepare('INSERT INTO workspaces (id,name,owner_user_id,cwd,created_at,updated_at) VALUES (?,?,NULL,?,1,1)')
    .run(id, id, tmpDir);
}

function seedNode(id: string, workspaceId: string): void {
  getDb().prepare(`INSERT INTO nodes
    (id,workspace_id,kind,status,minimized,spawned_by_agent,created_at)
    VALUES (?,?,'chat','idle',0,0,1)`).run(id, workspaceId);
}

function definition(workspaceId = 'ws-a') {
  return {
    version: 1 as const, scope: 'workspace' as const, workspaceId,
    name: 'Implementer', description: 'Implements scoped changes.',
    instructions: 'Follow the primary Agent instructions exactly.',
    runtimeProfile: {
      version: 1 as const, runtimeId: runtime.id, providerId: 'provider-a',
      modelId: 'model-a', reasoning: 'high' as const, modeId: null,
    },
    fallbackChain: [], toolRefs: [], skillRefs: [], mcpServerRefs: [], permissionPolicy: null,
    contextPolicy: { version: 1 as const, includeWorkspaceInstructions: true,
      allowMessageContext: true, allowFileContext: true, allowArtifactContext: true,
      maxEstimatedChars: 10_000 },
    defaultRunTtlMs: null,
  };
}

async function ensure(nodeId: string, workspaceId: string, agentDefinitionId?: string) {
  const response = await fetch(`${baseUrl}/nodes/${nodeId}/ensure-session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: tmpDir, workspaceId, agentDefinitionId }),
  });
  return { response, body: await response.json() as any };
}

describe('primary Agent conversation invocation', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-primary-agent-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb(); initDb(); captured = []; registerRuntime(runtime);
    seedWorkspace('ws-a'); seedWorkspace('ws-b');
    seedNode('node-a', 'ws-a'); seedNode('node-default', 'ws-a');
    const app = express(); app.use(express.json()); app.use('/api', setupMichiRoutes(new ChatManager(undefined, tmpDir)));
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('validates scope/status and leaves ordinary chat creation unchanged', async () => {
    const service = new AgentDefinitionService();
    const draft = await service.create(LOCAL_AGENT_OWNER_ID, definition(), 'draft');
    const rejectedDraft = await ensure('node-a', 'ws-a', draft.id);
    assert.equal(rejectedDraft.response.status, 400);
    assert.match(rejectedDraft.body.error, /enabled Agent Definition/);

    const wrongWorkspaceDraft = await service.create(LOCAL_AGENT_OWNER_ID, definition('ws-b'), 'other');
    const wrongWorkspace = await service.enable(LOCAL_AGENT_OWNER_ID, wrongWorkspaceDraft.id, 'enable-other');
    const rejectedWorkspace = await ensure('node-a', 'ws-a', wrongWorkspace!.id);
    assert.equal(rejectedWorkspace.response.status, 400);

    const disabledDraft = await service.create(LOCAL_AGENT_OWNER_ID, definition(), 'disabled');
    const disabledEnabled = await service.enable(LOCAL_AGENT_OWNER_ID, disabledDraft.id, 'enable-disabled');
    await service.disable(LOCAL_AGENT_OWNER_ID, disabledEnabled!.id, 'disable');
    const rejectedDisabled = await ensure('node-a', 'ws-a', disabledEnabled!.id);
    assert.equal(rejectedDisabled.response.status, 400);

    const ownerScopedDraft = await service.create(LOCAL_AGENT_OWNER_ID, definition(), 'owner-scoped');
    const ownerScoped = await service.enable(LOCAL_AGENT_OWNER_ID, ownerScopedDraft.id, 'enable-owner-scoped');
    await assert.rejects(
      new ChatManager(undefined, tmpDir).resolvePrimaryAgentBinding({
        ownerUserId: 'different-owner', workspaceId: 'ws-a', nodeId: 'node-a',
        definitionId: ownerScoped!.id,
      }),
      /workspace not found|enabled Agent Definition/,
    );

    const ordinary = await new ChatManager(undefined, tmpDir).resolvePrimaryAgentBinding({
      ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: 'ws-a', nodeId: 'node-default',
    });
    assert.equal(ordinary, null);
    const ordinaryRow = getDb().prepare('SELECT agent_definition_id,agent_effective_definition FROM nodes WHERE id=?').get('node-default') as any;
    assert.equal(ordinaryRow.agent_definition_id, null);
    assert.equal(ordinaryRow.agent_effective_definition, null);
  });

  test('persists an immutable snapshot and configures the runtime from it', async () => {
    const service = new AgentDefinitionService();
    const draft = await service.create(LOCAL_AGENT_OWNER_ID, definition(), 'create');
    const enabled = await service.enable(LOCAL_AGENT_OWNER_ID, draft.id, 'enable');
    const result = await ensure('node-a', 'ws-a', enabled!.id);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.runtimeId, runtime.id);
    assert.equal(result.body.providerId, 'provider-a');
    assert.equal(result.body.modelId, 'model-a');
    assert.equal(result.body.reasoning, 'high');
    assert.equal(captured.length, 1);
    assert.match(captured[0].bootstrapInstructions ?? '', /Follow the primary Agent instructions exactly/);
    assert.deepEqual(captured[0].toolProfile?.allowedToolNames, []);
    assert.ok(captured[0].profileHash);

    const rowBefore = getDb().prepare('SELECT agent_definition_revision,agent_effective_definition FROM nodes WHERE id=?').get('node-a') as any;
    const snapshotBefore = rowBefore.agent_effective_definition;
    await service.update(LOCAL_AGENT_OWNER_ID, enabled!.id, {
      version: 1, expectedRevision: enabled!.revision, instructions: 'New instructions for future conversations only.',
    }, 'edit');
    const manager = new ChatManager(undefined, tmpDir);
    const rebound = await manager.resolvePrimaryAgentBinding({
      ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: 'ws-a', nodeId: 'node-a',
    });
    assert.equal(rebound!.effectiveDefinition.instructions, 'Follow the primary Agent instructions exactly.');
    const rowAfter = getDb().prepare('SELECT agent_definition_revision,agent_effective_definition FROM nodes WHERE id=?').get('node-a') as any;
    assert.equal(rowAfter.agent_definition_revision, rowBefore.agent_definition_revision);
    assert.equal(rowAfter.agent_effective_definition, snapshotBefore);

    clearAllSessions();
    captured = [];
    const restored = await manager.ensureParentSession({
      ownerUserId: LOCAL_AGENT_OWNER_ID,
      workspaceId: 'ws-a',
      nodeId: 'node-a',
    });
    assert.ok(restored);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].provider, 'provider-a');
    assert.equal(captured[0].model, 'model-a');
    assert.equal(captured[0].reasoning, 'high');
    assert.match(captured[0].bootstrapInstructions ?? '', /Follow the primary Agent instructions exactly/);
    assert.ok(captured[0].profileHash);
  });
});
