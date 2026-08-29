import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { AgentRunEventBus } from '../src/agents/runs/agentRunEventBus';
import { setupAgentRunRoutes, type AgentRunRouteService } from '../src/routes/agentRuns';
import type { AgentRunInteractionDtoV1, AgentRunWatchDtoV1 } from 'michi-shared';

let server: ReturnType<typeof express.application.listen>;
let base = '';
afterEach(async () => { if (server) await new Promise<void>((resolve) => server.close(() => resolve())); });

function start() {
  const operations: string[] = [];
  const interaction: AgentRunInteractionDtoV1 = { version: 1, id: 'interaction-1', runId: 'run-1', attemptId: 'attempt-1', kind: 'user_input', status: 'resolved', request: { prompt: 'Continue?' }, response: { text: 'yes' }, createdAt: 1, resolvedAt: 2 };
  const watch: AgentRunWatchDtoV1 = { version: 1, id: 'watch-1', ownerUserId: 'local-user', workspaceId: 'ws-a', runIds: ['run-1'], condition: { version: 1, kind: 'all' }, completionMode: 'notify', status: 'active', deliveryId: 'delivery-1', requestedTurnId: 'turn-1', parentRunId: null, parentNodeId: null, parentTurnId: null, createdAt: 1, firedAt: null };
  const service: AgentRunRouteService = {
    async spawn() { throw new Error('unused'); }, list() { return []; }, getDetail() { return null; }, events() { return null; },
    async input(_owner, runId, _request, operationId) { operations.push(`input:${runId}:${operationId}`); return runId === 'run-1'; },
    async cancel(_owner, runId, _request, operationId) { operations.push(`cancel:${runId}:${operationId}`); return runId === 'run-1'; },
    async respond(_owner, runId, interactionId, _request, operationId) { operations.push(`respond:${operationId}`); return runId === 'run-1' && interactionId === 'interaction-1' ? interaction : null; },
    createWatch(_owner, _request, operationId) { operations.push(`watch:${operationId}`); return watch; },
    updateWatch(_owner, watchId) { return watchId === 'watch-1' ? { ...watch, runIds: ['run-1', 'run-2'] } : null; },
  };
  const app = express(); app.use(express.json());
  const allow = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
  app.use('/api', setupAgentRunRoutes({ service, sse: { source: { getRun: () => null, listEvents: () => [], listRuns: () => [] }, events: new AgentRunEventBus() }, createOperationId: () => 'generated-op', ownership: { run: allow, interaction: allow, watch: allow } }));
  server = app.listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  return operations;
}

async function post(path: string, body: unknown, operationId = 'same-op') {
  const response = await fetch(`${base}${path}`, { method: path.includes('watch-1') ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json', 'x-idempotency-key': operationId }, body: JSON.stringify(body) });
  return { response, body: await response.json().catch(() => null) as any };
}

describe('Agent Run interaction/cancel/watch routes', () => {
  test('repeated cancellation and interaction responses retain the caller operation ID', async () => {
    const operations = start();
    const cancel = { version: 1, expectedAttemptId: 'attempt-1', reason: 'stop' };
    assert.equal((await post('/agent-runs/run-1/cancel', cancel)).response.status, 202);
    assert.equal((await post('/agent-runs/run-1/cancel', cancel)).response.status, 202);
    const response = await post('/agent-runs/run-1/interactions/interaction-1/respond', { version: 1, response: { text: 'yes' } }, 'respond-op');
    assert.equal(response.response.status, 200); assert.equal(response.body.interaction.status, 'resolved');
    assert.deepEqual(operations.slice(0, 2), ['cancel:run-1:same-op', 'cancel:run-1:same-op']);
    assert.ok(operations.includes('respond:respond-op'));
  });

  test('wrong Run/Interaction/Watch IDs return 404 and secret-bearing responses are rejected', async () => {
    start();
    assert.equal((await post('/agent-runs/missing/input', { version: 1, text: 'x', mode: 'queued', expectedAttemptId: null })).response.status, 404);
    assert.equal((await post('/agent-runs/run-1/interactions/missing/respond', { version: 1, response: {} })).response.status, 404);
    const secret = await post('/agent-runs/run-1/interactions/interaction-1/respond', { version: 1, response: { apiKey: 'nope' } });
    assert.equal(secret.response.status, 400);
    assert.equal((await post('/agent-run-watches/missing', { version: 1, addRunIds: ['run-2'] })).response.status, 404);
  });

  test('creates and updates bounded Watches', async () => {
    start();
    const created = await post('/agent-run-watches', { version: 1, workspaceId: 'ws-a', runIds: ['run-1'], condition: { version: 1, kind: 'all' }, completionMode: 'notify', parentRunId: null, parentNodeId: null, parentTurnId: null }, 'watch-op');
    assert.equal(created.response.status, 201); assert.equal(created.body.watch.id, 'watch-1');
    const updated = await post('/agent-run-watches/watch-1', { version: 1, addRunIds: ['run-2'] });
    assert.deepEqual(updated.body.watch.runIds, ['run-1', 'run-2']);
  });
});
