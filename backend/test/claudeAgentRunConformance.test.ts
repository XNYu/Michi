import './isolatedConfigDir';
import test, { describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { claudeTestOptions } from './helpers/claudeTestOptions';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EffectiveAgentDefinitionV1 } from 'michi-shared';
import { ClaudeRunAdapter } from '../src/agents/runs/claudeRunAdapter';
import { RuntimeRunExecutor } from '../src/agents/runs/runtimeRunExecutor';
import { ClaudeSessionManager } from 'michi-runtime/internal/adapters/claude/ClaudeSessionManager';
import { ClaudeSession } from 'michi-runtime/internal/adapters/claude/ClaudeSession';
import type { AgentRuntime, NewAgentSessionOptions, RuntimePermissionRequest } from '../src/agents/types';
import type { ClaudeSdkTransport, ClaudeSdkTransportOptions } from 'michi-runtime/internal/adapters/claude/claudeSdkTransport';
import type { AgentRunSpec } from '../src/agents/runs/ports';
import { clearAllSessions } from '../src/agents/sessionRegistry';
import {
  registerConformanceSuite, makeConformanceToolProfile, attemptIdOf, RUN_OWNER,
  CONFORMANCE_ATTEMPT_ID, CONFORMANCE_RUN_ID, type ConformanceHarness,
} from './fixtures/runtimeRunConformance';
import { runOwner } from './helpers/owners';
import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime/internal/core/descriptors';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
class FixtureChild extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  kill() { queueMicrotask(() => this.emit('exit', 0, null)); return true; }
}

/** Real Claude Session/Manager. Only the SDK transport is replaced. */
function createClaudeHarness() {
  const records: Array<{ options: ClaudeSdkTransportOptions; sends: SDKUserMessage[]; interrupts: number }> = [];
  const transport = mock.method(require('michi-runtime/internal/adapters/claude/claudeSdkTransport'), 'createClaudeSdkTransport',
    async (options: ClaudeSdkTransportOptions): Promise<ClaudeSdkTransport> => {
      const child = new FixtureChild();
      const record = { options, sends: [] as SDKUserMessage[], interrupts: 0 };
      records.push(record);
      queueMicrotask(() => options.onMessage({ type: 'system', subtype: 'init',
        session_id: options.resumeSessionId ?? options.sessionId }));
      return {
        child: child as any,
        query: { interrupt: async () => {
          record.interrupts++;
          queueMicrotask(() => options.onMessage({ type: 'result', subtype: 'success' }));
        }, setModel: async () => {}, setPermissionMode: async () => {} } as unknown as Query,
        initialized: Promise.resolve({} as any),
        send: (message) => { record.sends.push(message); }, close: () => {},
      };
    });
  const slots = new Map<string, any>();
  let nextSlot = 0;
  const manager = new ClaudeSessionManager({
    options: claudeTestOptions(),
    bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
    mcpRegistry: {
      create: (_id: string, _cwd: string, _user: string, callbacks: unknown) => {
        const slot = { slotId: `slot-${++nextSlot}`, ...(callbacks as object) };
        slots.set(slot.slotId, slot); return slot;
      },
      get: (id: string) => slots.get(id), dispose: async (id: string) => { slots.delete(id); },
      endpoint: (slotId: string) => ({ type: 'http' as const, url: `http://127.0.0.1:3000/api/mcp/${slotId}`, headers: [] }),
      // In place: the conformance checks read the slot objects of this map.
      rebind: (id: string, patch: object) => { const slot = slots.get(id); if (slot) Object.assign(slot, patch); },
    } as any,
    concurrencyCap: 4, currentModel: 'claude-sonnet-4-5', poolDisabled: true,
  });
  const create = (opts: Parameters<ConformanceHarness['createRunSession']>[0]) => manager.createSession({
    id: attemptIdOf(opts.owner), owner: opts.owner, cwd: '/tmp', profileHash: opts.profileHash,
    toolProfile: opts.toolProfile ?? makeConformanceToolProfile(), permissionBroker: opts.permissionBroker,
    enableFollowUps: false,
  });
  const harness: ConformanceHarness = {
    runtimeLabel: 'Claude Session + SDK transport fixture', adapter: new ClaudeRunAdapter(),
    async createRunSession(opts) { const session = await create(opts); return { session, nativeSessionId: session.nativeSessionId }; },
    async resumeRunSession(opts) {
      const session = await manager.loadSession({ id: attemptIdOf(opts.owner), owner: opts.owner,
        cwd: '/tmp', externalSessionId: opts.nativeResumeToken, profileHash: opts.profileHash,
        toolProfile: opts.toolProfile ?? makeConformanceToolProfile(), permissionBroker: opts.permissionBroker,
        enableFollowUps: false });
      return { session, nativeSessionId: session.nativeSessionId };
    },
    releaseSession: (id, owner) => manager.releaseSession(id, owner),
    releaseSessionWrongOwner: (id, owner) => manager.releaseSession(id, owner),
    async cleanup() { await manager.shutdown(); transport.mock.restore(); clearAllSessions(); },
  };
  const runtime: AgentRuntime = {
    descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
    id: 'claude', label: 'Claude transport fixture', capabilities: {
      modes: false, permissions: true, models: true, providerModels: false, reasoning: true,
      supportedReasoningLevels: ['medium'], apiKeys: false, warmSessions: false,
      saveContext: true, spawnBranches: true, nativeResume: true,
    },
    warm: async () => {},
    newSession: (opts: NewAgentSessionOptions) => manager.createSession({
      id: opts.sessionId!, owner: opts.owner, cwd: opts.cwd, ownerUserId: opts.ownerUserId,
      workspaceId: opts.workspaceId, profileHash: opts.profileHash, model: opts.model,
      reasoning: opts.reasoning, firstTurnPrefix: opts.bootstrapInstructions,
      toolProfile: opts.toolProfile, permissionBroker: opts.permissionBroker, enableFollowUps: opts.enableFollowUps,
    }),
    releaseSession: (id, owner) => manager.releaseSession(id, owner), shutdown: () => manager.shutdown(),
  };
  return { ...harness, manager, records, runtime, slots };
}

