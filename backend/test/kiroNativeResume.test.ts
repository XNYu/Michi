import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpClient, ACPError } from 'michi-runtime/internal/adapters/kiro/acpClient';
import { AcpAgentRuntime } from 'michi-runtime/internal/adapters/kiro/AcpAgentRuntime';
import { NativeResumeUnavailableError } from '../src/services/nativeResume';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import type { McpSlot } from 'michi-runtime/internal/contract/mcp';
import { fakeMcpRegistry } from './helpers/fakeMcpRegistry';
import { michiTestHost } from './helpers/michiTestHost';

function fixture() {
  const models: string[][] = [];
  const disposed: string[] = [];
  const client = {
    loadSession: async () => ({ models: { currentModelId: 'old-model' }, modes: { currentModeId: 'original-agent' } }),
    setModel: async (id: string, model: string) => { models.push([id, model]); },
  };
  const registry = fakeMcpRegistry({
    create: () => ({ slotId: 'slot' }) as McpSlot,
    dispose: async (slot: string) => { disposed.push(slot); },
  });
  const runtime = new AcpAgentRuntime({ bridge: {} as AgentToolBridge, mcpSlots: registry, defaultCwd: '/tmp', host: michiTestHost() });
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
