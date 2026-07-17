import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { initDb, closeDb, getDb } from '../src/services/db';
import { getNode, listMessages } from '../src/services/dbRepository';
import { setupMichiRoutes } from '../src/routes/michi';
import { setupPersistenceRoutes } from '../src/routes/persistence';
import { registerRuntime } from '../src/agents/registry';
import { clearAllSessions } from '../src/agents/sessionRegistry';
import { loadAgentConfig } from '../src/services/agentConfig';
import { computeTranscriptFingerprint } from '../src/services/resumeStrategy';
import type {
  AgentRuntime,
  AgentSession,
  LoadAgentSessionOptions,
  NewAgentSessionOptions,
} from '../src/agents/types';
import type { NormalizedEvent } from '../src/services/chatEvents';
import type { ChatManager } from '../src/services/chatManager';

const enabled = process.env.MICHI_REAL_DB_E2E === '1';

interface KiroBinding {
  id: string;
  acp_session_id: string;
  model_id: string | null;
  resume_fingerprint: string;
}

function transcriptFor(nodeId: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  return listMessages(nodeId)
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: message.content,
    }));
}

function findExactResumeCandidate(): KiroBinding {
  const rows = getDb().prepare(`
    SELECT id, acp_session_id, model_id, resume_fingerprint
      FROM nodes
     WHERE runtime_id = 'kiro'
       AND acp_session_id IS NOT NULL
       AND acp_session_id <> id
       AND resume_fingerprint IS NOT NULL
       AND purged_at IS NULL
     ORDER BY created_at DESC
  `).all() as unknown as KiroBinding[];
  const match = rows.find((row) =>
    computeTranscriptFingerprint(transcriptFor(row.id)) === row.resume_fingerprint,
  );
  assert.ok(match, 'copied DB must contain a Kiro row with a current resume fingerprint');
  return match;
}

class FakeKiroSession implements AgentSession {
  readonly runtimeId = 'kiro';
  readonly currentModeId = null;
  readonly currentModelId: string | null;

  constructor(
    readonly id: string,
    readonly nativeSessionId: string,
    modelId: string | null,
  ) {
    this.currentModelId = modelId;
  }

  getHistory() { return []; }
  getPendingAssistant() { return undefined; }

  async *send(text: string): AsyncIterableIterator<NormalizedEvent> {
    yield { kind: 'chunk', text: `identity-e2e:${text}` };
    yield { kind: 'turn_end', stopReason: 'end_turn' };
  }

  async cancel(): Promise<void> {}
}

test('unified node identity against an online backup of the real DB', { skip: !enabled }, async () => {
  assert.ok(process.env.MICHI_DATA_DIR, 'MICHI_DATA_DIR must point to an isolated DB backup');
  assert.ok(process.env.MICHI_REAL_DB_SOURCE_DIR, 'MICHI_REAL_DB_SOURCE_DIR must identify the source DB directory');
  assert.notEqual(
    path.resolve(process.env.MICHI_DATA_DIR),
    path.resolve(process.env.MICHI_REAL_DB_SOURCE_DIR),
    'the real DB must never be used directly',
  );

  initDb();
  loadAgentConfig();
  const candidate = findExactResumeCandidate();
  const initialNodeCount = (getDb().prepare('SELECT count(*) AS count FROM nodes').get() as { count: number }).count;
  const initialMessageCount = (getDb().prepare('SELECT count(*) AS count FROM messages').get() as { count: number }).count;
  const loadCalls: LoadAgentSessionOptions[] = [];

  const runtime: AgentRuntime = {
    id: 'kiro',
    label: 'Kiro identity E2E fake',
    capabilities: {
      modes: false,
      permissions: false,
      models: true,
      providerModels: false,
      reasoning: false,
      supportedReasoningLevels: [],
      apiKeys: false,
      warmSessions: false,
      saveContext: false,
      spawnBranches: false,
      nativeResume: true,
    },
    async warm() {},
    async newSession(opts: NewAgentSessionOptions) {
      const nodeId = opts.sessionId ?? `unexpected-${Date.now()}`;
      return new FakeKiroSession(nodeId, `fresh-${nodeId}`, opts.model ?? null);
    },
    async loadSession(opts: LoadAgentSessionOptions) {
      loadCalls.push(opts);
      const nodeId = opts.nodeId ?? opts.sessionId;
      const row = getNode(nodeId);
      assert.ok(row?.acp_session_id, 'exact resume must read the persisted native session id');
      return new FakeKiroSession(nodeId, row.acp_session_id, row.model_id ?? null);
    },
    async releaseSession() {},
    async shutdown() {},
  };
  registerRuntime(runtime);

  const app = express();
  app.use(express.json());
  app.use('/api', setupPersistenceRoutes());
  app.use('/api', setupMichiRoutes({} as ChatManager));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

  try {
    const allocated = await fetch(`${baseUrl}/node-ids/allocate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ count: 3 }),
    });
    assert.equal(allocated.status, 200);
    const allocationBody = await allocated.json() as { nodeIds: string[] };
    assert.equal(allocationBody.nodeIds.length, 3);
    assert.ok(allocationBody.nodeIds.every((id) => /^n-[0-9a-f-]{36}$/.test(id)));
    assert.equal(
      (getDb().prepare('SELECT count(*) AS count FROM nodes').get() as { count: number }).count,
      initialNodeCount,
      'allocating ids must not create DB rows',
    );

    const priorMessages = transcriptFor(candidate.id);
    const ensure = await fetch(`${baseUrl}/nodes/${candidate.id}/ensure-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: candidate.model_id,
        priorMessages,
        resumeFingerprint: candidate.resume_fingerprint,
      }),
    });
    assert.equal(ensure.status, 200);
    const ensured = await ensure.json() as {
      chatId: string;
      resumeStrategy: string;
    };
    assert.equal(ensured.chatId, candidate.id);
    assert.equal(ensured.resumeStrategy, 'exact');
    assert.equal(loadCalls.length, 1);
    assert.equal(loadCalls[0].sessionId, candidate.id);
    assert.equal(loadCalls[0].nodeId, candidate.id);

    const streamed = await fetch(`${baseUrl}/chats/${candidate.acp_session_id}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'without-body-node-id' }),
    });
    assert.equal(streamed.status, 200);
    const streamText = await streamed.text();
    assert.match(streamText, /identity-e2e:without-body-node-id/);
    assert.match(streamText, /event: done/);
    assert.equal(
      (getDb().prepare('SELECT count(*) AS count FROM messages').get() as { count: number }).count,
      initialMessageCount + 2,
      'the copied DB should persist the user and assistant messages under the node',
    );

    clearAllSessions();
    const restartedRow = getNode(candidate.id);
    assert.ok(restartedRow?.resume_fingerprint);
    const restartedEnsure = await fetch(`${baseUrl}/nodes/${candidate.id}/ensure-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: restartedRow.model_id,
        priorMessages: transcriptFor(candidate.id),
        resumeFingerprint: restartedRow.resume_fingerprint,
      }),
    });
    assert.equal(restartedEnsure.status, 200);
    const restarted = await restartedEnsure.json() as { chatId: string; resumeStrategy: string };
    assert.equal(restarted.chatId, candidate.id);
    assert.equal(restarted.resumeStrategy, 'exact');
    assert.equal(loadCalls.length, 2, 'restart must exact-resume through the node id again');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearAllSessions();
    closeDb();
  }
});
