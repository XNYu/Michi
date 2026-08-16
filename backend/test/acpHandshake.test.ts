import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpClient } from '../src/services/acpClient';
import { createKiroProfile } from '../src/services/acp/profiles/kiro';
import { createCursorProfile } from '../src/services/acp/profiles/cursor';
import { createGrokProfile } from '../src/services/acp/profiles/grok';

const FAKE = path.join(__dirname, 'fixtures', 'fakeAcpStdio.js');

function methodsOf(logFile: string): string[] {
  const rows = JSON.parse(fs.readFileSync(logFile, 'utf8')) as Array<{ method?: string }>;
  return rows.map((r) => String(r.method ?? ''));
}

function first(logFile: string, method: string): any {
  const rows = JSON.parse(fs.readFileSync(logFile, 'utf8')) as any[];
  return rows.find((r) => r.method === method);
}

describe('ACP fake-stdio handshake', () => {
  let tmp: string;
  let logFile: string;
  let argvFile: string;
  const prev: Record<string, string | undefined> = {};

  beforeEach(() => {
    fs.chmodSync(FAKE, 0o755);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-handshake-'));
    logFile = path.join(tmp, 'recv.json');
    argvFile = path.join(tmp, 'argv.json');
    for (const key of ['FAKE_ACP_LOG', 'FAKE_ACP_ARGV', 'FAKE_ACP_PROFILE', 'FAKE_ACP_EMIT', 'FAKE_ACP_AGENT_CAPS', 'FAKE_GROK_AUTH_METHODS', 'XAI_API_KEY']) {
      prev[key] = process.env[key];
    }
    process.env.FAKE_ACP_LOG = logFile;
    process.env.FAKE_ACP_ARGV = argvFile;
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('shared client completes initialize + session/new over NDJSON', async () => {
    process.env.FAKE_ACP_PROFILE = 'kiro';
    const client = new AcpClient(createKiroProfile({ binaryPath: FAKE, cwd: tmp }));
    try {
      client.start();
      await client.initialize();
      const { sessionId } = await client.newSession([]);
      assert.equal(sessionId, 'sess-1');
    } finally {
      await client.shutdown();
    }
    assert.ok(fs.existsSync(logFile));
    const methods = methodsOf(logFile);
    assert.ok(methods.includes('initialize'));
    assert.ok(methods.includes('session/new'));
  });

  test('Kiro sends protocolVersion 2025-01-01, spawn args acp -a, and no authenticate', async () => {
    process.env.FAKE_ACP_PROFILE = 'kiro';
    const client = new AcpClient(createKiroProfile({ binaryPath: FAKE, cwd: tmp }));
    try {
      client.start();
      await client.initialize();
      await client.newSession([]);
    } finally {
      await client.shutdown();
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(argvFile, 'utf8')), ['acp', '-a']);
    const init = first(logFile, 'initialize');
    assert.equal(init.params.protocolVersion, '2025-01-01');
    assert.deepEqual(init.params.clientInfo, { name: 'michi', version: '1.0.0' });
    assert.ok(!methodsOf(logFile).includes('authenticate'));
  });

  test('Cursor sends protocolVersion 1 and authenticate cursor_login', async () => {
    process.env.FAKE_ACP_PROFILE = 'cursor';
    const client = new AcpClient(createCursorProfile({
      binaryPath: FAKE,
      cwd: tmp,
      skipPreflight: true,
    }));
    try {
      client.start();
      await client.initialize();
      await client.newSession([{ name: 'michi', type: 'http', url: 'http://127.0.0.1:3000/api/mcp/slot', headers: [] }]);
    } finally {
      await client.shutdown();
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(argvFile, 'utf8')), ['acp']);
    const init = first(logFile, 'initialize');
    assert.equal(init.params.protocolVersion, 1);
    const auth = first(logFile, 'authenticate');
    assert.deepEqual(auth.params, { methodId: 'cursor_login' });
    const sessionNew = first(logFile, 'session/new');
    assert.equal(sessionNew.params.mcpServers[0].name, 'michi');
    assert.equal(sessionNew.params.mcpServers[0].type, 'http');
  });

  test('Grok authenticates with cached_token + headless after login, even if XAI_API_KEY is set', async () => {
    process.env.FAKE_ACP_PROFILE = 'grok';
    process.env.XAI_API_KEY = 'sk-test';
    const client = new AcpClient(createGrokProfile({
      binaryPath: FAKE,
      cwd: tmp,
      skipPreflight: true,
    }));
    try {
      client.start();
      await client.initialize();
      await client.newSession([]);
    } finally {
      await client.shutdown();
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(argvFile, 'utf8')), ['--no-auto-update', 'agent', 'stdio']);
    const init = first(logFile, 'initialize');
    assert.equal(init.params.protocolVersion, 1);
    assert.deepEqual(init.params.clientCapabilities, {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    });
    const auth = first(logFile, 'authenticate');
    assert.deepEqual(auth.params, { methodId: 'cached_token', _meta: { headless: true } });
  });

  test('Grok authenticates with xai.api_key when cached_token is absent and the key is set', async () => {
    process.env.FAKE_ACP_PROFILE = 'grok';
    process.env.XAI_API_KEY = 'sk-test';
    process.env.FAKE_GROK_AUTH_METHODS = JSON.stringify([{ id: 'xai.api_key' }, { id: 'grok.com' }]);
    const client = new AcpClient(createGrokProfile({
      binaryPath: FAKE,
      cwd: tmp,
      skipPreflight: true,
    }));
    try {
      client.start();
      await client.initialize();
    } finally {
      await client.shutdown();
    }
    const auth = first(logFile, 'authenticate');
    assert.deepEqual(auth.params, { methodId: 'xai.api_key', _meta: { headless: true } });
  });

  test('initialize() returns and stores authMethods / agentCapabilities', async () => {
    process.env.FAKE_ACP_PROFILE = 'grok';
    process.env.XAI_API_KEY = 'sk-test';
    process.env.FAKE_ACP_AGENT_CAPS = JSON.stringify({
      loadSession: true,
      mcpCapabilities: { http: true },
      promptCapabilities: { image: false },
    });
    const client = new AcpClient(createGrokProfile({
      binaryPath: FAKE,
      cwd: tmp,
      skipPreflight: true,
    }));
    try {
      client.start();
      const result = await client.initialize();
      assert.deepEqual(result.authMethods, [{ id: 'xai.api_key' }, { id: 'cached_token' }]);
      assert.equal(result.agentCapabilities?.loadSession, true);
      assert.equal(result.agentCapabilities?.mcpCapabilities?.http, true);
      assert.equal(result.agentCapabilities?.promptCapabilities?.image, false);
      assert.deepEqual(client.getInitializeResult(), result);
    } finally {
      await client.shutdown();
    }
  });
});
