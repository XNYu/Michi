import { KiroSignedOutError } from '../src/agents/kiro/kiroAuth';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireSessionRestoreLock, loadNativeSession, NativeResumeFailedError, nativeResumeIdFor } from '../src/services/nativeResume';
import { ClaudeRuntime } from 'michi-runtime/internal/adapters/claude/ClaudeRuntime';
import { CodexRuntime } from 'michi-runtime/internal/adapters/codex/CodexRuntime';
import { ACPError, ACPNotRunningError } from 'michi-runtime/internal/adapters/kiro/acpClient';
import { isNativeSessionUnavailable } from 'michi-runtime/internal/adapters/kiro/acpErrors';
import { AcpAgentRuntime } from 'michi-runtime/internal/adapters/kiro/AcpAgentRuntime';
import type { AgentRuntime, AgentSession } from '../src/agents/types';

const options = { sessionId: 'node', nodeId: 'node', cwd: '/tmp' };
const session = { id: 'node', nativeSessionId: 'original' } as AgentSession;

test('the runtime names the resume id when it reads its own binding; otherwise the host reads the ACP column first', () => {
  const row = { id: 'node', acp_session_id: 'acp', external_session_id: 'ext' };
  const codex = { id: 'codex', resumeTokenFromBinding: CodexRuntime.prototype.resumeTokenFromBinding };
  const claude = { id: 'claude', resumeTokenFromBinding: ClaudeRuntime.resumeTokenFromBinding };
  assert.equal(nativeResumeIdFor(codex, row), 'ext');
  assert.equal(nativeResumeIdFor(claude, row), 'ext');
  assert.equal(nativeResumeIdFor({ id: 'fixture-plain' }, row), 'acp');
  // The runtime's null is the answer: Claude's placeholder is not resumable, though the ACP column holds it.
  assert.equal(nativeResumeIdFor(claude, { id: 'node', acp_session_id: 'node', external_session_id: null }), null);
  assert.equal(nativeResumeIdFor({ id: 'fixture-plain' }, { id: 'node', acp_session_id: 'node', external_session_id: null }), 'node');
});

test("Claude resumes its external id, else the ACP column, never the node's placeholder", () => {
  const token = ClaudeRuntime.resumeTokenFromBinding;
  assert.equal(token({ id: 'node', acp_session_id: 'acp', external_session_id: 'ext' }), 'ext');
  assert.equal(token({ id: 'node', acp_session_id: 'acp', external_session_id: null }), 'acp');
  assert.equal(token({ id: 'node', acp_session_id: 'node', external_session_id: null }), null);
  assert.equal(token({ id: 'node', acp_session_id: null, external_session_id: 'node' }), null);
  assert.equal(token({ acp_session_id: null, external_session_id: null }), null);
  assert.equal(token(null), null);
  assert.equal(token(undefined), null);
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
  const retryable = AcpAgentRuntime.prototype.isNativeResumeRetryable;
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


test('a signed-out native restore runs once and preserves the actionable cause', async () => {
  let attempts = 0;
  const runtime = { capabilities: { nativeResume: true }, isNativeResumeRetryable: () => true,
    async loadSession() { attempts++; throw new KiroSignedOutError(); },
  } as unknown as AgentRuntime;
  await assert.rejects(loadNativeSession(runtime, options, 'original'), error => {
    assert.ok(error instanceof NativeResumeFailedError);
    assert.match(error.message, /not signed in/);
    return true;
  });
  assert.equal(attempts, 1);
  assert.equal(AcpAgentRuntime.prototype.isNativeResumeRetryable(new KiroSignedOutError()), false);
});
