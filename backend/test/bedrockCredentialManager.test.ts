import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  __resetBedrockRefreshStateForTest,
  refreshBedrockCredentialsIfNeeded,
  refreshOnAuthFailure,
} from '../src/services/bedrockCredentialManager';
import { PiSession } from '../src/agents/pi/PiSession';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { chatOwner } from './helpers/owners';

const nativeImport = new Function('name', 'return import(name)') as (name: string) => Promise<any>;

/** A refresh command backed by a temp shell script that appends one line per run. */
function refreshScript(t: TestContext, body: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-bedrock-refresh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'refresh.sh');
  const counter = path.join(dir, 'runs');
  fs.writeFileSync(script, `${body}\n`);
  const runs = () => fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean).length : 0;
  return { command: `sh "${script}" "${counter}"`, runs };
}

function quietLogs(t: TestContext) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
}

test('a slow refresh command does not block the event loop', async (t) => {
  __resetBedrockRefreshStateForTest();
  quietLogs(t);
  const { command, runs } = refreshScript(t, 'sleep 0.5\necho run >> "$1"');
  const started = Date.now();
  let tickedAfter = -1;
  const timer = new Promise<void>((resolve) => setTimeout(() => { tickedAfter = Date.now() - started; resolve(); }, 20));
  const refresh = refreshBedrockCredentialsIfNeeded({ region: 'us-east-1', authRefreshCommand: command });
  await timer;
  assert.ok(tickedAfter < 300, `timer tick waited ${tickedAfter}ms for the refresh command`);
  assert.equal(runs(), 0, 'the command is still running when the timer fires');
  await refresh;
  assert.equal(runs(), 1);
});

test('concurrent proactive and auth-failure refreshes share one command run', async (t) => {
  __resetBedrockRefreshStateForTest();
  quietLogs(t);
  const { command, runs } = refreshScript(t, 'sleep 0.2\necho run >> "$1"');
  const creds = { region: 'us-east-1', authRefreshCommand: command };
  const [, , reactive] = await Promise.all([
    refreshBedrockCredentialsIfNeeded(creds),
    refreshBedrockCredentialsIfNeeded(creds),
    refreshOnAuthFailure(creds),
  ]);
  assert.equal(reactive, true, 'the auth-failure caller sees the shared successful run');
  assert.equal(runs(), 1);
});

test('a refresh command that outlives the timeout is killed and reported as failed', async (t) => {
  __resetBedrockRefreshStateForTest({ timeoutMs: 100 });
  t.after(() => __resetBedrockRefreshStateForTest());
  quietLogs(t);
  const started = Date.now();
  assert.equal(await refreshOnAuthFailure({ region: 'us-east-1', authRefreshCommand: 'exec sleep 5' }), false);
  assert.ok(Date.now() - started < 2_000, 'the timed-out command does not hold the caller');
});

// --- PiSession wiring: a Bedrock auth error refreshes credentials and retries once ---

const model = { id: 'pi-model', contextWindow: 1000 };
const expired = {
  type: 'error', reason: 'error',
  error: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'ExpiredTokenException: The security token included in the request is expired' },
};
const done = { type: 'done', reason: 'stop', message: { role: 'assistant', content: [], stopReason: 'stop' } };

async function bedrockSession(t: TestContext, authRefreshCommand: string, replies: any[]) {
  const ai = await nativeImport('@earendil-works/pi-ai/compat');
  configureRuntimeDeps({
    dataDir: process.env.HOME,
    historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null,
      getWorkspaceInstructions: () => null, hasGrant: () => false, grantPermission() {} },
    providerKeys: { getProviderApiKey: () => null },
    agentConfig: { getAgentConfig: () => ({ provider: 'amazon-bedrock' } as any), resolveModel: () => 'pi-model', resolveReasoning: () => undefined },
  } as any);
  t.after(__resetRuntimeDeps);
  t.mock.method(require('../src/services/bedrockCredentials'), 'resolveBedrockCredentials',
    () => ({ region: 'us-east-1', profile: 'test-profile', authRefreshCommand }));
  t.mock.method(require('../src/services/piMcpConfig'), 'readPiMcpServers', () => []);
  t.mock.method(require('../src/agents/pi/piTools'), 'buildPiTools', () => []);
  t.mock.method(require('../src/agents/pi/piProviders'), 'resolvePiModel', async () => model);
  const providerCalls: any[] = [];
  t.mock.method(require('../src/agents/pi/piAi'), 'loadPiAi', async () => ({
    Type: {},
    clampThinkingLevel: () => 'off',
    createAssistantMessageEventStream: ai.createAssistantMessageEventStream,
    streamSimple(_model: unknown, _context: unknown, options: unknown) {
      providerCalls.push(options);
      const inner = ai.createAssistantMessageEventStream();
      inner.push(replies.shift() ?? done);
      return inner;
    },
  }));
  const results: any[] = [];
  class Agent {
    state: any;
    subscriber: ((event: any) => void) | undefined;
    constructor(public options: any) { this.state = options.initialState; }
    subscribe(fn: (event: any) => void) { this.subscriber = fn; return () => { this.subscriber = undefined; }; }
    abort() {}
    async prompt() {
      results.push(await this.options.streamFn(model, { messages: [] }, {}).result());
      this.subscriber?.({ type: 'agent_end' });
    }
  }
  t.mock.method(require('../src/agents/pi/piAi'), 'loadPiAgentCore', async () => ({ Agent }));
  const session = new PiSession('pi-node', {
    bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null } as any,
    preamble: '', cwd: '/tmp', workspaceId: null, ownerUserId: null, enableFollowUps: false,
    requestedProvider: 'amazon-bedrock', requestedModel: 'pi-model',
    owner: chatOwner('pi-node'), profileHash: 'profile',
  } as any);
  t.after(() => session.destroy());
  const turn = async (text: string) => { for await (const _ev of session.send(text) as AsyncIterable<NormalizedEvent>) { /* drain */ } };
  return { turn, providerCalls, results };
}