registerConformanceSuite({ test, describe, createHarness: createClaudeHarness });

test('Claude adapter declares the actual Session steering strategy', async () => {
  const harness = createClaudeHarness();
  try {
    const { session } = await harness.createRunSession({ owner: RUN_OWNER });
    assert(session instanceof ClaudeSession);
    // Chat sessions steer natively; a Run session refuses and the Executor
    // holds supplemental input for the next turn.
    assert.deepEqual(await session.steer('more'), { accepted: false, reason: 'unsupported' });
    assert.equal('followUp' in session, false);
    assert.equal(harness.adapter.steering, 'next_turn');
  } finally { await harness.cleanup(); }
});

test('real Claude SDK permission policy uses the Run broker and enforces the allowlist', async () => {
  const harness = createClaudeHarness();
  try {
    const requests: RuntimePermissionRequest[] = [];
    await harness.createRunSession({ owner: RUN_OWNER, toolProfile: { allowedToolNames: ['bash'] },
      permissionBroker: { requestPermission: async (request) => { requests.push(request); return 'allow_once'; } } });
    const { options } = harness.records[0];
    assert.equal((await options.preToolUse('Bash', { command: 'pwd' }, 'tool-1', new AbortController().signal))?.behavior, 'allow');
    assert.deepEqual(requests[0].owner, RUN_OWNER);
    assert.equal((await options.preToolUse('Write', { path: 'x' }, 'tool-2', new AbortController().signal))?.behavior, 'deny');
    assert.equal(requests.length, 1);
  } finally { await harness.cleanup(); }
});

function runSpec(): AgentRunSpec {
  const effectiveDefinition: EffectiveAgentDefinitionV1 = {
    version: 1, name: 'Worker', description: '', instructions: 'Follow instructions',
    runtimeProfile: { version: 1, runtimeId: 'claude', modelId: 'claude-sonnet-4-5', reasoning: 'medium' },
    fallbackChain: [], capabilitySnapshot: { version: 1, entries: [] },
    permissionPolicy: { version: 1, preset: 'research', categories: {}, maxDelegationDepth: 1, maxConcurrentRuns: 1, maxWallTimeMs: 60_000, maxAttempts: 1 },
    contextPolicy: { version: 1, includeWorkspaceInstructions: true, allowMessageContext: true, allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 10_000 },
  };
  return { runId: CONFORMANCE_RUN_ID, attemptId: CONFORMANCE_ATTEMPT_ID, workspaceId: 'workspace', ownerUserId: 'user',
    task: 'original task', effectiveDefinition, contextManifest: { version: 1, entries: [], assembledAt: 1, estimatedChars: 0 },
    expectedResult: null, executionEnvironment: { version: 1, kind: 'shared_workspace', cwd: '/tmp',
      sourceWorkspaceId: 'workspace', snapshotHash: 'd'.repeat(64), createdAt: 1 }, recoveryEnvelope: null };
}

