/**
 * Kiro's logs, perf marks, startup marks and child stderr reach the runtime
 * host's observability port. Michi's port writes the child's stderr to
 * kiro-cli.log through logger.log.acpStderr, as AcpClient did directly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpClient } from 'michi-runtime/internal/adapters/kiro/acpClient';
import { KiroRuntime } from 'michi-runtime/internal/adapters/kiro/KiroRuntime';
import { log as michiLog } from '../src/services/logger';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import type { RuntimeObservability } from 'michi-runtime/internal/contract/host';
import { michiTestHost } from './helpers/michiTestHost';

const bridge: AgentToolBridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null };

function recordingObservability() {
  const events: Array<[string, ...unknown[]]> = [];
  const observability: RuntimeObservability = {
    log: (level, scope, msg, data) => { events.push(['log', level, scope, msg, data]); },
    perf: {
      now: () => 0,
      mark: (stage, meta) => { events.push(['mark', stage, meta]); },
      measure: (stage, start, meta) => { events.push(['measure', stage, start, meta]); },
    },
    startupMark: (name, extra) => { events.push(['startupMark', name, extra]); },
    childStderr: (runtimeId, chunk) => { events.push(['childStderr', runtimeId, chunk]); },
  };
  return { events, observability };
}

test('AcpClient reports its child process and its stderr to the observability port', async () => {
  const { events, observability } = recordingObservability();
  const client = new AcpClient(undefined, process.cwd(), undefined, 'v2', {
    bin: process.execPath,
    args: () => ['-e', "process.stderr.write('kiro stderr line\\n'); setInterval(() => {}, 1000)"],
  }, 'crew', { observability });
  try {
    client.start();
    const deadline = Date.now() + 10_000;
    while (!events.some(([kind]) => kind === 'childStderr') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    await client.shutdown();
  }
  assert.deepEqual(events.find(([kind]) => kind === 'childStderr'), ['childStderr', 'crew', 'kiro stderr line\n']);
  assert.deepEqual(events.filter(([kind]) => kind === 'startupMark').map(([, name]) => name), ['kiro_spawn_start', 'kiro_spawn_done']);
  assert.ok(events.some(([kind, stage]) => kind === 'mark' && stage === 'acp:spawn_requested'));
  assert.ok(events.some(([kind, level, scope, msg]) => kind === 'log' && level === 'info' && scope === 'acp' && msg === 'kiro process spawned'));
});

test('an AcpClient without a host reports nothing and still runs', async () => {
  const client = new AcpClient(undefined, process.cwd(), undefined, 'v2', {
    bin: process.execPath, args: () => ['-e', "process.stderr.write('ignored\\n'); setInterval(() => {}, 1000)"],
  });
  client.start();
  assert.equal(client.isAlive(), true);
  await client.shutdown();
});

test('KiroRuntime hands its host\'s observability to every ACP client it starts', async (t) => {
  t.mock.method(AcpClient.prototype, 'start', () => {});
  t.mock.method(AcpClient.prototype, 'initialize', async () => {});
  t.mock.method(AcpClient.prototype, 'shutdown', async () => {});
  const { events, observability } = recordingObservability();
  const host = { ...michiTestHost(), observability };
  const runtime = new KiroRuntime({ bridge, defaultCwd: '/tmp/michi-kiro-observability', host });
  try {
    const client = await runtime.ensureClient('/tmp/michi-kiro-observability');
    assert.equal((client as unknown as { observability: unknown }).observability, observability);
    assert.ok(events.some(([kind, stage]) => kind === 'measure' && stage === 'ensureClient:cold'));
  } finally {
    await runtime.shutdown();
  }
});

test('Michi\'s host writes Kiro\'s child stderr to kiro-cli.log', (t) => {
  const written: string[] = [];
  t.mock.method(michiLog, 'acpStderr', (chunk: string) => { written.push(chunk); });
  michiTestHost().observability.childStderr?.('kiro', 'raw bytes\n');
  assert.deepEqual(written, ['raw bytes\n']);
});

test('Kiro\'s remaining warnings and notices go to the observability port', async () => {
  const { events, observability } = recordingObservability();
  const logs = () => events.filter(([kind]) => kind === 'log').map(([, level, scope, msg]) => [level, scope, msg]);

  const client = new AcpClient(undefined, '/tmp', undefined, 'v2', undefined, 'kiro', { observability });
  (client as unknown as { dispatch(message: unknown): void }).dispatch({ method: '_kiro.dev/session/inbox_notification',
    params: { sessionId: 'sid-1', messageCount: 2, senders: ['alice', 'bob'] } });
  assert.deepEqual(logs(), [['info', 'acp', 'inbox notification for session sid-1: 2 message(s) from alice, bob']]);

  events.length = 0;
  const cache = { load: () => [{ modelId: 'cached-model', name: 'Cached' }], save: () => {} };
  const runtime = new KiroRuntime({ bridge, defaultCwd: '/tmp/michi-kiro-observability', modelCache: cache as never,
    host: { ...michiTestHost(), observability } });
  try {
    runtime.refreshModels = async () => { throw new Error('offline'); };
    await runtime.listModels();
    await new Promise((resolve) => setImmediate(resolve));
    (runtime as unknown as { ensureClient(): Promise<never> }).ensureClient = async () => { throw new Error('no kiro-cli'); };
    runtime.warmNextSession('/tmp/michi-kiro-warm');
    await (runtime as unknown as { warmSessionLocks: Map<string, Promise<void>> }).warmSessionLocks.get('/tmp/michi-kiro-warm');
    assert.deepEqual(logs(), [
      ['warn', 'acp', 'model refresh failed; using cached catalog'],
      ['warn', 'acp', 'warmNextSession(/tmp/michi-kiro-warm) failed'],
    ]);
    assert.deepEqual(events.filter(([kind]) => kind === 'log').map(([, , , , data]) => data),
      [{ error: 'offline' }, { error: new Error('no kiro-cli') }]);
  } finally {
    await runtime.shutdown();
  }
});
