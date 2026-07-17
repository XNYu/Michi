import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  buildCodexFollowUpsHookPocInstruction,
  buildCodexFollowUpsHookPocConfig,
  isCodexFollowUpsHookPocEnabled,
  prepareCodexFollowUpsHookPocEnv,
} from '../src/agents/codex/codexFollowUpsHookPoc';
import { buildCodexMcpConfig } from '../src/agents/codex/codexProtocol';

const runnerPath = path.resolve(__dirname, '../src/agents/codex/codexStopHookRunner.cjs');

test('Codex follow-ups Hook POC flag is explicit and opt-in', () => {
  assert.equal(isCodexFollowUpsHookPocEnabled({}), false);
  for (const value of ['1', 'true', 'YES', ' on ']) {
    assert.equal(
      isCodexFollowUpsHookPocEnabled({ MICHI_CODEX_FOLLOW_UPS_HOOK_POC: value }),
      true,
    );
  }
});

test('hook-tool instruction makes structured metadata canonical without sentinel fallback', () => {
  const instruction = buildCodexFollowUpsHookPocInstruction('hook-tool');
  assert.match(instruction, /call .*set_follow_ups exactly once/);
  assert.match(instruction, /Do not duplicate the follow-ups/);
  assert.match(instruction, /Do not duplicate the overview/);
  assert.doesNotMatch(instruction, /\[FOLLOW-UP/);
  assert.doesNotMatch(instruction, /\[BRANCH-OVERVIEW:/);
  assert.doesNotMatch(instruction, /Keep emitting the existing/);
});

test('sentinel instruction puts the hidden overview tool after body follow-ups', () => {
  const instruction = buildCodexFollowUpsHookPocInstruction('sentinel');
  assert.match(instruction, /Do not call set_follow_ups/);
  assert.match(instruction, /Emit all three follow-up sentinel lines before calling set_branch_overview/);
  assert.match(instruction, /Never emit a \[BRANCH-OVERVIEW/);
  assert.match(instruction, /after \[FOLLOW-UP 3\/3/);
  assert.match(instruction, /emit no more visible text/);
});

test('Codex HTTP MCP config uses the current unauthenticated schema', () => {
  const config = buildCodexMcpConfig('slot-current-schema', 3456) as {
    mcp_servers: Record<string, Record<string, unknown>>;
  };
  const server = config.mcp_servers.__michi_internal__;

  assert.deepEqual(server.headers, []);
  assert.equal(server.auth, undefined);
  assert.equal(server.url, 'http://127.0.0.1:3456/api/mcp/slot-current-schema');
  assert.equal(server.default_tools_approval_mode, 'approve');
  assert.equal(server.tools, undefined);
});

test('builds a temporary sessionFlags Stop Hook overlay bound to one slot', () => {
  const config = buildCodexFollowUpsHookPocConfig('slot-branch-a', 3456, {
    runnerPath: '/tmp/Michi Hook/runner.cjs',
    nodePath: '/tmp/Node Runtime/node',
  });

  assert.deepEqual(config.features, { hooks: true });
  assert.equal(config.bypass_hook_trust, true);
  const hooks = config.hooks as {
    Stop: Array<{ hooks: Array<Record<string, unknown>> }>;
  };
  const hook = hooks.Stop[0].hooks[0];
  assert.equal(hook.type, 'command');
  assert.match(String(hook.command), /slot-branch-a/);
  assert.match(String(hook.command), /127\.0\.0\.1:3456/);
  assert.match(String(hook.command), /Michi Hook/);
  assert.match(String(hook.commandWindows), /slot-branch-a/);
});

test('isolated CODEX_HOME shares auth only and does not copy user hook config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-codex-hook-home-test-'));
  const sourceHome = path.join(root, 'user-codex');
  const dataDir = path.join(root, 'michi-data');
  fs.mkdirSync(sourceHome, { recursive: true });
  fs.writeFileSync(path.join(sourceHome, 'auth.json'), '{"token":"test"}');
  fs.writeFileSync(path.join(sourceHome, 'config.toml'), '[[hooks.Stop]]\n');

  try {
    const env = prepareCodexFollowUpsHookPocEnv({
      CODEX_HOME: sourceHome,
      MICHI_DATA_DIR: dataDir,
    });
    const isolatedHome = path.join(dataDir, 'codex-follow-ups-hook-poc');

    assert.equal(env.CODEX_HOME, isolatedHome);
    assert.equal(fs.readFileSync(path.join(isolatedHome, 'auth.json'), 'utf8'), '{"token":"test"}');
    assert.equal(fs.existsSync(path.join(isolatedHome, 'config.toml')), false);
    assert.equal(fs.existsSync(path.join(isolatedHome, 'hooks.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runner forwards the Stop payload and prints the validator decision', async () => {
  let received: unknown = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ decision: 'block', reason: 'Call set_follow_ups.' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const result = await runRunner(`http://127.0.0.1:${port}/stop`, {
      hook_event_name: 'Stop',
      session_id: 'thread-a',
      turn_id: 'turn-a',
    });

    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      decision: 'block',
      reason: 'Call set_follow_ups.',
    });
    assert.deepEqual(received, {
      hook_event_name: 'Stop',
      session_id: 'thread-a',
      turn_id: 'turn-a',
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('runner fails open when the loopback validator returns an error', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(500).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const result = await runRunner(`http://127.0.0.1:${port}/stop`, {
      hook_event_name: 'Stop',
    });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.match(result.stderr, /fail-open/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function runRunner(
  endpoint: string,
  payload: Record<string, unknown>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runnerPath, endpoint], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout: stdout.trim(), stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}
