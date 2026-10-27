import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { TestContext } from 'node:test';
import { CodexAppServerClient } from 'michi-runtime/internal/adapters/codex/CodexAppServerClient';
import { CodexRuntime } from 'michi-runtime/internal/adapters/codex/CodexRuntime';
import type { CodexSession } from 'michi-runtime/internal/adapters/codex/CodexSession';
import type { RuntimePermissionDecision } from '../../../src/agents/types';
import type { McpSlot } from '../../../src/services/mcpServer';
import type { NormalizedEvent } from '../../../src/services/chatEvents';
import { assertSchema } from './schema';
import { responseTypes } from './dispositions';
import { fakeMcpRegistry } from '../../helpers/fakeMcpRegistry';
import { chatOwner, runOwner } from '../../helpers/owners';
import { codexTestOptions } from '../../helpers/codexTestOptions';

export const threadId = 'contract-thread';
export const turnId = 'contract-turn';
export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
export function turnNotification(status: string) {
  return { method: status === 'inProgress' ? 'turn/started' : 'turn/completed', params: {
    threadId, turn: { id: turnId, items: [], status, error: status === 'failed' ? { message: 'Fixture failure' } : null },
  } };
}

export async function wireClient(t: TestContext, cleanup = true) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill() { child.emit('exit', 0); return true; },
  });
  const outgoing: Array<Record<string, any>> = [];
  let buffer = '';
  child.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let index: number;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      outgoing.push(message);
      if (!message.method || message.id === undefined) continue;
      // Infrastructure replies only; tests validate server-initiated fixtures below.
      const title = message.params?.threadId === `${threadId}-title`;
      const result = message.method === 'initialize' ? { userAgent: 'contract-fake' }
        : message.method === 'thread/start' ? { thread: { id: message.params?.ephemeral ? `${threadId}-title` : threadId } }
        : message.method === 'turn/start' ? { turn: { id: title ? 'title-turn' : turnId } }
        : message.method === 'model/list' ? { data: [] } : {};
      child.stdout.write(JSON.stringify({ id: message.id, result }) + '\n');
      if (message.method === 'turn/start' && title) {
        queueMicrotask(() => child.stdout.write(JSON.stringify({ method: 'turn/completed', params: {
          threadId: `${threadId}-title`, turn: { id: 'title-turn', items: [], status: 'completed' },
        } }) + '\n'));
      }
    }
  });
  const client = new CodexAppServerClient({ spawnFn: () => child as unknown as ChildProcessWithoutNullStreams, initTimeoutMs: 1_000 });
  if (cleanup) t.after(() => client.shutdown());
  await client.ensureStarted();
  const send = (message: object, type?: 'ServerRequest' | 'ServerNotification') => {
    if (type) assertSchema(type, message);
    const jsonl = JSON.stringify(message) + '\n';
    // Exercise the actual JSONL reader, including a fragmented line.
    const split = Math.floor(jsonl.length / 2);
    child.stdout.write(jsonl.slice(0, split));
    child.stdout.write(jsonl.slice(split));
  };
  const responses = (id: string | number) => outgoing.filter((m) => m.id === id && !m.method);
  const response = (id: string | number, method: string) => {
    const values = responses(id);
    assert.equal(values.length, 1, `${method}: exactly one serialized reply for ${String(id)}`);
    const value = values[0];
    assert.notEqual('result' in value, 'error' in value, 'result XOR error');
    assertSchema('error' in value ? 'JSONRPCError' : 'JSONRPCResponse', value);
    if ('result' in value) assertSchema(responseTypes[method], value.result);
    return value;
  };
  return { client, outgoing, send, responses, response };
}

export async function activeWire(t: TestContext, chat = false) {
  const wire = await wireClient(t, false);
  const broker = { decision: 'ask' as RuntimePermissionDecision, async requestPermission() { return this.decision; } };
  const runtime = new CodexRuntime({ ...codexTestOptions(), bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null }, mcpSlots: fakeMcpRegistry({
    create: () => ({ slotId: 'contract-slot' }) as McpSlot, get: () => undefined,
  }, { mcpPort: 0 }) }, { client: wire.client, followUpsHookPocEnabled: false, followUpsExperimentMode: 'sentinel' });
  const session = await runtime.newSession({
    sessionId: 'contract-attempt', cwd: process.env.MICHI_DATA_DIR!, model: 'fixture-model',
    owner: chat ? chatOwner('contract-attempt') : runOwner('contract-run', 'contract-attempt'),
    permissionBroker: broker, enableFollowUps: false,
  }) as CodexSession;
  const events: NormalizedEvent[] = [];
  const drain = (async () => { for await (const event of session.send('contract fixture')) events.push(event); })();
  t.after(async () => {
    if (session.isBusy()) wire.send(turnNotification('completed'), 'ServerNotification');
    await drain;
    await runtime.shutdown();
  });
  await tick();
  assert.ok(session.acceptsControl({ threadId, turnId }));
  return { ...wire, runtime, session, events, drain, broker };
}
