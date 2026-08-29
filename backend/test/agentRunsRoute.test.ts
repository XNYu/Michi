import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  AgentRunCompletionMode, AgentRunInvocationMode, AgentRunStatus,
  type AgentRunDtoV1, type EffectiveAgentDefinitionV1, type SpawnAgentRunRequestV1,
} from 'michi-shared';
import { AgentRunEventBus } from '../src/agents/runs/agentRunEventBus';
import { AgentRunApiService, setupAgentRunRoutes, type AgentRunRouteService } from '../src/routes/agentRuns';

const HASH = 'a'.repeat(64);
const effective: EffectiveAgentDefinitionV1 = { version: 1, name: 'Worker', description: 'Works', instructions: 'Work', runtimeProfile: { version: 1, runtimeId: 'pi' }, fallbackChain: [], capabilitySnapshot: { version: 1, entries: [] }, permissionPolicy: { version: 1, preset: 'research', categories: {}, maxDelegationDepth: 0, maxConcurrentRuns: 1, maxWallTimeMs: 60_000, maxAttempts: 1 }, contextPolicy: { version: 1, includeWorkspaceInstructions: true, allowMessageContext: true, allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 1_000 } };
function run(ownerUserId = 'owner-a', workspaceId = 'ws-a'): AgentRunDtoV1 { return { version: 1, id: 'run-1', ownerUserId, workspaceId, definitionId: 'agent-1', definitionRevision: 1, effectiveDefinition: effective, invocationMode: AgentRunInvocationMode.Manual, completionMode: AgentRunCompletionMode.Detach, parentRunId: null, parentAttemptId: null, parentNodeId: null, parentTurnId: null, parentMessageId: null, parentToolCallId: null, task: 'Do work', contextManifest: { version: 1, entries: [], assembledAt: 1, estimatedChars: 0 }, expectedResult: null, executionEnvironment: { version: 1, kind: 'shared_workspace', cwd: '/tmp', sourceWorkspaceId: workspaceId, snapshotHash: HASH, createdAt: 1 }, status: AgentRunStatus.Running, waitingReason: null, activeAttemptId: 'attempt-1', resultBundle: null, latestEventSeq: 0, createdAt: 1, startedAt: 1, completedAt: null, archivedAt: null, expiresAt: null }; }
const spawn: SpawnAgentRunRequestV1 = { version: 1, workspaceId: 'ws-a', agentId: 'agent-1', ephemeralDefinition: null, task: 'Do work', contextManifest: { version: 1, entries: [], assembledAt: 1, estimatedChars: 0 }, permissionRestriction: null, environment: { version: 1, kind: 'auto' }, expectedResult: null, completionMode: AgentRunCompletionMode.Detach, invocationMode: AgentRunInvocationMode.Manual, runTtlMs: null, parentRunId: null, parentAttemptId: null, parentNodeId: null, parentTurnId: null, parentMessageId: null, parentToolCallId: null };

let server: ReturnType<typeof express.application.listen>;
let base: string;
let seenQuery: unknown;
let seenOperation = '';

beforeEach(() => { delete process.env.MICHI_CLOUD; });
afterEach(async () => { if (server) await new Promise<void>((resolve) => server.close(() => resolve())); });

function start(serviceOverrides: Partial<AgentRunRouteService> = {}): void {
  const service: AgentRunRouteService = {
    async spawn(_owner, _request, operationId) { seenOperation = operationId; return run('local-user'); },
    list(_owner, query) { seenQuery = query; return [run('local-user')]; },
    getDetail(owner) { return owner === 'owner-b' ? null : { run: run(owner), attempts: [], events: [], interactions: [] }; },
    events(owner) { return owner === 'owner-b' ? null : []; },
    async input() { return true; }, async cancel() { return true; }, async respond() { return null; },
    createWatch() { throw new Error('unused'); }, updateWatch() { return null; },
    ...serviceOverrides,
  };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { const value = req.header('x-user'); if (value) req.user = { id: value }; next(); });
  const events = new AgentRunEventBus();
  const allow = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
  app.use('/api', setupAgentRunRoutes({ service, sse: { source: { getRun: () => null, listEvents: () => [], listRuns: () => [] }, events }, createOperationId: () => 'generated-op', ownership: { run: allow, interaction: allow, watch: allow } }));
  server = app.listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}

async function request(method: string, path: string, body?: unknown, user?: string, operationId?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (user) headers['x-user'] = user;
  if (operationId) headers['x-idempotency-key'] = operationId;
  const response = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { response, body: await response.json().catch(() => null) as any };
}

describe('Agent Run REST routes', () => {
  test('Run-origin service spawns preserve the exact durable Parent Attempt id', async () => {
    let forwarded: any;
    const service = new AgentRunApiService({
      async spawn(input: any) { forwarded = input; return run(); },
      async start() { return run(); },
    } as any, {} as any, {} as any);
    await service.spawn('owner-a', {
      ...spawn, invocationMode: AgentRunInvocationMode.Delegated,
      parentRunId: 'parent-run', parentAttemptId: 'parent-attempt',
    }, 'route-spawn');
    assert.equal(forwarded.parentRunId, 'parent-run');
    assert.equal(forwarded.parentAttemptId, 'parent-attempt');
  });

  test('validates saved/ephemeral spawn and forwards durable operation IDs', async () => {
    start();
    const created = await request('POST', '/agent-runs', spawn, undefined, 'spawn-op');
    assert.equal(created.response.status, 201); assert.equal(created.body.run.id, 'run-1'); assert.equal(seenOperation, 'spawn-op');
    const invalid = await request('POST', '/agent-runs', { ...spawn, ephemeralDefinition: effective });
    assert.equal(invalid.response.status, 400); assert.match(invalid.body.error, /exactly one/);
    assert.equal((await request('POST', '/agent-runs', spawn, undefined, 'x'.repeat(257))).response.status, 400);
  });

  test('parses bounded list/search filters and exposes authoritative detail/events', async () => {
    start();
    const listed = await request('GET', '/agent-runs?workspaceId=ws-a&status=running&includeArchived=true&q=work&limit=25');
    assert.equal(listed.response.status, 200); assert.equal(listed.body.runs.length, 1);
    assert.deepEqual(seenQuery, { version: 1, workspaceId: 'ws-a', statuses: ['running'], q: 'work', includeArchived: true, limit: 25 });
    assert.equal((await request('GET', '/agent-runs?workspaceId=ws-a&includeArchived=maybe')).response.status, 400);
    assert.equal((await request('GET', '/agent-runs/run-1')).body.run.id, 'run-1');
    assert.deepEqual((await request('GET', '/agent-runs/run-1/events?afterSeq=-1')).body.events, []);
  });

  test('wrong-owner detail and event reads are hidden with 404 semantics', async () => {
    process.env.MICHI_CLOUD = '1'; start();
    assert.equal((await request('GET', '/agent-runs/run-1', undefined, 'owner-b')).response.status, 404);
    assert.equal((await request('GET', '/agent-runs/run-1/events', undefined, 'owner-b')).response.status, 404);
  });
});
