import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime';
// Must stay first: agentConfig would otherwise persist these fixtures to ~/.michi/config.json.
import './isolatedConfigDir';
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { AgentReasoning, AgentRuntime } from '../src/agents/types';
import { registerRuntime } from '../src/agents/registry';
import { closeDb, getDb, initDb } from '../src/services/db';
import { saveWorkspace } from '../src/services/dbRepository';
import { updateAgentConfig } from '../src/services/agentConfig';
import {
  getMetaAgentSettings, MetaAgentSettingsError, metaAgentInfo, resolveMetaAgentBehaviour, resolveMetaAgentRuntime, updateMetaAgentSettings,
} from '../src/services/metaAgent/settings';
import { createRemoteAccessMiddleware } from '../src/services/remoteAccess';
import { setupMetaAgentOverviewRoutes } from '../src/routes/metaAgentOverview';
import { setupMetaAgentRoutes } from '../src/routes/metaAgent';

function fakeRuntime(id: string, providerModels = false): AgentRuntime {
  return {
    id, label: id,
    descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
    capabilities: {
      modes: false, permissions: true, models: true, providerModels,
      reasoning: true, supportedReasoningLevels: ['low', 'medium', 'high'], apiKeys: false,
      warmSessions: false, saveContext: false, spawnBranches: false, nativeResume: false,
    },
    async warm() {},
    async newSession() { throw new Error('not used'); },
    async releaseSession() {},
    async shutdown() {},
  };
}

for (const id of ['claude', 'codex', 'kiro', 'crew']) registerRuntime(fakeRuntime(id));
registerRuntime(fakeRuntime('pi', true));

const priorCloud = process.env.MICHI_CLOUD;
const priorDataDir = process.env.MICHI_DATA_DIR;
let tmpDir: string;

const RUNTIMES = ['claude', 'pi', 'codex', 'kiro', 'crew'];

/** Replaces the global settings: the per-runtime maps merge on update, so every runtime's entry is reset. */
function setGlobal(runtime: string, extra: { model?: string; reasoning?: AgentReasoning; provider?: string } = {}): void {
  const none = Object.fromEntries(RUNTIMES.map((id) => [id, undefined])) as Record<string, never>;
  updateAgentConfig({
    runtime,
    providerByRuntime: { ...none, pi: 'anthropic', ...(extra.provider ? { [runtime]: extra.provider } : {}) },
    modelByRuntime: { ...none, ...(extra.model ? { [runtime]: extra.model } : {}) },
    reasoningByRuntime: { ...none, ...(extra.reasoning ? { [runtime]: extra.reasoning } : {}) },
  });
}

function seedLegacyAssistant(assistant: Record<string, unknown>, createdAt = 1): void {
  saveWorkspace({ id: `p-assistant-${createdAt}`, name: 'Michi assistant', cwd: tmpDir, created_at: createdAt, updated_at: createdAt, settings: null });
  getDb().prepare('UPDATE workspaces SET settings = ? WHERE id = ?')
    .run(JSON.stringify({ system: 'assistant', assistant: { nodeId: null, ...assistant } }), `p-assistant-${createdAt}`);
}

const storedRow = () => getDb().prepare("SELECT value FROM meta WHERE key = 'meta_agent_settings:desktop'").get() as { value: string } | undefined;

const DEFAULTS = { writeWorkspaceHomes: null, maintainSpacesHome: null, firstRunDays: null };
const FOLLOW = { runtimeId: null, providerId: null, modelId: null, reasoning: null, ...DEFAULTS };

