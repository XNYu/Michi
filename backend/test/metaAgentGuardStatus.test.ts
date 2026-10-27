import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime';
// Must stay first: agentConfig would otherwise persist these fixtures to ~/.michi/config.json.
import './isolatedConfigDir';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  CHAT_STREAM_EVENTS, META_AGENT_GUARD_ERROR_CODE, encodeChatStreamEvent, parseChatStreamEvent,
} from 'michi-shared';
import { ChatHub } from '../src/agents/chatHub';
import { recordAssistantGuardCheck } from '../src/assistant/binding';
import { ensureAssistant } from '../src/assistant/store';
import {
  META_AGENT_GUARD_ERROR_CODE as GUARD_CODE, MetaAgentGuardError, metaAgentCatalogUnavailable, type MetaAgentGuardViolation,
} from '../src/agents/metaAgentGuard';
import type { AgentRuntime, AgentSession } from '../src/agents/types';
import { registerRuntime } from '../src/agents/registry';
import { updateAgentConfig } from '../src/services/agentConfig';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { closeDb, getDb, initDb } from '../src/services/db';
import { saveWorkspace } from '../src/services/dbRepository';
import {
  getMetaAgentGuardStatus, metaAgentGuardFailureOf, onMetaAgentGuardRetry, recordMetaAgentGuardCheck, retryMetaAgentGuard,
  type MetaAgentRunProfile,
} from '../src/services/metaAgent/guardStatus';
import { metaAgentInfo, resolveMetaAgentRuntime, updateMetaAgentSettings } from '../src/services/metaAgent/settings';
import { ChatScheduledJobExecutor } from '../src/services/scheduledJobs/chatExecutor';
import type { ScheduledJobRecord, ScheduledJobRunRecord } from '../src/services/scheduledJobs/repository';
import { chatStreamErrorCode, createChatStreamError, toChatStreamEvent } from '../src/routes/chatStreamEvents';
import { setupMetaAgentRoutes } from '../src/routes/metaAgent';

function fakeRuntime(id: string): AgentRuntime {
  return {
    id, label: id,
    descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
    capabilities: {
      modes: false, permissions: true, models: true, providerModels: false,
      reasoning: true, supportedReasoningLevels: ['low', 'medium', 'high'], apiKeys: false,
      warmSessions: false, saveContext: false, spawnBranches: false, nativeResume: false,
    },
    listModels: async () => [{ id: 'auto', isDefault: true, supportsReasoning: false }],
    async warm() {},
    async newSession() { throw new Error('not used'); },
    async releaseSession() {},
    async shutdown() {},
  };
}
for (const id of ['claude', 'pi', 'codex', 'kiro', 'crew']) registerRuntime(fakeRuntime(id));

const VIOLATIONS: MetaAgentGuardViolation[] = [
  { runtimeId: 'claude', toolset: 'chat', unexpectedTools: ['native:Bash', 'native:Read'] },
  { runtimeId: 'pi', toolset: 'maintenance', unexpectedTools: ['bash'] },
  { runtimeId: 'codex', toolset: 'chat', unexpectedTools: ['mcp_server:github'], detail: 'still open after the lockdown' },
  { runtimeId: 'kiro', toolset: 'maintenance', unexpectedTools: ['desk_now'] },
  { runtimeId: 'kiro', toolset: 'chat', unexpectedTools: [], detail: 'Kiro did not select the Meta agent: Mode (michi-meta) not found' },
];
const failureOf = ({ toolset: _toolset, ...rest }: MetaAgentGuardViolation) => rest;

let tmpDir: string;
const priorCloud = process.env.MICHI_CLOUD;
const priorDataDir = process.env.MICHI_DATA_DIR;

function profile(runtimeId: string, modelId: string | null = null): MetaAgentRunProfile {
  return { runtimeId, providerId: null, modelId, reasoning: null };
}

