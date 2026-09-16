import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import {
  AgentDefinitionStatus,
  type AgentCapabilityCatalogEntryV1,
  type CreateAgentDefinitionRequestV1,
  type RuntimeProfileV1,
} from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import {
  AgentCapabilityCatalog,
  type AgentCapabilityCatalogSource,
} from '../src/services/agentCapabilityCatalog';
import { AgentDefinitionsRepository } from '../src/services/agentDefinitionsRepository';
import {
  AgentDefinitionService,
  type RuntimeProfileReadiness,
} from '../src/services/agentDefinitionService';
import { LOCAL_AGENT_OWNER_ID, setupCustomAgentRoutes } from '../src/routes/customAgents';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
let tmpDir: string;
let server: ReturnType<typeof express.application.listen>;
let baseUrl: string;
let nextId: number;
let readiness: FakeReadiness;
let service: AgentDefinitionService;
let customAgentsEnabled: boolean;

class StaticCapabilitySource implements AgentCapabilityCatalogSource {
  constructor(private readonly entries: readonly AgentCapabilityCatalogEntryV1[]) {}
  list(): readonly AgentCapabilityCatalogEntryV1[] { return this.entries; }
}

class FakeReadiness implements RuntimeProfileReadiness {
  validate(profile: RuntimeProfileV1): void {
    if (profile.runtimeId === 'missing') throw new Error('runtime missing is not available');
    if (!profile.modelId) throw new Error(`runtime ${profile.runtimeId} requires a model`);
    if (!profile.providerId) throw new Error(`runtime ${profile.runtimeId} requires a configured credential`);
  }
}

function capability(id: string, workspaceId: string | null, readinessState: AgentCapabilityCatalogEntryV1['readiness'] = 'ready'): AgentCapabilityCatalogEntryV1 {
  return {
    version: 1, id, kind: 'tool', ownerUserId: 'owner-a', workspaceId,
    revision: 'rev-1', readiness: readinessState, publicSchema: { type: 'object' },
    publicConfig: { label: id }, schemaHash: digest(`${id}:schema`),
    contentHash: digest(`${id}:content`), configHash: digest(`${id}:config`),
    credentialBindingIds: ['opaque-binding-id'],
  };
}

function definition(overrides: Partial<CreateAgentDefinitionRequestV1> = {}): CreateAgentDefinitionRequestV1 {
  return {
    version: 1, scope: 'workspace', workspaceId: 'ws-a', name: 'Researcher',
    description: 'Researches difficult topics', instructions: 'Research carefully.',
    runtimeProfile: { version: 1, runtimeId: 'pi', providerId: 'anthropic', modelId: 'model-a' },
    fallbackChain: [], toolRefs: ['tool-ready'], skillRefs: [], mcpServerRefs: [],
    permissionPolicy: null,
    contextPolicy: { version: 1, includeWorkspaceInstructions: true,
      allowMessageContext: true, allowFileContext: true, allowArtifactContext: true,
      maxEstimatedChars: 10_000 },
    defaultRunTtlMs: null,
    ...overrides,
  };
}

function seedWorkspace(id: string, owner: string | null): void {
  getDb().prepare('INSERT INTO workspaces (id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)')
    .run(id, id, owner);
}

