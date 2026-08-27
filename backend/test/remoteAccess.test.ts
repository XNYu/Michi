import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  createRemoteAccessMiddleware,
  resolveListenHost,
  validateRemoteAccessConfiguration,
} from '../src/services/remoteAccess';
import { McpSlotRegistry, mountMcp } from '../src/services/mcpServer';

const original = {
  access: process.env.MICHI_REMOTE_ACCESS,
  token: process.env.MICHI_REMOTE_TOKEN,
  auth: process.env.MICHI_REQUIRE_AUTH,
  bindHost: process.env.MICHI_BIND_HOST,
  cloud: process.env.MICHI_CLOUD,
};

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    const envName = key === 'access'
      ? 'MICHI_REMOTE_ACCESS'
      : key === 'token'
        ? 'MICHI_REMOTE_TOKEN'
        : key === 'auth'
          ? 'MICHI_REQUIRE_AUTH'
          : key === 'bindHost'
            ? 'MICHI_BIND_HOST'
            : 'MICHI_CLOUD';
    if (value === undefined) delete process.env[envName];
    else process.env[envName] = value;
  }
});

describe('remote access token middleware', () => {
  test('requires a strong token and rejects cloud auth combination', () => {
    process.env.MICHI_REMOTE_ACCESS = '1';
    delete process.env.MICHI_REMOTE_TOKEN;
    assert.throws(validateRemoteAccessConfiguration, /requires MICHI_REMOTE_TOKEN/);
    process.env.MICHI_REMOTE_TOKEN = 'short';
    assert.throws(validateRemoteAccessConfiguration, /at least 16/);
    process.env.MICHI_REMOTE_TOKEN = 'long-enough-remote-token';
    process.env.MICHI_REQUIRE_AUTH = 'true';
    assert.throws(validateRemoteAccessConfiguration, /cannot be enabled together/);
  });

  test('accepts only the configured bearer token', () => {
    process.env.MICHI_REMOTE_ACCESS = '1';
    process.env.MICHI_REMOTE_TOKEN = 'long-enough-remote-token';
    delete process.env.MICHI_REQUIRE_AUTH;
    validateRemoteAccessConfiguration();
    const middleware = createRemoteAccessMiddleware();
    let status = 0;
    let body: unknown;
    let nextCalls = 0;
    const response = {
      status(code: number) { status = code; return this; },
      json(value: unknown) { body = value; return this; },
    } as any;
    middleware({ headers: { authorization: 'Bearer wrong' } } as any, response, () => { nextCalls += 1; });
    assert.equal(status, 401);
    assert.deepEqual(body, { error: 'invalid remote access token' });
    middleware({ headers: { authorization: 'Bearer long-enough-remote-token' } } as any, response, () => { nextCalls += 1; });
    assert.equal(nextCalls, 1);
  });

  test('bypasses bearer only for loopback internal-runtime paths', () => {
    process.env.MICHI_REMOTE_ACCESS = '1';
    process.env.MICHI_REMOTE_TOKEN = 'long-enough-remote-token';
    const middleware = createRemoteAccessMiddleware();

    const invoke = (path: string, remoteAddress: string) => {
      let status = 0;
      let nextCalls = 0;
      const response = {
        status(code: number) { status = code; return this; },
        json() { return this; },
      } as any;
      middleware({
        path,
        socket: { remoteAddress },
        headers: {},
      } as any, response, () => { nextCalls += 1; });
      return { status, nextCalls };
    };

    assert.deepEqual(invoke('/mcp/slot-1', '127.0.0.1'), { status: 0, nextCalls: 1 });
    assert.deepEqual(invoke('/codex-hooks/slot-1/stop', '::1'), { status: 0, nextCalls: 1 });
    assert.deepEqual(invoke('/mcp/slot-1', '10.0.0.42'), { status: 401, nextCalls: 0 });
    assert.deepEqual(invoke('/workspaces/all', '127.0.0.1'), { status: 401, nextCalls: 0 });
  });

  test('keeps external APIs protected while loopback MCP reaches slot validation', async () => {
    process.env.MICHI_REMOTE_ACCESS = '1';
    process.env.MICHI_REMOTE_TOKEN = 'long-enough-remote-token';

    const app = express();
    app.use(express.json());
    app.use('/api', createRemoteAccessMiddleware());
    const router = express.Router();
    const registry = new McpSlotRegistry();
    const slot = registry.create('remote-auth-test', process.cwd(), null, {
      onSpawnBranches: async () => [],
      onSaveArtifact: () => null,
      onUpdateArtifact: () => null,
      onShowImage: () => ({ error: 'unsupported in test' }),
    });
    mountMcp(router, registry);
    app.use('/api', router);
    app.get('/api/protected', (_req, res) => res.json({ ok: true }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const protectedResponse = await fetch(`http://127.0.0.1:${port}/api/protected`);
      assert.equal(protectedResponse.status, 401);

      const initializeResponse = await fetch(`http://127.0.0.1:${port}/api/mcp/${slot.slotId}`, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'remote-auth-test', version: '1.0.0' },
          },
        }),
      });
      assert.equal(initializeResponse.status, 200);

      const unknownSlotResponse = await fetch(`http://127.0.0.1:${port}/api/mcp/unknown-slot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      assert.equal(unknownSlotResponse.status, 404);
      assert.deepEqual(await unknownSlotResponse.json(), { error: 'unknown mcp slot' });

      const authorizedResponse = await fetch(`http://127.0.0.1:${port}/api/protected`, {
        headers: { authorization: 'Bearer long-enough-remote-token' },
      });
      assert.equal(authorizedResponse.status, 200);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });
});

describe('backend listen host', () => {
  test('defaults local mode to loopback', () => {
    delete process.env.MICHI_REMOTE_ACCESS;
    delete process.env.MICHI_CLOUD;
    delete process.env.MICHI_BIND_HOST;
    assert.equal(resolveListenHost(), '127.0.0.1');
  });

  test('defaults remote and cloud modes to all interfaces', () => {
    delete process.env.MICHI_BIND_HOST;
    process.env.MICHI_REMOTE_ACCESS = '1';
    assert.equal(resolveListenHost(), '0.0.0.0');
    delete process.env.MICHI_REMOTE_ACCESS;
    process.env.MICHI_CLOUD = '1';
    assert.equal(resolveListenHost(), '0.0.0.0');
  });

  test('honors an explicit loopback binding and rejects malformed hosts', () => {
    process.env.MICHI_REMOTE_ACCESS = '1';
    process.env.MICHI_BIND_HOST = '127.0.0.1';
    assert.equal(resolveListenHost(), '127.0.0.1');
    process.env.MICHI_BIND_HOST = 'bad host/name';
    assert.throws(resolveListenHost, /invalid/);
  });
});
