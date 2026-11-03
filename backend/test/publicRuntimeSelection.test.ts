import { isolatedConfigDir } from './isolatedConfigDir';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { AgentRuntime } from '../src/agents/types';

delete process.env.MICHI_DEFAULT_RUNTIME;
delete process.env.MICHI_AGENT_RUNTIME;
delete process.env.MICHI_AGENT;
delete process.env.MICHI_CLOUD;
const { loadAgentConfig, getAgentConfig, updateAgentConfig, reconcileRuntimeWithRegistered } = require('../src/services/agentConfig');
const configPath = path.join(isolatedConfigDir, 'config.json');
beforeEach(() => {
  fs.writeFileSync(configPath, '{}');
  delete process.env.MICHI_AGENT_RUNTIME;
  loadAgentConfig();
});

test('fresh public config stays unselected across runtime registration and restart', () => {
  assert.equal(getAgentConfig().runtime, '');
  reconcileRuntimeWithRegistered(['kiro', 'pi', 'claude', 'codex']);
  assert.equal(getAgentConfig().runtime, '');
  assert.equal(loadAgentConfig().runtime, '');
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {});
});

test('saved and explicit environment choices are retained', () => {
  updateAgentConfig({ runtime: 'codex' });
  assert.equal(loadAgentConfig().runtime, 'codex');
  reconcileRuntimeWithRegistered(['kiro', 'codex']);
  assert.equal(getAgentConfig().runtime, 'codex');
  process.env.MICHI_AGENT_RUNTIME = 'claude';
  assert.equal(loadAgentConfig().runtime, 'claude');
  delete process.env.MICHI_AGENT_RUNTIME;
});

test('a removed runtime returns to selection instead of choosing the first registered runtime', () => {
  updateAgentConfig({ runtime: 'removed' });
  reconcileRuntimeWithRegistered(['kiro', 'pi']);
  assert.equal(getAgentConfig().runtime, '');
  assert.equal(loadAgentConfig().runtime, '');
});

test('status and options work on first launch with no Kiro registered', async () => {
  const { registerRuntime } = require('../src/agents/registry');
  const { UNKNOWN_RUNTIME_DESCRIPTOR } = require('michi-runtime/internal/core/descriptors');
  const runtime: AgentRuntime = {
    id: 'codex', label: 'Codex', descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
    capabilities: { modes: false, permissions: false, models: false, providerModels: false,
      reasoning: false, supportedReasoningLevels: [], apiKeys: false, warmSessions: false,
      saveContext: false, spawnBranches: false, nativeResume: false },
    checkAvailability: () => ({ available: true }),
    warm: async () => {}, releaseSession: () => {}, shutdown: async () => {},
    newSession: async () => { throw new Error('No session should start during setup'); },
  };
  registerRuntime(runtime);
  const { setupAgentRoutes } = require('../src/routes/agent');
  const { normalizeAgentStatus } = require('michi-shared');
  const app = express();
  app.use(express.json());
  app.use('/api', setupAgentRoutes());
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  try {
    const initial = normalizeAgentStatus(await (await fetch(`${base}/agent/status`)).json());
    assert.equal(initial.runtime, '');
    assert.equal(initial.capabilities.warmSessions, false);
    assert.deepEqual(initial.availableRuntimes.map((r: { id: string }) => r.id), ['codex']);
    const selected = await fetch(`${base}/agent/options`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runtime: 'codex' }),
    });
    assert.equal(selected.status, 200);
    assert.equal(normalizeAgentStatus(await (await fetch(`${base}/agent/status`)).json()).runtime, 'codex');
    assert.equal(loadAgentConfig().runtime, 'codex');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

for (const current of ['', 'missing-runtime']) {
  test(`public remote discovery does not preselect a runtime for '${current}'`, async () => {
    const http = require('node:http');
    const { RemoteDesktopSetup } = require('../src/services/remoteDesktopSetup');
    const { SshTunnelManager } = require('../src/services/sshTunnelManager');
    let selections = 0;
    const remote = http.createServer((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/agent/status') {
        res.end(JSON.stringify({ runtime: current, hasRequiredKey: true,
          availableRuntimes: ['kiro', 'codex', 'claude'].map(id => ({ id, label: id, available: true })) }));
      } else if (req.url === '/api/agent/options') {
        selections++;
        res.end(JSON.stringify({ ok: true }));
      } else res.end(JSON.stringify({ service: 'michi-backend', status: 'healthy', serverId: 'public-setup-test' }));
    });
    remote.listen(0, '127.0.0.1');
    await once(remote, 'listening');
    const apiUrl = `http://127.0.0.1:${(remote.address() as AddressInfo).port}/api`;
    class FakeTunnel extends SshTunnelManager {
      async apiUrl() { return apiUrl; }
      stop() {}
    }
    const setup = new RemoteDesktopSetup({ tunnelManager: new FakeTunnel(), runSsh: async () =>
      'MICHI_SETUP_JSON:' + JSON.stringify({ home: '/home/test', healthy: true, token: 'test-token', port: 4444, runtimes: ['codex', 'claude'] }) });
    try {
      const result = await setup.connect('public-test-host', false, () => {});
      assert.equal(result.kind, 'connected');
      assert.equal(selections, 0);
    } finally {
      await new Promise<void>(resolve => remote.close(() => resolve()));
    }
  });
}
