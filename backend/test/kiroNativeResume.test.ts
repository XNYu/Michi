import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpClient, ACPError } from '../src/services/acpClient';
import { KiroRuntime } from '../src/agents/kiro/KiroRuntime';
import { NativeResumeUnavailableError } from '../src/services/nativeResume';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import type { McpSlotRegistry } from '../src/services/mcpServer';

function fixture() {
  const models: string[][] = [];
  const disposed: string[] = [];
  const client = {
    loadSession: async () => ({ models: { currentModelId: 'old-model' }, modes: { currentModeId: 'original-agent' } }),
    setModel: async (id: string, model: string) => { models.push([id, model]); },
  };
  const registry = {
    create: () => ({ slotId: 'slot' }),
    dispose: async (slot: string) => { disposed.push(slot); },
  } as unknown as McpSlotRegistry;
  const runtime = new KiroRuntime({} as AgentToolBridge, registry, 0, '/tmp');
  runtime.ensureClient = async () => client as unknown as AcpClient;
  return { runtime, client, models, disposed };
}

test('native Kiro load applies a model change on the same session and keeps the agent mode', async () => {
  const { runtime, models, disposed } = fixture();
  const result = await runtime.loadAcpSession({ sessionId: 'original', cwd: '/tmp', model: 'new-model' });
  assert.equal(result.sid, 'original');
  assert.equal(result.modes.currentModeId, 'original-agent');
  assert.equal(runtime.getCurrentModel('original'), 'new-model');
  assert.deepEqual(models, [['original', 'new-model']]);
  assert.deepEqual(disposed, []);
});

test('only the observed missing-session failure is mapped to explicit unavailability', async () => {
  const { runtime, client, disposed } = fixture();
  client.loadSession = async () => { throw new ACPError('Internal error', {
    method: 'session/load', sessionId: 'original', rpcCode: -32603,
    rpcData: 'Failed to start session: Session not found: original',
  }); };
  await assert.rejects(runtime.loadAcpSession({ sessionId: 'original', cwd: '/tmp' }), NativeResumeUnavailableError);
  assert.deepEqual(disposed, ['slot']);
});

test('a model-selection failure cleans up its MCP slot without declaring native history unavailable', async () => {
  const { runtime, client, disposed } = fixture();
  const cause = new Error('model not found');
  client.setModel = async () => { throw cause; };
  await assert.rejects(runtime.loadAcpSession({ sessionId: 'original', cwd: '/tmp', model: 'invalid' }), (error) => error === cause);
  assert.deepEqual(disposed, ['slot']);
});

test('failed initialization shuts down the spawned process and releases the start lock for retry', async (t) => {
  let starts = 0;
  let shutdowns = 0;
  let initializes = 0;
  t.mock.method(AcpClient.prototype, 'start', () => { starts++; });
  t.mock.method(AcpClient.prototype, 'shutdown', async () => { shutdowns++; });
  t.mock.method(AcpClient.prototype, 'initialize', async () => { if (++initializes === 1) throw new Error('startup failure'); });
  const runtime = new KiroRuntime({} as AgentToolBridge, undefined, 0, '/tmp');
  try {
    await assert.rejects(runtime.ensureClient('/tmp'), /startup failure/);
    assert.equal(shutdowns, 1);
    assert.ok(await runtime.ensureClient('/tmp'));
    assert.equal(starts, 2);
  } finally {
    await runtime.shutdown();
  }
});

test('failed ACP native load removes only the queue it allocated', async () => {
  const client = new AcpClient('/bin/false', '/tmp');
  const internals = client as any;
  const priorQueue = { drain() {} };
  internals.sessionQueues.set('existing', priorQueue);
  internals.send = async () => { throw new Error('load failed'); };
  await assert.rejects(client.loadSession('new', '/tmp'));
  assert.equal(internals.sessionQueues.has('new'), false);
  await assert.rejects(client.loadSession('existing', '/tmp'));
  assert.equal(internals.sessionQueues.get('existing'), priorQueue);
});
