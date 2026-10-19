import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { CursorRuntime } from '../src/agents/cursor/CursorRuntime';
import { GrokRuntime, grokForkChildId } from '../src/agents/grok/GrokRuntime';
import { AcpSession } from '../src/agents/acp/AcpSession';
import { ACPError } from '../src/services/acp/errors';
import { NativeResumeUnavailableError } from '../src/services/nativeResume';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import type { ForkAgentSessionOptions } from '../src/agents/types';

const bridge: AgentToolBridge = {
  spawnBranches: async () => [],
  saveContext: () => null,
  updateContext: () => null,
};

function runtime(): GrokRuntime {
  return new GrokRuntime(bridge, undefined, 0, '/tmp');
}

function forkOpts(extra: Partial<ForkAgentSessionOptions> = {}): ForkAgentSessionOptions {
  return {
    cwd: '/tmp/workspace',
    sessionId: 'child-node',
    parentChatId: 'parent-node',
    sourceNativeSessionId: 'parent-native',
    ...extra,
  };
}

describe('Grok native fork', () => {
  test('parses an independent child id', () => {
    assert.equal(grokForkChildId({ newSessionId: 'child-native' }, 'parent-native'), 'child-native');
    assert.throws(() => grokForkChildId({ newSessionId: 'parent-native' }, 'parent-native'), /independent/);
    assert.throws(() => grokForkChildId({}, 'parent-native'), /independent/);
  });

  test('forks the latest conversation through the Grok extension and loads that child', async () => {
    const grok = runtime();
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let loaded: unknown;
    (grok as any).ensureClient = async () => ({
      extensionRequest: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return { newSessionId: 'child-native', parentSessionId: 'parent-native' };
      },
    });
    (grok as any).loadSession = async (opts: unknown) => {
      loaded = opts;
      return new AcpSession('child-node', 'child-native', grok, '/tmp/workspace', { parentChatId: 'parent-node' });
    };
    (grok as any).setModel = async () => { throw new Error('setModel should not run without a model'); };

    const session = await grok.forkSession(forkOpts());
    assert.equal(session.id, 'child-node');
    assert.equal(session.nativeSessionId, 'child-native');
    assert.equal(session.parentChatId, 'parent-node');
    assert.deepEqual(calls, [{
      method: '_x.ai/session/fork',
      params: { sourceSessionId: 'parent-native', sourceCwd: '/tmp/workspace', newCwd: '/tmp/workspace' },
    }]);
    assert.equal((loaded as { sessionId: string }).sessionId, 'child-native');
    assert.equal((loaded as { nodeId: string }).nodeId, 'child-node');
    assert.match((session as any).firstMessagePreamble, /michi_docs/);
  });

  test('a historical anchor falls back without calling Grok', async () => {
    const grok = runtime();
    (grok as any).ensureClient = async () => { throw new Error('anchor must not open a client'); };
    await assert.rejects(
      grok.forkSession(forkOpts({ anchorMessageId: 'msg-1' })),
      NativeResumeUnavailableError,
    );
  });

  test('a missing parent session falls back', async () => {
    const grok = runtime();
    (grok as any).ensureClient = async () => ({
      extensionRequest: async () => { throw new ACPError('Internal error', { rpcCode: -32603 }); },
    });
    await assert.rejects(
      grok.forkSession(forkOpts()),
      NativeResumeUnavailableError,
    );
  });

  test('Cursor has no native fork method', () => {
    const cursor = new CursorRuntime(bridge, undefined, 0, '/tmp');
    assert.equal((cursor as { forkSession?: unknown }).forkSession, undefined);
  });
});