async function request(method: string, route: string, owner?: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (owner) headers['x-test-user'] = owner;
  const response = await fetch(`${baseUrl}${route}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = response.status === 204 ? null : await response.json();
  return { response, payload: payload as any };
}

describe('Custom Agent Definition HTTP router', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-custom-agent-route-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    process.env.MICHI_CLOUD = '1';
    closeDb(); initDb(); nextId = 0; readiness = new FakeReadiness();
    customAgentsEnabled = true;
    seedWorkspace('ws-a', 'owner-a'); seedWorkspace('ws-b', 'owner-b');
    seedWorkspace('ws-local', null);
    const catalog = new AgentCapabilityCatalog([new StaticCapabilitySource([
      capability('tool-ready', null), capability('tool-workspace', 'ws-a'),
      capability('tool-stale', 'ws-a', 'invalid'), capability('tool-other-workspace', 'ws-b'),
    ])], () => true);
    const repository = new AgentDefinitionsRepository({
      now: (() => { let now = 100; return () => ++now; })(),
      createId: () => `def-${++nextId}`, capabilityCatalog: catalog,
    });
    service = new AgentDefinitionService({
      repository, capabilityCatalog: catalog, runtimeReadiness: readiness,
      createOperationId: (() => { let op = 0; return () => `route-op-${++op}`; })(),
    });
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      const owner = req.header('x-test-user');
      if (owner) req.user = { id: owner };
      next();
    });
    app.use('/api', setupCustomAgentRoutes({ service, isEnabled: () => customAgentsEnabled }));
    app.get('/api/persistence/capabilities', (_req, res) => res.json({ protocolVersion: 2 }));
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb(); delete process.env.MICHI_CLOUD;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns feature-disabled for every definition route while the backend gate is off', async () => {
    customAgentsEnabled = false;

    const response = await request('GET', '/agents?workspaceId=ws-a', 'owner-a');
    const unrelated = await request('GET', '/persistence/capabilities');

    assert.equal(response.response.status, 404);
    assert.deepEqual(response.payload, { error: 'custom_agents_disabled' });
    assert.equal(unrelated.response.status, 200);
    assert.deepEqual(unrelated.payload, { protocolVersion: 2 });
  });

  test('Draft CRUD returns explicit revisions and is not discoverable or spawnable', async () => {
    const created = await request('POST', '/agents', 'owner-a', definition());
    assert.equal(created.response.status, 201);
    assert.equal(created.payload.definition.status, AgentDefinitionStatus.Draft);
    assert.equal(created.payload.definition.revision, 1);
    assert.deepEqual(created.payload.retention, {
      defaultRunTtlMs: null, maxRunTtlMs: 31_536_000_000, indefiniteByDefault: true,
    });
    const oversizedOperation = await fetch(`${baseUrl}/agents`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': 'owner-a', 'x-idempotency-key': 'x'.repeat(257) }, body: JSON.stringify(definition()) });
    assert.equal(oversizedOperation.status, 400);

    const discovery = await request('GET', '/agents?workspaceId=ws-a&discover=enabled', 'owner-a');
    assert.deepEqual(discovery.payload.definitions, []);
    assert.equal(await service.getSpawnable('owner-a', created.payload.definition.id, 'ws-a'), null);

    const edited = await request('PATCH', `/agents/${created.payload.definition.id}`, 'owner-a', {
      version: 1, expectedRevision: 1, description: 'Updated description',
    });
    assert.equal(edited.payload.definition.revision, 2);
  });

  test('enable validates runtime, model, credential, and capability readiness with structured blockers', async () => {
    async function createAndEnable(body: CreateAgentDefinitionRequestV1) {
      const created = await request('POST', '/agents', 'owner-a', body);
      return request('POST', `/agents/${created.payload.definition.id}/enable`, 'owner-a');
    }
    const missingRuntime = await createAndEnable(definition({ runtimeProfile: { version: 1, runtimeId: 'missing', providerId: 'p', modelId: 'm' } }));
    assert.equal(missingRuntime.response.status, 400);
    assert.match(missingRuntime.payload.error, /not available/);
    assert.deepEqual(missingRuntime.payload.blockers, [
      { code: 'runtime', ref: 'missing', message: 'runtime missing is not available' },
    ]);
    const missingModel = await createAndEnable(definition({ runtimeProfile: { version: 1, runtimeId: 'pi', providerId: 'p' } }));
    assert.match(missingModel.payload.error, /requires a model/);
    const missingCredential = await createAndEnable(definition({ runtimeProfile: { version: 1, runtimeId: 'pi', modelId: 'm' } }));
    assert.match(missingCredential.payload.error, /credential/);
    const staleCapability = await createAndEnable(definition({ toolRefs: ['tool-stale'] }));
    assert.match(staleCapability.payload.error, /invalid/);
    assert.deepEqual(staleCapability.payload.blockers, [
      { code: 'capability', ref: 'tool:tool-stale', message: 'capability tool:tool-stale is invalid' },
    ]);

    // Every blocker is reported at once, not just the first failure.
    const multiple = await createAndEnable(definition({
      runtimeProfile: { version: 1, runtimeId: 'missing', providerId: 'p', modelId: 'm' },
      toolRefs: ['tool-stale', 'tool-absent'],
    }));
    assert.equal(multiple.response.status, 400);
    assert.deepEqual(multiple.payload.blockers.map((blocker: { code: string; ref: string | null }) => `${blocker.code}:${blocker.ref}`), [
      'runtime:missing', 'capability:tool:tool-stale', 'capability:tool:tool-absent',
    ]);
  });

  test('instructions are optional — a Definition with empty instructions can be enabled', async () => {
    const created = await request('POST', '/agents', 'owner-a', definition({ instructions: '' }));
    assert.equal(created.response.status, 201);
    const enabled = await request('POST', `/agents/${created.payload.definition.id}/enable`, 'owner-a');
    assert.equal(enabled.response.status, 200);
    assert.equal(enabled.payload.definition.status, AgentDefinitionStatus.Enabled);
    assert.equal(enabled.payload.definition.instructions, '');
  });

  test('agent-capabilities lists the owner-visible catalog with readiness', async () => {
    const listed = await request('GET', '/agent-capabilities?workspaceId=ws-a', 'owner-a');
    assert.equal(listed.response.status, 200);
    assert.deepEqual(
      listed.payload.capabilities.map((entry: { id: string; readiness: string }) => `${entry.id}:${entry.readiness}`),
      ['tool-ready:ready', 'tool-stale:invalid', 'tool-workspace:ready'],
    );
    // Other-workspace capabilities are invisible; owner isolation holds.
    const otherOwner = await request('GET', '/agent-capabilities?workspaceId=ws-a', 'owner-b');
    assert.deepEqual(otherOwner.payload.capabilities, []);
  });

  test('enable rejects wrong-Workspace capability refs and returns no credential values', async () => {
    const created = await request('POST', '/agents', 'owner-a', definition({ toolRefs: ['tool-other-workspace'] }));
    const rejected = await request('POST', `/agents/${created.payload.definition.id}/enable`, 'owner-a');
    assert.equal(rejected.response.status, 400);
    assert.match(rejected.payload.error, /not found/);

    const valid = await request('POST', '/agents', 'owner-a', definition({ toolRefs: ['tool-workspace'] }));
    const enabled = await request('POST', `/agents/${valid.payload.definition.id}/enable`, 'owner-a');
    assert.equal(enabled.response.status, 200);
    assert.equal(enabled.payload.definition.status, AgentDefinitionStatus.Enabled);
    assert.equal(JSON.stringify(enabled.payload).includes('opaque-binding-id'), false);
  });

  test('Global discovery is owner-scoped and same names do not shadow Workspace Definitions', async () => {
    const global = await request('POST', '/agents', 'owner-a', definition({ scope: 'global', workspaceId: null, name: 'Same' }));
    const workspace = await request('POST', '/agents', 'owner-a', definition({ name: 'Same' }));
    await request('POST', `/agents/${global.payload.definition.id}/enable`, 'owner-a');
    await request('POST', `/agents/${workspace.payload.definition.id}/enable`, 'owner-a');

    const ownerList = await request('GET', '/agents?workspaceId=ws-a&discover=enabled', 'owner-a');
    assert.deepEqual(ownerList.payload.definitions.map((item: any) => item.scope), ['global', 'workspace']);
    const attacker = await request('GET', '/agents?workspaceId=ws-b&discover=enabled', 'owner-b');
    assert.deepEqual(attacker.payload.definitions, []);
    const wrongOwnerGet = await request('GET', `/agents/${global.payload.definition.id}`, 'owner-b');
    assert.equal(wrongOwnerGet.response.status, 404);
  });

  test('duplicate into a Workspace creates a new Draft and delete preserves Run snapshot', async () => {
    const source = await request('POST', '/agents', 'owner-a', definition({ scope: 'global', workspaceId: null }));
    const duplicate = await request('POST', `/agents/${source.payload.definition.id}/duplicate`, 'owner-a', { workspaceId: 'ws-a' });
    assert.equal(duplicate.response.status, 201);
    assert.notEqual(duplicate.payload.definition.id, source.payload.definition.id);
    assert.equal(duplicate.payload.definition.scope, 'workspace');
    assert.equal(duplicate.payload.definition.status, 'draft');

    getDb().prepare(`INSERT INTO agent_runs (
      id,owner_user_id,workspace_id,definition_id,definition_revision,effective_definition,
      invocation_mode,completion_mode,task,context_manifest,execution_environment,status,created_at,updated_at
    ) VALUES ('run-history','owner-a','ws-a',?,1,'{"version":1}','manual','detach','task',
      '{"version":1}','{"version":1}','queued',1,1)`).run(source.payload.definition.id);
    const deleted = await request('DELETE', `/agents/${source.payload.definition.id}`, 'owner-a');
    assert.equal(deleted.response.status, 204);
    const run = getDb().prepare("SELECT definition_id,effective_definition FROM agent_runs WHERE id='run-history'").get() as any;
    assert.equal(run.definition_id, null);
    assert.equal(run.effective_definition, '{"version":1}');
  });

  test('TTL validation preserves indefinite retention and enforces min/max ceilings', async () => {
    const indefinite = await request('POST', '/agents', 'owner-a', definition({ defaultRunTtlMs: null }));
    assert.equal(indefinite.payload.definition.defaultRunTtlMs, null);
    const tooShort = await request('POST', '/agents', 'owner-a', definition({ defaultRunTtlMs: 1000 }));
    assert.equal(tooShort.response.status, 400);
    const tooLong = await request('POST', '/agents', 'owner-a', definition({ defaultRunTtlMs: 31_536_000_001 }));
    assert.equal(tooLong.response.status, 400);
  });

  test('local mode supplies the stable local owner sentinel', async () => {
    delete process.env.MICHI_CLOUD;
    const created = await request('POST', '/agents', undefined, definition({ workspaceId: 'ws-local' }));
    assert.equal(created.response.status, 201);
    assert.equal(created.payload.definition.ownerUserId, LOCAL_AGENT_OWNER_ID);
  });
});
