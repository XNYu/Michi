import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { setupAgentRoutes } from '../src/routes/agent';
import { CustomAgentsFeatureBusyError } from '../src/services/customAgentsFeatureGate';
import { createRemoteAccessMiddleware } from '../src/services/remoteAccess';

// We can't easily mock the registry from outside without a refactor, so
// this test asserts the *shape* of the response when no runtime is
// registered (the early-return path at agent.ts:42).

describe('/agent/status', () => {
  test('returns fallback status when no runtime is registered', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', setupAgentRoutes());

    const server = app.listen(0);
    try {
      const port = (server.address() as any).port;
      const r = await fetch(`http://127.0.0.1:${port}/api/agent/status`);
      const body = (await r.json()) as Record<string, unknown>;
      assert.equal(r.status, 200);
      assert.equal(body.customAgentsEnabled, false);
      assert.ok('availableRuntimes' in body, 'response should include availableRuntimes');
      assert.ok('runtime' in body, 'response should include runtime');
      assert.ok('capabilityDescriptor' in body, 'response should include capabilityDescriptor');
      const descriptor = body.capabilityDescriptor as Record<string, { availability?: string }>;
      assert.equal(typeof descriptor.steer?.availability, 'string');
    } finally {
      server.close();
    }
  });

  test('advertises Custom Agents only when their routes are enabled', async () => {
    const app = express();
    app.use('/api', setupAgentRoutes({ customAgentsEnabled: true }));
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const response = await fetch(`http://127.0.0.1:${port}/api/agent/status`);
      const body = await response.json() as { customAgentsEnabled: boolean };
      assert.equal(body.customAgentsEnabled, true);
    } finally {
      server.close();
    }
  });

  test('updates the backend Custom Agents gate and reports the effective state', async () => {
    let enabled = false;
    const customAgents = {
      isEnabled: () => enabled,
      setEnabled: async (next: boolean) => { enabled = next; },
    };
    const app = express();
    app.use(express.json());
    app.use('/api', setupAgentRoutes({ customAgents }));
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const base = `http://127.0.0.1:${port}/api`;
      const updated = await fetch(`${base}/agent/custom-agents`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      assert.equal(updated.status, 200);
      assert.deepEqual(await updated.json(), { ok: true, customAgentsEnabled: true });

      const status = await fetch(`${base}/agent/status`);
      const body = await status.json() as { customAgentsEnabled: boolean };
      assert.equal(body.customAgentsEnabled, true);

      const invalid = await fetch(`${base}/agent/custom-agents`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: 'yes' }),
      });
      assert.equal(invalid.status, 400);

      const crossOrigin = await fetch(`${base}/agent/custom-agents`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
        body: JSON.stringify({ enabled: false }),
      });
      assert.equal(crossOrigin.status, 403);
      assert.equal(enabled, true);

      const unapprovedLocalOrigin = await fetch(`${base}/agent/custom-agents`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:9999' },
        body: JSON.stringify({ enabled: false }),
      });
      assert.equal(unapprovedLocalOrigin.status, 403);
      assert.equal(enabled, true);
    } finally {
      server.close();
    }
  });

  test('allows a direct remote request only after bearer authentication', async () => {
    const previousAccess = process.env.MICHI_REMOTE_ACCESS;
    const previousToken = process.env.MICHI_REMOTE_TOKEN;
    process.env.MICHI_REMOTE_ACCESS = '1';
    process.env.MICHI_REMOTE_TOKEN = 'remote-test-token';
    let enabled = false;
    const app = express();
    app.use(express.json());
    app.use('/api', createRemoteAccessMiddleware());
    app.use('/api', setupAgentRoutes({
      customAgents: {
        isEnabled: () => enabled,
        setEnabled: (next) => { enabled = next; },
      },
    }));
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const response = await fetch(`http://127.0.0.1:${port}/api/agent/custom-agents`, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer remote-test-token',
          'content-type': 'application/json',
          origin: 'https://remote-client.example',
        },
        body: JSON.stringify({ enabled: true }),
      });
      assert.equal(response.status, 200);
      assert.equal(enabled, true);
    } finally {
      server.close();
      if (previousAccess === undefined) delete process.env.MICHI_REMOTE_ACCESS;
      else process.env.MICHI_REMOTE_ACCESS = previousAccess;
      if (previousToken === undefined) delete process.env.MICHI_REMOTE_TOKEN;
      else process.env.MICHI_REMOTE_TOKEN = previousToken;
    }
  });

  test('rejects disabling while Agent Runs are active', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', setupAgentRoutes({
      customAgents: {
        isEnabled: () => true,
        setEnabled: () => { throw new CustomAgentsFeatureBusyError(2); },
      },
    }));
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const response = await fetch(`http://127.0.0.1:${port}/api/agent/custom-agents`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      assert.equal(response.status, 409);
      assert.match((await response.json() as { error: string }).error, /2 Agent Runs are active/);
    } finally {
      server.close();
    }
  });
});