describe('Meta agent settings', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-meta-agent-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb(); initDb();
    setGlobal('claude', { model: 'opus', reasoning: 'high' });
  });

  afterEach(() => {
    closeDb();
    if (priorCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = priorCloud;
    if (priorDataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = priorDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('a fresh record follows the global settings', () => {
    assert.deepEqual(getMetaAgentSettings(), FOLLOW);
    assert.deepEqual(resolveMetaAgentRuntime(), { runtimeId: 'claude', providerId: null, modelId: 'opus', reasoning: 'high', followsGlobal: true });
  });

  test('following global, a changed global applies to the next resolution', () => {
    assert.equal(resolveMetaAgentRuntime().runtimeId, 'claude');
    setGlobal('kiro', { model: 'kiro-model', reasoning: 'low' });
    assert.deepEqual(resolveMetaAgentRuntime(), { runtimeId: 'kiro', providerId: null, modelId: 'kiro-model', reasoning: 'low', followsGlobal: true });
    setGlobal('pi', { model: 'pi-model' });
    const pi = resolveMetaAgentRuntime();
    assert.equal(pi.runtimeId, 'pi');
    assert.equal(pi.providerId, 'anthropic', 'a provider runtime takes the global provider');
    assert.equal(pi.modelId, 'pi-model');
  });

  test('an explicit choice wins and is unaffected by later global changes', () => {
    updateMetaAgentSettings({ runtimeId: 'codex', modelId: 'gpt-x', reasoning: 'medium' });
    const expected = { runtimeId: 'codex', providerId: null, modelId: 'gpt-x', reasoning: 'medium', followsGlobal: false };
    assert.deepEqual(resolveMetaAgentRuntime(), expected);
    setGlobal('kiro', { model: 'kiro-model', reasoning: 'low' });
    assert.deepEqual(resolveMetaAgentRuntime(), expected);
  });

  test('null fields of an explicit choice follow the global values for that runtime', () => {
    updateMetaAgentSettings({ runtimeId: 'kiro' });
    assert.deepEqual(resolveMetaAgentRuntime(), { runtimeId: 'kiro', providerId: null, modelId: null, reasoning: 'high', followsGlobal: false });
    updateAgentConfig({ modelByRuntime: { kiro: 'kiro-model' }, reasoningByRuntime: { kiro: 'low' } });
    assert.deepEqual(resolveMetaAgentRuntime(), { runtimeId: 'kiro', providerId: null, modelId: 'kiro-model', reasoning: 'low', followsGlobal: false });

    updateMetaAgentSettings({ runtimeId: 'pi', providerId: 'deepseek' });
    const other = resolveMetaAgentRuntime();
    assert.equal(other.providerId, 'deepseek');
    assert.equal(other.modelId, null, 'the global model belongs to the global provider');
  });

  test('every registered runtime is accepted, Kiro and Crew included; anything else is refused', () => {
    for (const runtimeId of ['claude', 'pi', 'codex', 'kiro', 'crew']) {
      assert.equal(updateMetaAgentSettings({ runtimeId }).runtimeId, runtimeId);
    }
    assert.throws(() => updateMetaAgentSettings({ runtimeId: 'gemini' }), MetaAgentSettingsError);
    assert.throws(() => updateMetaAgentSettings({ runtimeId: 7 as never }), MetaAgentSettingsError);
    assert.throws(() => updateMetaAgentSettings({ modelId: '--dangerously-skip-permissions' }), MetaAgentSettingsError);
    assert.throws(() => updateMetaAgentSettings({ providerId: '' }), MetaAgentSettingsError);
    assert.throws(() => updateMetaAgentSettings({ reasoning: 'loud' as never }), MetaAgentSettingsError);
    assert.equal(getMetaAgentSettings().runtimeId, 'crew', 'a refused patch changes nothing');
  });

  test('a runtime switch drops the old provider and model; null runtime follows global as a whole', () => {
    updateMetaAgentSettings({ runtimeId: 'pi', providerId: 'deepseek', modelId: 'deepseek-chat', reasoning: 'low' });
    assert.deepEqual(updateMetaAgentSettings({ modelId: 'deepseek-reasoner' }),
      { runtimeId: 'pi', providerId: 'deepseek', modelId: 'deepseek-reasoner', reasoning: 'low', ...DEFAULTS });
    assert.deepEqual(updateMetaAgentSettings({ runtimeId: 'claude' }),
      { runtimeId: 'claude', providerId: null, modelId: null, reasoning: 'low', ...DEFAULTS });
    assert.deepEqual(updateMetaAgentSettings({ runtimeId: null, modelId: 'ignored' }), FOLLOW);
    assert.deepEqual(getMetaAgentSettings(), FOLLOW);
  });

  test('a damaged stored record reads as follow-global', () => {
    getMetaAgentSettings();
    getDb().prepare("UPDATE meta SET value = '{not json' WHERE key = 'meta_agent_settings:desktop'").run();
    assert.equal(getMetaAgentSettings().runtimeId, null);
    getDb().prepare("UPDATE meta SET value = ? WHERE key = 'meta_agent_settings:desktop'")
      .run(JSON.stringify({ runtimeId: '-x', modelId: 'm', writeWorkspaceHomes: 'no', maintainSpacesHome: 0, firstRunDays: 14 }));
    assert.deepEqual(getMetaAgentSettings(), FOLLOW);
  });

  test('the reading and writing settings are kept apart from the runtime and validated', () => {
    assert.deepEqual(resolveMetaAgentBehaviour(), { writeWorkspaceHomes: true, maintainSpacesHome: true, firstRunDays: 30 });
    updateMetaAgentSettings({ writeWorkspaceHomes: false, maintainSpacesHome: false, firstRunDays: 7 });
    const off = { writeWorkspaceHomes: false, maintainSpacesHome: false, firstRunDays: 7 };
    assert.deepEqual(getMetaAgentSettings(), { ...FOLLOW, ...off });
    assert.deepEqual(resolveMetaAgentBehaviour(), off);
    assert.deepEqual(updateMetaAgentSettings({ runtimeId: 'codex', modelId: 'gpt-x' }),
      { runtimeId: 'codex', providerId: null, modelId: 'gpt-x', reasoning: null, ...off }, 'a runtime choice keeps them');
    assert.deepEqual(updateMetaAgentSettings({ runtimeId: null }), { ...FOLLOW, ...off }, 'following global keeps them');
    assert.deepEqual(updateMetaAgentSettings({ maintainSpacesHome: null, firstRunDays: 90 }), { ...FOLLOW, ...off, maintainSpacesHome: null, firstRunDays: 90 });
    assert.equal(resolveMetaAgentBehaviour().maintainSpacesHome, true, 'null is the default, on');

    assert.throws(() => updateMetaAgentSettings({ writeWorkspaceHomes: 'off' as never }), /writeWorkspaceHomes must be true, false or null/);
    assert.throws(() => updateMetaAgentSettings({ maintainSpacesHome: 1 as never }), MetaAgentSettingsError);
    assert.throws(() => updateMetaAgentSettings({ firstRunDays: 14 as never }), /firstRunDays must be 7, 30, 90 or null/);
    assert.throws(() => updateMetaAgentSettings({ firstRunDays: '30' as never }), MetaAgentSettingsError);
    assert.equal(getMetaAgentSettings().firstRunDays, 90, 'a refused patch changes nothing');
  });

  describe('the assistant\'s old settings', () => {
    test('an explicit choice is folded in once', () => {
      seedLegacyAssistant({ runtimeId: 'codex', modelId: 'gpt-x', reasoning: 'medium' });
      assert.deepEqual(getMetaAgentSettings(), { runtimeId: 'codex', providerId: null, modelId: 'gpt-x', reasoning: 'medium', ...DEFAULTS });
      updateMetaAgentSettings({ runtimeId: null });
      assert.equal(getMetaAgentSettings().runtimeId, null, 'a record that exists is never overwritten by the old settings');
    });

    test('a choice equal to global follows global', () => {
      seedLegacyAssistant({ runtimeId: 'claude', modelId: 'opus', reasoning: 'high' });
      assert.equal(getMetaAgentSettings().runtimeId, null);
    });

    test('the default stored when nobody chose follows global, even when global could not host the old assistant', () => {
      setGlobal('kiro');
      seedLegacyAssistant({ runtimeId: 'claude', modelId: null, reasoning: null });
      assert.equal(getMetaAgentSettings().runtimeId, null);
      assert.equal(resolveMetaAgentRuntime().runtimeId, 'kiro');
    });

    test('a non-default runtime with default model stays explicit', () => {
      setGlobal('kiro');
      seedLegacyAssistant({ runtimeId: 'pi', modelId: null, reasoning: null });
      assert.deepEqual(getMetaAgentSettings(), { runtimeId: 'pi', providerId: null, modelId: null, reasoning: null, ...DEFAULTS });
    });

    test('nothing to fold in without an assistant workspace, or with an unregistered runtime', () => {
      assert.equal(getMetaAgentSettings().runtimeId, null);
      assert.ok(storedRow(), 'the first read creates the record');
      getDb().prepare("DELETE FROM meta WHERE key = 'meta_agent_settings:desktop'").run();
      seedLegacyAssistant({ runtimeId: 'gemini', modelId: 'x' });
      assert.equal(getMetaAgentSettings().runtimeId, null);
    });
  });

  test('cloud mode keeps one record per owner and never reads the assistant workspace', () => {
    seedLegacyAssistant({ runtimeId: 'codex', modelId: 'gpt-x' });
    process.env.MICHI_CLOUD = '1';
    assert.throws(() => getMetaAgentSettings(), /authenticated owner/);
    assert.equal(getMetaAgentSettings('u1').runtimeId, null);
    updateMetaAgentSettings({ runtimeId: 'pi' }, 'u1');
    assert.equal(getMetaAgentSettings('u1').runtimeId, 'pi');
    assert.equal(getMetaAgentSettings('u2').runtimeId, null);
  });

  describe('routes', () => {
    let server: http.Server;
    let base: string;

    beforeEach(async () => {
      const app = express();
      app.use(express.json());
      app.use('/api', createRemoteAccessMiddleware());
      app.use('/api', setupMetaAgentRoutes());
      app.use('/api', setupMetaAgentOverviewRoutes({ scheduler: null }));
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

    test('GET answers the record, what a run would use now, and no guard result yet', async () => {
      const answer = await call('GET', '/api/meta-agent');
      assert.equal(answer.status, 200);
      assert.deepEqual(answer.body, metaAgentInfo());
      assert.deepEqual(answer.body.guard, { maintenance: null, chat: null });
      assert.equal(answer.body.resolved.runtimeId, 'claude');
      assert.deepEqual(answer.body.availability, { available: true, reason: null });
      assert.deepEqual(answer.body.usageToday, { checks: 0, modelCalls: 0, tokens: null }, 'nothing maintained yet');
    });

    test('PUT validates, stores and answers the new info', async () => {
      const set = await call('PUT', '/api/meta-agent/settings', { runtimeId: 'kiro', reasoning: 'low' });
      assert.equal(set.status, 200, JSON.stringify(set.body));
      assert.deepEqual(set.body.settings, { runtimeId: 'kiro', providerId: null, modelId: null, reasoning: 'low', ...DEFAULTS });
      assert.equal(set.body.resolved.followsGlobal, false);
      assert.equal((await call('PUT', '/api/meta-agent/settings', { runtimeId: 'nope' })).status, 400);
      assert.equal((await call('PUT', '/api/meta-agent/settings', { runtimeId: 'claude', extra: 1 })).status, 400);
      assert.equal((await call('PUT', '/api/meta-agent/settings', [1])).status, 400);
      assert.equal((await call('PUT', '/api/meta-agent/settings', { firstRunDays: 60 })).status, 400);
      assert.equal((await call('PUT', '/api/meta-agent/settings', { writeWorkspaceHomes: 'false' })).status, 400);
      const writes = await call('PUT', '/api/meta-agent/settings', { writeWorkspaceHomes: false, maintainSpacesHome: true, firstRunDays: 90 });
      assert.equal(writes.status, 200, JSON.stringify(writes.body));
      assert.deepEqual(writes.body.settings, { runtimeId: 'kiro', providerId: null, modelId: null, reasoning: 'low',
        writeWorkspaceHomes: false, maintainSpacesHome: true, firstRunDays: 90 });
      const back = await call('PUT', '/api/meta-agent/settings', { runtimeId: null });
      assert.equal(back.body.resolved.followsGlobal, true);
      assert.equal(back.body.resolved.runtimeId, 'claude');
    });

    test('authenticated remote owners can read settings and overview and update settings', async () => {
      const priorRemote = process.env.MICHI_REMOTE_ACCESS;
      const priorToken = process.env.MICHI_REMOTE_TOKEN;
      process.env.MICHI_REMOTE_ACCESS = '1';
      process.env.MICHI_REMOTE_TOKEN = 'meta-agent-test-owner-token';
      try {
        const headers = { host: 'michi.example', origin: 'https://michi.example', authorization: 'Bearer meta-agent-test-owner-token' };
        assert.equal((await call('GET', '/api/meta-agent', undefined, { host: headers.host })).status, 401);
        assert.equal((await call('GET', '/api/meta-agent', undefined, { ...headers, authorization: 'Bearer wrong' })).status, 401);
        assert.equal((await call('GET', '/api/meta-agent', undefined, headers)).status, 200);
        assert.equal((await call('GET', '/api/meta-agent/overview', undefined, headers)).status, 200);
        const result = await call('PUT', '/api/meta-agent/settings', { firstRunDays: 90 }, headers);
        assert.equal(result.status, 200);
        assert.equal(result.body.settings.firstRunDays, 90);
        assert.equal((await call('PUT', '/api/meta-agent/settings', { firstRunDays: 30 })).status, 401);
        assert.equal(getMetaAgentSettings().firstRunDays, 90);
      } finally {
        if (priorRemote === undefined) delete process.env.MICHI_REMOTE_ACCESS; else process.env.MICHI_REMOTE_ACCESS = priorRemote;
        if (priorToken === undefined) delete process.env.MICHI_REMOTE_TOKEN; else process.env.MICHI_REMOTE_TOKEN = priorToken;
      }
    });

    test('routes are local-only', async () => {
      assert.equal((await call('GET', '/api/meta-agent', undefined, { host: 'evil.example' })).status, 403);
      assert.equal((await call('PUT', '/api/meta-agent/settings', { runtimeId: 'pi' }, { origin: 'https://evil.example' })).status, 403);
      assert.equal(getMetaAgentSettings().runtimeId, null);
    });
  });

  test('the Meta agent reports that it does not run on Crew instead of switching runtimes', () => {
    setGlobal('crew');
    const info = metaAgentInfo();
    assert.equal(info.resolved.runtimeId, 'crew');
    assert.equal(info.availability.available, false);
    assert.match(info.availability.reason ?? '', /does not run on Kiro Crew/);
  });
});