test('Pi refreshes Bedrock credentials after an auth error and retries the request once', async (t) => {
  __resetBedrockRefreshStateForTest();
  quietLogs(t);
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const { command, runs } = refreshScript(t, 'echo run >> "$1"');
  const { turn, providerCalls, results } = await bedrockSession(t, command, [done, expired, done]);
  await turn('first');
  assert.equal(runs(), 1, 'the first turn refreshes proactively');
  t.mock.timers.tick(31_000);
  await turn('second');
  assert.equal(runs(), 2, 'the auth error runs the refresh command');
  assert.equal(providerCalls.length, 3, 'the failed request is retried once');
  assert.equal(providerCalls[2].profile, 'test-profile');
  assert.equal(results[1].stopReason, 'stop');
});

test('Pi surfaces the Bedrock auth error without a retry when the refresh fails', async (t) => {
  __resetBedrockRefreshStateForTest();
  quietLogs(t);
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const { command, runs } = refreshScript(t, 'echo run >> "$1"\nexit 3');
  const { turn, providerCalls, results } = await bedrockSession(t, command, [done, expired, expired]);
  await turn('first');
  t.mock.timers.tick(31_000);
  await turn('second');
  assert.equal(runs(), 2, 'the auth error tried the refresh command');
  assert.equal(providerCalls.length, 2, 'no retry after a failed refresh');
  assert.equal(results[1].stopReason, 'error');
  assert.match(results[1].errorMessage, /ExpiredToken/);
  await turn('third');
  assert.equal(runs(), 2, 'the failure cooldown suppresses another refresh');
  assert.equal(providerCalls.length, 3);
});

function quoted(value: string): string {
  return process.platform === 'win32' ? `"${value.replace(/"/g, '\\"')}"` : `'${value.replace(/'/g, "'\\''")}'`;
}

test('credential refresh yields to HTTP/event-loop work and coalesces concurrent callers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-refresh-'));
  const script = path.join(dir, 'refresh.cjs');
  const marker = path.join(dir, 'runs');
  fs.writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'run\\n'); setTimeout(() => {}, 300);`);
  const credentials = { region: 'test', authRefreshCommand: `${quoted(process.execPath)} ${quoted(script)}` };
  try {
    let finished = false;
    const first = refreshBedrockCredentialsIfNeeded(credentials).then(() => { finished = true; });
    const second = refreshOnAuthFailure(credentials);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(finished, false, 'the timer runs before the child finishes');
    await first;
    assert.equal(await second, true);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'run\n');
    await refreshBedrockCredentialsIfNeeded(credentials);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'run\n', 'fresh credentials are reused');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failures cool down per command without blocking a different credential source', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-refresh-fail-'));
  try {
    const bad = path.join(dir, 'bad.cjs'); const good = path.join(dir, 'good.cjs');
    fs.writeFileSync(bad, 'process.exit(1)'); fs.writeFileSync(good, 'process.exit(0)');
    assert.equal(await refreshOnAuthFailure({ region: 'test', authRefreshCommand: `${quoted(process.execPath)} ${quoted(bad)}` }), false);
    assert.equal(await refreshOnAuthFailure({ region: 'test', authRefreshCommand: `${quoted(process.execPath)} ${quoted(good)}` }), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
