import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { KiroRuntime } from '../src/agents/kiro/KiroRuntime';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import type { AgentSession } from '../src/agents/types';
import type { ModelInfo } from '../src/agents/types';
import type { RuntimeModelCache } from '../src/agents/runtimeModelCache';

const bridge: AgentToolBridge = {
  spawnBranches: async () => [],
  saveContext: () => null,
  updateContext: () => null,
};

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('KiroRuntime warm session handoff', () => {
  test('newSession waits for matching inflight warm slot and consumes it', async () => {
    const runtime = new KiroRuntime(bridge, undefined, 0, '/tmp/default');
    const rt = runtime as any;

    rt.ensureClient = async () => ({});
    let coldSessionNewCalls = 0;
    rt.openSession = async () => {
      coldSessionNewCalls += 1;
      return { sid: `cold-${coldSessionNewCalls}` };
    };

    let replenishCalls = 0;
    rt.warmNextSession = () => {
      replenishCalls += 1;
    };

    let releaseWarm!: () => void;
    const warmLock = new Promise<void>((resolve) => {
      releaseWarm = () => {
        rt.warmedSessions.set('/tmp/a', {
          sid: 'warm-sid',
          currentModeId: 'mode-warm',
        });
        resolve();
      };
    });
    rt.warmSessionLocks.set('/tmp/a', warmLock);

    let resolved = false;
    const pending = runtime.newSession({ cwd: '/tmp/a' }).then((session) => {
      resolved = true;
      return session;
    });
    await tick();
    assert.equal(resolved, false, 'newSession should wait for the inflight warm slot');

    releaseWarm();
    const session = await pending;
    assert.equal(session.id, 'warm-sid');
    assert.equal(session.currentModeId, 'mode-warm');
    assert.equal(coldSessionNewCalls, 0, 'warm handoff should avoid cold session/new');
    assert.equal(replenishCalls, 1, 'consuming a warm slot should schedule replenish');
  });

  test('newSession cold-opens when inflight warm finishes without a slot', async () => {
    const runtime = new KiroRuntime(bridge, undefined, 0, '/tmp/default');
    const rt = runtime as any;

    rt.ensureClient = async () => ({});
    rt.warmNextSession = () => {};

    let coldSessionNewCalls = 0;
    rt.openSession = async () => {
      coldSessionNewCalls += 1;
      return { sid: 'cold-sid' };
    };
    rt.warmSessionLocks.set('/tmp/a', Promise.resolve());

    const session: AgentSession = await runtime.newSession({ cwd: '/tmp/a' });
    assert.equal(session.id, 'cold-sid');
    assert.equal(coldSessionNewCalls, 1);
  });
});
describe('KiroRuntime model catalog cache', () => {
  test('returns the disk snapshot immediately and replaces it after a live refresh', async () => {
    const cached: ModelInfo[] = [{ id: 'cached-kiro', label: 'Cached Kiro' }];
    let saved: ModelInfo[] | null = null;
    const cache: RuntimeModelCache = {
      load: () => cached,
      save: (_runtimeId, models) => { saved = models; },
    };
    const runtime = new KiroRuntime(bridge, undefined, 0, '/tmp/default', cache);
    const rt = runtime as any;

    let resolveLive!: (value: any[]) => void;
    let liveCalls = 0;
    rt.getAvailableModels = async () => {
      liveCalls += 1;
      return new Promise<any[]>((resolve) => { resolveLive = resolve; });
    };

    const first = await runtime.listModels();
    assert.deepEqual(first, cached, 'cached models should not wait for session/new');
    assert.equal(liveCalls, 1, 'returning the snapshot should still start one refresh');

    resolveLive([{ modelId: 'fresh-kiro', name: 'Fresh Kiro', description: 'updated' }]);
  const fresh = await runtime.refreshModels();

  assert.deepEqual(fresh.map((m) => m.id), ['fresh-kiro']);
  assert.deepEqual(saved, fresh);
  });
});
