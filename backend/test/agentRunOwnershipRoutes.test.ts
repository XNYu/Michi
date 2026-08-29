import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { closeDb, getDb, initDb } from '../src/services/db';
import { AgentRunEventBus } from '../src/agents/runs/agentRunEventBus';
import { setupAgentRunRoutes, type AgentRunRouteService } from '../src/routes/agentRuns';

let tmpDir: string;
let server: ReturnType<typeof express.application.listen>;
let base: string;
let serviceCalls: string[];

function seed(): void {
  getDb().prepare("INSERT INTO workspaces (id,name,owner_user_id,created_at,updated_at) VALUES ('ws-a','A','owner-a',1,1)").run();
  for (const runId of ['run-a', 'run-b']) {
    getDb().prepare(`INSERT INTO agent_runs (id,owner_user_id,workspace_id,effective_definition,invocation_mode,completion_mode,
      task,context_manifest,execution_environment,status,created_at,updated_at) VALUES
      (?,'owner-a','ws-a','{"version":1}','manual','detach','task','{"version":1}','{"version":1}','queued',1,1)`).run(runId);
  }
  getDb().prepare(`INSERT INTO agent_run_interactions (id,run_id,type,request_payload,created_at)
    VALUES ('interaction-a','run-a','permission','{"version":1}',1),
           ('interaction-b','run-b','permission','{"version":1}',1)`).run();
  getDb().prepare(`INSERT INTO agent_run_watches (id,owner_user_id,workspace_id,condition,completion_behavior,
    status,created_at,updated_at) VALUES ('watch-a','owner-a','ws-a','{"version":1}','notify','active',1,1)`).run();
}

function start(): void {
  const service: AgentRunRouteService = {
    async spawn() { throw new Error('unused'); },
    list() { return []; },
    getDetail(owner, runId) { serviceCalls.push(`detail:${owner}:${runId}`); return { run: { id: runId } as never, attempts: [], events: [], interactions: [] }; },
    events(owner, runId) { serviceCalls.push(`events:${owner}:${runId}`); return []; },
    async input(owner, runId) { serviceCalls.push(`input:${owner}:${runId}`); return true; },
    async cancel(owner, runId) { serviceCalls.push(`cancel:${owner}:${runId}`); return true; },
    async respond(owner, runId, interactionId) { serviceCalls.push(`respond:${owner}:${runId}:${interactionId}`); return { id: interactionId } as never; },
    createWatch() { throw new Error('unused'); },
    updateWatch(owner, watchId) { serviceCalls.push(`watch:${owner}:${watchId}`); return { id: watchId } as never; },
  };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { const owner = req.header('x-user'); if (owner) req.user = { id: owner }; next(); });
  app.use('/api', setupAgentRunRoutes({
    service,
    sse: { source: { getRun: () => null, listEvents: () => [], listRuns: () => [] }, events: new AgentRunEventBus() },
  }));
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}

async function request(method: string, route: string, owner: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${route}`, {
    method, headers: { 'content-type': 'application/json', 'x-user': owner },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('Agent Run ownership middleware mounted on production routes', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-agent-route-owner-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    process.env.MICHI_CLOUD = '1';
    closeDb(); initDb(); seed(); serviceCalls = []; start();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb(); delete process.env.MICHI_CLOUD; delete process.env.MICHI_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('wrong owner cannot read or mutate a Run or Watch and never reaches the service', async () => {
    const requests = [
      request('GET', '/agent-runs/run-a', 'owner-b'),
      request('GET', '/agent-runs/run-a/events', 'owner-b'),
      request('POST', '/agent-runs/run-a/input', 'owner-b', { version: 1, text: 'x', mode: 'queued', expectedAttemptId: null }),
      request('POST', '/agent-runs/run-a/cancel', 'owner-b', { version: 1, expectedAttemptId: null, reason: null }),
      request('POST', '/agent-runs/run-a/interactions/interaction-a/respond', 'owner-b', { version: 1, response: {} }),
      request('PATCH', '/agent-run-watches/watch-a', 'owner-b', { version: 1, addRunIds: [] }),
      request('POST', '/agent-runs/run-a/continue-as-branch', 'owner-b', { version: 1, workspaceId: 'ws-a', includeTask: true, includeResult: false, includeTranscript: false, fallback: 'error' }),
    ];
    const responses = await Promise.all(requests);
    assert.deepEqual(responses.map((response) => response.status), responses.map(() => 404));
    assert.deepEqual(serviceCalls, []);
  });

  test('an owned Interaction must also belong to the Run named in the URL', async () => {
    const mismatched = await request('POST', '/agent-runs/run-a/interactions/interaction-b/respond', 'owner-a', { version: 1, response: {} });
    assert.equal(mismatched.status, 404);
    assert.deepEqual(serviceCalls, []);

    const detail = await request('GET', '/agent-runs/run-a', 'owner-a');
    assert.equal(detail.status, 200);
    assert.deepEqual(serviceCalls, ['detail:owner-a:run-a']);
  });
});