for (const mode of ['queued', 'immediate'] as const) {
  test(`real Claude Session receives ${mode} Run input in a new turn`, async () => {
    const harness = createClaudeHarness();
    try {
      const handle = await new RuntimeRunExecutor({ resolveRuntime: () => harness.runtime,
        adapters: [harness.adapter] }).start(runSpec(), async () => {});
      await tick();
      const record = harness.records[0];
      assert.equal(record.sends.length, 1);
      await handle.input('additional direction', mode);
      if (mode === 'queued') {
        assert.equal(record.interrupts, 0);
        assert.equal(record.sends.length, 1);
        record.options.onMessage({ type: 'result', subtype: 'success' });
      } else assert.equal(record.interrupts, 1, 'immediate input waits for native interrupt plus result');
      await tick();
      assert.equal(record.sends.length, 2);
      assert.match(JSON.stringify(record.sends[1].message.content), /additional direction/);
      record.options.onMessage({ type: 'result', subtype: 'success' });
      assert.equal((await handle.completion).status, 'completed');
      await assert.rejects(handle.input('too late'), /completed|finalizing/);
      assert.equal(harness.manager.get(CONFORMANCE_ATTEMPT_ID), undefined);
    } finally { await harness.cleanup(); }
  });
}

test('real Claude Session rejects the tool call when a Run permission is denied', async () => {
  const harness = createClaudeHarness();
  try {
    const spec = runSpec();
    spec.effectiveDefinition = { ...spec.effectiveDefinition, capabilitySnapshot: { version: 1, entries: [{
      id: 'bash', kind: 'tool', revision: '1', schemaHash: 'a'.repeat(64), contentHash: null,
      configHash: 'b'.repeat(64), publicConfig: {}, credentialBindingIds: [] }] } };
    const handle = await new RuntimeRunExecutor({ resolveRuntime: () => harness.runtime, adapters: [harness.adapter],
      createPermissionBroker: () => ({ requestPermission: async () => 'ask' }) }).start(spec, async () => {});
    await tick();
    const record = harness.records[0];
    const verdict = record.options.preToolUse('Bash', { command: 'rm -rf build' }, 'tool-1', new AbortController().signal);
    const waiting = await handle.completion;
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.status === 'waiting' && waiting.kind, 'permission');
    await handle.input('deny');
    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([verdict, new Promise<'hung'>((resolve) => { timer = setTimeout(() => resolve('hung'), 2_000); })]);
    clearTimeout(timer);
    assert.notEqual(settled, 'hung', 'the denied tool call must settle instead of waiting for the approval timeout');
    assert.equal(settled === 'hung' ? undefined : settled?.behavior, 'deny');
    record.options.onMessage({ type: 'result', subtype: 'success' });
    assert.equal((await handle.continueAfterInput?.())?.status, 'completed');
  } finally { await harness.cleanup(); }
});

test('real Claude Session concurrent acquire joins and wrong owner/profile is rejected', async () => {
  const harness = createClaudeHarness();
  try {
    const opts = { id: CONFORMANCE_ATTEMPT_ID, owner: RUN_OWNER, cwd: '/tmp', profileHash: 'profile' };
    const a = harness.manager.createSession(opts);
    const b = harness.manager.createSession(opts);
    // Another Attempt of the same Run: the Attempt id alone names the owner.
    const wrong = assert.rejects(harness.manager.createSession({ ...opts, owner: runOwner(CONFORMANCE_RUN_ID, 'other-attempt') }), /Owner mismatch/);
    const wrongProfile = assert.rejects(harness.manager.createSession({ ...opts, profileHash: 'different' }), /profile hash mismatch/);
    const [first, second] = await Promise.all([a, b]);
    await Promise.all([wrong, wrongProfile]);
    assert.equal(first, second);
    assert.equal(harness.records.length, 1);
    await assert.rejects(harness.manager.releaseSession(first.id, runOwner(CONFORMANCE_RUN_ID, 'other-attempt')), /Owner mismatch/);
    assert.equal(harness.manager.get(first.id), first);
  } finally { await harness.cleanup(); }
});
