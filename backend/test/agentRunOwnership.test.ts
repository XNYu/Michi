import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import {
  requireAgentDefinitionOwner,
  requireAgentRunInteractionOwner,
  requireAgentRunOwner,
  requireAgentRunWatchOwner,
} from '../src/routes/middleware/agentOwnership';

let tmpDir: string;

function invoke(middleware: Function, params: Record<string, string>, userId?: string) {
  let next = false; let status: number | undefined; let body: unknown;
  const req = { params, user: userId ? { id: userId } : undefined };
  const res = { status(code: number) { status = code; return this; }, json(value: unknown) { body = value; return this; } } as any;
  middleware(req, res, () => { next = true; });
  return { next, status, body };
}

describe('Custom Agent ownership middleware', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-agent-owner-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb(); initDb();
    getDb().prepare("INSERT INTO workspaces (id,name,owner_user_id,created_at,updated_at) VALUES ('ws-a','A','owner-a',1,1)").run();
    getDb().prepare(`INSERT INTO agent_definitions (id,owner_user_id,scope,workspace_id,name,instructions,
      runtime_profile,context_policy,created_at,updated_at) VALUES
      ('def-a','owner-a','workspace','ws-a','A','A','{"version":1}','{"version":1}',1,1)`).run();
    getDb().prepare(`INSERT INTO agent_runs (id,owner_user_id,workspace_id,effective_definition,invocation_mode,completion_mode,
      task,context_manifest,execution_environment,status,created_at,updated_at) VALUES
      ('run-a','owner-a','ws-a','{"version":1}','manual','detach','task','{"version":1}','{"version":1}','queued',1,1)`).run();
    getDb().prepare(`INSERT INTO agent_run_interactions (id,run_id,type,request_payload,created_at)
      VALUES ('interaction-a','run-a','permission','{"version":1}',1)`).run();
    getDb().prepare(`INSERT INTO agent_run_watches (id,owner_user_id,workspace_id,condition,completion_behavior,
      status,created_at,updated_at) VALUES ('watch-a','owner-a','ws-a','{"version":1}','notify','active',1,1)`).run();
  });
  afterEach(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('owner passes every resource middleware', () => {
    assert.equal(invoke(requireAgentDefinitionOwner, { agentId: 'def-a' }, 'owner-a').next, true);
    assert.equal(invoke(requireAgentRunOwner, { runId: 'run-a' }, 'owner-a').next, true);
    assert.equal(invoke(requireAgentRunInteractionOwner, { runId: 'run-a', interactionId: 'interaction-a' }, 'owner-a').next, true);
    assert.equal(invoke(requireAgentRunWatchOwner, { watchId: 'watch-a' }, 'owner-a').next, true);
  });

  test('wrong, missing, and unauthenticated owners receive indistinguishable 404 responses', () => {
    for (const result of [
      invoke(requireAgentDefinitionOwner, { agentId: 'def-a' }, 'owner-b'),
      invoke(requireAgentRunOwner, { runId: 'missing' }, 'owner-a'),
      invoke(requireAgentRunInteractionOwner, { runId: 'run-a', interactionId: 'interaction-a' }),
      invoke(requireAgentRunWatchOwner, {}, 'owner-a'),
    ]) {
      assert.equal(result.next, false);
      assert.equal(result.status, 404);
      assert.deepEqual(result.body, { error: 'not_found' });
    }
  });
});
