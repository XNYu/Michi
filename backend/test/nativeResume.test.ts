import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireSessionRestoreLock, loadNativeSession, NativeResumeFailedError, NativeResumeUnavailableError } from '../src/services/nativeResume';
import { ACPError, ACPNotRunningError } from '../src/services/acpClient';
import { isNativeSessionUnavailable } from '../src/agents/kiro/acpErrors';
import { KiroRuntime } from '../src/agents/kiro/KiroRuntime';
import type { AgentRuntime, AgentSession } from '../src/agents/types';

const options = { sessionId: 'node', nodeId: 'node', cwd: '/tmp' };
const session = { id: 'node', nativeSessionId: 'original' } as AgentSession;

test('native load retries a completed transient failure, preserving the same options and identity', async () => {
  let attempts = 0;
  const runtime = {
    capabilities: { nativeResume: true },
    isNativeResumeRetryable: () => true,
    async loadSession(received: unknown) {
      assert.equal(received, options);
      if (++attempts < 3) throw new Error('transient');
      return session;
    },
  } as unknown as AgentRuntime;
  assert.equal(await loadNativeSession(runtime, options), session);
  assert.equal(attempts, 3);
});

test('native retries are bounded and exhaustion never permits compatible reconstruction', async () => {
  let attempts = 0;
  const runtime = {
    capabilities: { nativeResume: true }, isNativeResumeRetryable: () => true,
    async loadSession() { attempts++; throw new Error('transient'); },
  } as unknown as AgentRuntime;
  await assert.rejects(loadNativeSession(runtime, options), NativeResumeFailedError);
  assert.equal(attempts, 3);
});

test('unknown or authentication failures are retained, not retried or downgraded', async () => {
  for (const message of ['MCP server not found', 'ExpiredTokenException', 'Internal error']) {
    let attempts = 0;
    const cause = new Error(message);
    const runtime = {
      capabilities: { nativeResume: true },
      async loadSession() { attempts++; throw cause; },
    } as unknown as AgentRuntime;
    await assert.rejects(loadNativeSession(runtime, options), (error: unknown) => {
      assert.ok(error instanceof NativeResumeFailedError);
      assert.equal(error.cause, cause);
      return true;
    });
    assert.equal(attempts, 1);
  }
});

test('only explicit native unavailability permits compatible reconstruction', async () => {
  const runtime = {
    capabilities: { nativeResume: true },
    async loadSession() { throw new NativeResumeUnavailableError('missing native state'); },
  } as unknown as AgentRuntime;
  assert.equal(await loadNativeSession(runtime, options), null);
});

test('a native identity mismatch is rejected and released, never persisted as a replacement', async () => {
  let released = 0;
  const runtime = {
    capabilities: { nativeResume: true }, isNativeResumeRetryable: () => true,
    async loadSession() { return { ...session, nativeSessionId: 'replacement' }; },
    async releaseSession() { released++; },
  } as unknown as AgentRuntime;
  await assert.rejects(loadNativeSession(runtime, options, 'original'), NativeResumeFailedError);
  assert.equal(released, 1);
});

test('Kiro missing-session classification uses the exact observed error envelope and target ID', () => {
  const details = { method: 'session/load', sessionId: 'native-id', rpcCode: -32603,
    rpcData: 'Failed to start session: Session not found: native-id' };
  assert.equal(isNativeSessionUnavailable(new ACPError('Internal error', details), 'native-id'), true);
  for (const changed of [
    { sessionId: 'other' }, { method: 'session/set_model' }, { rpcCode: -1 },
    { rpcData: 'MCP server not found' }, { rpcData: 'Failed to start session: Session not found: other' },
  ]) {
    assert.equal(isNativeSessionUnavailable(new ACPError('Internal error', { ...details, ...changed }), 'native-id'), false);
  }
  assert.equal(isNativeSessionUnavailable(new Error(details.rpcData), 'native-id'), false);
  assert.equal(isNativeSessionUnavailable(new ACPError('Method not found', { ...details, rpcCode: -32601 }), 'native-id'), true);
});

test('Kiro retries dead processes and service throttling but not auth, MCP or ambiguous idle timeouts', () => {
  const retryable = KiroRuntime.prototype.isNativeResumeRetryable;
  assert.equal(retryable(new ACPNotRunningError('not running')), true);
  assert.equal(retryable(new ACPError('Internal error', { rpcData: 'ThrottlingException' })), true);
  for (const error of [new ACPError('Request session/load idle for 180000ms (no updates from agent)'),
    new ACPError('Internal error', { rpcData: 'ExpiredTokenException' }), new Error('MCP not found')]) {
    assert.equal(retryable(error), false);
  }
});

test('per-node restore lock serializes same-node work, allows other nodes and releases after errors', async () => {
  const first = await acquireSessionRestoreLock('one');
  const order: number[] = [];
  const second = acquireSessionRestoreLock('one').then((release) => { order.push(2); release(); });
  const third = acquireSessionRestoreLock('one').then((release) => { order.push(3); release(); });
  const other = await acquireSessionRestoreLock('two');
  other();
  assert.deepEqual(order, []);
  first(); first();
  await Promise.all([second, third]);
  assert.deepEqual(order, [2, 3]);
  (await acquireSessionRestoreLock('one'))();
});