describe('Meta agent restriction check results', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-guard-status-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb(); initDb();
    updateAgentConfig({ runtime: 'kiro' });
  });

  afterEach(() => {
    closeDb();
    if (priorCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = priorCloud;
    if (priorDataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = priorDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('reading a failure back', () => {
    test('from the error, its message, or a runtime_error text', () => {
      for (const violation of VIOLATIONS) {
        const error = new MetaAgentGuardError(violation);
        assert.deepEqual(metaAgentGuardFailureOf(error), failureOf(violation));
        assert.deepEqual(metaAgentGuardFailureOf(error.message), failureOf(violation), error.message);
        assert.deepEqual(metaAgentGuardFailureOf(new Error(error.message)), failureOf(violation));
      }
      assert.deepEqual(metaAgentGuardFailureOf(metaAgentCatalogUnavailable('kiro', 'chat', 'no catalog (after 30s)')),
        { runtimeId: 'kiro', unexpectedTools: [], detail: 'no catalog (after 30s)' });
    });

    test('anything else is not a restriction failure', () => {
      assert.equal(metaAgentGuardFailureOf('Pi provider rate limited'), null);
      assert.equal(metaAgentGuardFailureOf(`Retry failed: ${new MetaAgentGuardError(VIOLATIONS[0]).message}`), null);
      assert.equal(metaAgentGuardFailureOf({ code: GUARD_CODE }), null);
      assert.equal(metaAgentGuardFailureOf(null), null);
    });
  });

  test('one result per toolset, cleared once the profile a run would use changes', () => {
    recordMetaAgentGuardCheck({ toolset: 'maintenance', profile: profile('kiro'), failure: failureOf(VIOLATIONS[3]), now: 10 });
    recordMetaAgentGuardCheck({ toolset: 'chat', profile: profile('kiro'), failure: null, now: 11 });
    assert.deepEqual(getMetaAgentGuardStatus('maintenance', () => profile('kiro')),
      { state: 'failed', runtimeId: 'kiro', toolset: 'maintenance', unexpectedTools: ['desk_now'], checkedAt: 10 });
    assert.deepEqual(getMetaAgentGuardStatus('chat', () => profile('kiro')),
      { state: 'ok', runtimeId: 'kiro', toolset: 'chat', unexpectedTools: [], checkedAt: 11 });

    assert.equal(getMetaAgentGuardStatus('maintenance', () => profile('kiro', 'other-model')), null);
    assert.equal(getMetaAgentGuardStatus('maintenance', () => profile('kiro')), null, 'a stale result is deleted, not hidden');
    assert.equal(getMetaAgentGuardStatus('chat', () => profile('claude')), null);
  });

  test('cloud keeps results per owner', () => {
    process.env.MICHI_CLOUD = '1';
    recordMetaAgentGuardCheck({ toolset: 'chat', profile: profile('pi'), failure: failureOf(VIOLATIONS[1]), ownerUserId: 'u1' });
    assert.equal(getMetaAgentGuardStatus('chat', () => profile('pi'), 'u1')?.state, 'failed');
    assert.equal(getMetaAgentGuardStatus('chat', () => profile('pi'), 'u2'), null);
    assert.throws(() => getMetaAgentGuardStatus('chat', () => profile('pi')), /authenticated owner/);
  });

  describe('MetaAgentInfo.guard', () => {
    const resolvedNow = () => {
      const { followsGlobal: _f, ...run } = resolveMetaAgentRuntime();
      return run;
    };

    test('reports the stored results for the resolved runtime', () => {
      recordMetaAgentGuardCheck({ toolset: 'maintenance', profile: resolvedNow(), failure: failureOf(VIOLATIONS[3]), now: 5 });
      assert.deepEqual(metaAgentInfo().guard, {
        maintenance: { state: 'failed', runtimeId: 'kiro', toolset: 'maintenance', unexpectedTools: ['desk_now'], checkedAt: 5 },
        chat: null,
      });
    });

    test('a changed Meta agent setting, or a followed global runtime change, clears it', () => {
      recordMetaAgentGuardCheck({ toolset: 'maintenance', profile: resolvedNow(), failure: failureOf(VIOLATIONS[3]) });
      updateMetaAgentSettings({ runtimeId: 'kiro', reasoning: 'low' });
      assert.equal(metaAgentInfo().guard.maintenance, null);

      updateMetaAgentSettings({ runtimeId: null });
      recordMetaAgentGuardCheck({ toolset: 'chat', profile: resolvedNow(), failure: failureOf(VIOLATIONS[4]) });
      assert.equal(metaAgentInfo().guard.chat?.state, 'failed');
      updateAgentConfig({ runtime: 'claude' });
      assert.equal(metaAgentInfo().guard.chat, null);
      updateAgentConfig({ runtime: 'kiro' });
      assert.equal(metaAgentInfo().guard.chat, null, 'switching back does not bring an old failure back');
    });
  });

  describe('routes', () => {
    let server: http.Server;
    let base: string;

    beforeEach(async () => {
      const app = express();
      app.use(express.json());
      app.use('/api', setupMetaAgentRoutes());
      server = app.listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    });

    function call(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
      const url = new URL(base);
      return new Promise((resolve, reject) => {
        const req = http.request({
          host: url.hostname, port: url.port, method, path: p,
          headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
        }, (res) => {
          let text = '';
          res.on('data', (c) => { text += c; });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined }));
        });
        req.on('error', reject);
        if (body !== undefined) req.write(JSON.stringify(body));
        req.end();
      });
    }

    function seedFailures(): void {
      const { followsGlobal: _f, ...run } = resolveMetaAgentRuntime();
      recordMetaAgentGuardCheck({ toolset: 'maintenance', profile: run, failure: failureOf(VIOLATIONS[3]) });
      recordMetaAgentGuardCheck({ toolset: 'chat', profile: run, failure: failureOf(VIOLATIONS[4]) });
    }

    test('GET carries the failures; retry clears one toolset or both and answers MetaAgentInfo', async () => {
      seedFailures();
      const before = await call('GET', '/api/meta-agent');
      assert.equal(before.body.guard.maintenance.state, 'failed');
      assert.equal(before.body.guard.chat.detail, VIOLATIONS[4].detail);

      const chatOnly = await call('POST', '/api/meta-agent/retry', { toolset: 'chat' });
      assert.equal(chatOnly.status, 200, JSON.stringify(chatOnly.body));
      assert.equal(chatOnly.body.guard.chat, null);
      assert.equal(chatOnly.body.guard.maintenance.state, 'failed');
      assert.deepEqual(chatOnly.body, metaAgentInfo());

      const both = await call('POST', '/api/meta-agent/retry');
      assert.equal(both.status, 200);
      assert.deepEqual(both.body.guard, { maintenance: null, chat: null });
    });

    test('retry validates its body and is local-only', async () => {
      seedFailures();
      assert.equal((await call('POST', '/api/meta-agent/retry', { toolset: 'shell' })).status, 400);
      assert.equal((await call('POST', '/api/meta-agent/retry', { toolset: 'chat', extra: 1 })).status, 400);
      assert.equal((await call('POST', '/api/meta-agent/retry', ['chat'])).status, 400);
      assert.equal((await call('POST', '/api/meta-agent/retry', {}, { origin: 'https://evil.example' })).status, 403);
      assert.equal(metaAgentInfo().guard.maintenance?.state, 'failed', 'a refused retry clears nothing');
      assert.equal((await call('POST', '/api/meta-agent/retry', {})).body.guard.maintenance, null);
    });

    test('a settings change through PUT clears a failure', async () => {
      seedFailures();
      const set = await call('PUT', '/api/meta-agent/settings', { runtimeId: 'codex' });
      assert.deepEqual(set.body.guard, { maintenance: null, chat: null });
    });
  });

  test('retry tells listeners which owner and toolsets were cleared', () => {
    const seen: unknown[] = [];
    const off = onMetaAgentGuardRetry((event) => seen.push(event));
    retryMetaAgentGuard(['maintenance']);
    off();
    retryMetaAgentGuard(['chat']);
    assert.deepEqual(seen, [{ ownerKey: 'desktop', toolsets: ['maintenance'] }]);
  });

  describe('the error frame code', () => {
    test('a guard failure is coded whether it was thrown or reported as text', () => {
      assert.equal(GUARD_CODE, META_AGENT_GUARD_ERROR_CODE);
      const error = new MetaAgentGuardError(VIOLATIONS[3]);
      assert.equal(chatStreamErrorCode(error), META_AGENT_GUARD_ERROR_CODE);
      assert.equal(chatStreamErrorCode(new Error(new MetaAgentGuardError(VIOLATIONS[0]).message)), META_AGENT_GUARD_ERROR_CODE);
      assert.equal(chatStreamErrorCode(Object.assign(new Error('expired'), { acpErrorKind: 'auth' })), 'auth');
      assert.equal(chatStreamErrorCode(Object.assign(new Error('gone'), { code: 'PI_SESSION_DISPOSED' })), undefined);
      assert.equal(chatStreamErrorCode(new Error('boom')), undefined);
    });

    test('a runtime_error event keeps its code on the error that ends the turn', () => {
      const event: NormalizedEvent = { kind: 'runtime_error', error: 'stopped', code: META_AGENT_GUARD_ERROR_CODE };
      assert.throws(() => toChatStreamEvent(event), (thrown: unknown) => chatStreamErrorCode(thrown) === META_AGENT_GUARD_ERROR_CODE);
      assert.throws(() => toChatStreamEvent({ kind: 'runtime_error', error: 'plain' }), (thrown: unknown) => chatStreamErrorCode(thrown) === undefined);
    });

    test('the code survives the SSE codec', () => {
      const error = new MetaAgentGuardError(VIOLATIONS[3]);
      const frame = encodeChatStreamEvent(createChatStreamError(error.message, chatStreamErrorCode(error)));
      const parsed = parseChatStreamEvent(frame.match(/^event: (.+)$/m)![1], frame.match(/^data: (.+)$/m)![1]);
      assert.equal(parsed?.event, CHAT_STREAM_EVENTS.error);
      assert.equal(parsed?.event === CHAT_STREAM_EVENTS.error ? parsed.data.code : null, META_AGENT_GUARD_ERROR_CODE);
      assert.equal(parsed?.event === CHAT_STREAM_EVENTS.error ? parsed.data.message : null, error.message);
      assert.deepEqual(createChatStreamError('plain'), { event: CHAT_STREAM_EVENTS.error, data: { message: 'plain' } });
    });
  });

  describe('the chat window', () => {
    test('an assistant conversation records its check; other chats and other errors do not', () => {
      const assistant = ensureAssistant();
      saveWorkspace({ id: 'ws-plain', name: 'Plain', cwd: tmpDir, created_at: 1, updated_at: 1, active_tree_id: null });
      getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,created_at) VALUES('plain-node','ws-plain','chat','idle',1)").run();
      const guardError = new MetaAgentGuardError({ runtimeId: 'kiro', toolset: 'chat', unexpectedTools: ['fs_write'] });

      recordAssistantGuardCheck('plain-node', guardError);
      recordAssistantGuardCheck(assistant.nodeId, new Error('Kiro is not signed in'));
      assert.equal(metaAgentInfo().guard.chat, null);

      recordAssistantGuardCheck(assistant.nodeId, guardError.message);
      assert.deepEqual(metaAgentInfo().guard.chat,
        { state: 'failed', runtimeId: 'kiro', toolset: 'chat', unexpectedTools: ['fs_write'], checkedAt: metaAgentInfo().guard.chat!.checkedAt });
      assert.equal(metaAgentInfo().guard.maintenance, null);

      recordAssistantGuardCheck(assistant.nodeId, new MetaAgentGuardError({ runtimeId: 'claude', toolset: 'chat', unexpectedTools: ['x'] }));
      assert.deepEqual(metaAgentInfo().guard.chat?.unexpectedTools, ['fs_write'], 'a failure from another runtime is not this profile\'s');

      recordAssistantGuardCheck(assistant.nodeId, null);
      assert.equal(metaAgentInfo().guard.chat?.state, 'ok');
    });
  });

  describe('what a scheduled run sees from each runtime', () => {
    function iterator(events: NormalizedEvent[], failWith?: unknown): AsyncIterableIterator<NormalizedEvent> {
      let index = 0;
      return {
        [Symbol.asyncIterator]() { return this; },
        async next() {
          if (failWith) throw failWith;
          return index < events.length ? { done: false, value: events[index++] } : { done: true, value: undefined };
        },
      };
    }

    const job: ScheduledJobRecord = {
      id: 'job-1', ownerUserId: null, workspaceId: 'ws-1', name: 'Digest', prompt: 'Summarize',
      schedule: { kind: 'every', everySeconds: 3600 }, runtimeId: 'kiro', providerId: null, modelId: 'auto',
      reasoning: null, permissionMode: 'trust', sessionMode: 'fresh', persistentNodeId: null, notify: false,
      enabled: true, autoPaused: false, consecutiveFailures: 0, timeoutSeconds: 1800, nextRunAt: null,
      lastRunAt: null, lastStatus: null, lastError: null, createdAt: 1, updatedAt: 1,
    };

    function executor(session: (nodeId: string) => Promise<AgentSession>): ChatScheduledJobExecutor {
      return new ChatScheduledJobExecutor({
        chatHub: new ChatHub({ retentionMs: 100 }),
        getRuntime: (id) => (id === 'kiro' ? fakeRuntime('kiro') : undefined),
        ensureSession: async (input) => session(input.nodeId),
      });
    }

    const sessionWith = (send: () => AsyncIterableIterator<NormalizedEvent>) => async (nodeId: string): Promise<AgentSession> => ({
      id: nodeId, runtimeId: 'kiro', getHistory: () => [], getPendingAssistant: () => undefined, send, cancel: () => {},
    });

    beforeEach(() => {
      saveWorkspace({ id: 'ws-1', name: 'Research', cwd: tmpDir, created_at: 1, updated_at: 1, active_tree_id: null });
    });

    async function turnError(worker: ChatScheduledJobExecutor): Promise<string | null> {
      const handle = await worker.start(job, { id: 'run-1' } as ScheduledJobRunRecord, { onAttention() {} });
      const outcome = await handle.done;
      assert.equal(outcome.status, 'failed');
      return outcome.error;
    }

    test('Pi and Kiro throw from send; the stored turn error still reads back', async () => {
      for (const violation of [VIOLATIONS[1], VIOLATIONS[3]]) {
        const error = await turnError(executor(sessionWith(() => iterator([], new MetaAgentGuardError(violation)))));
        assert.deepEqual(metaAgentGuardFailureOf(error), failureOf(violation));
      }
    });

    test('Claude reports a runtime_error event; the stored turn error still reads back', async () => {
      const violation = VIOLATIONS[0];
      const error = await turnError(executor(sessionWith(() => iterator([
        { kind: 'runtime_error', error: new MetaAgentGuardError(violation).message },
      ]))));
      assert.deepEqual(metaAgentGuardFailureOf(error), failureOf(violation));
      assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM turns WHERE status = 'error'").get() as { n: number }).n, 1);
    });

    test('Codex and Kiro refuse to open the session; start rejects with the guard error itself', async () => {
      for (const violation of [VIOLATIONS[2], VIOLATIONS[4]]) {
        const thrown = new MetaAgentGuardError(violation);
        await assert.rejects(executor(async () => { throw thrown; }).start(job, { id: 'run-1' } as ScheduledJobRunRecord, { onAttention() {} }),
          (error: unknown) => error === thrown);
      }
    });
  });
});
