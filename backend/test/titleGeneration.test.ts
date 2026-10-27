import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTitlePrompt, titleModelConfig } from '../src/services/titleGeneration';
import { KiroTitleGenerator, type KiroTitleClient } from 'michi-runtime/internal/adapters/kiro/kiroTitleGenerator';

describe('titleGeneration helpers', () => {
  it('caps the embedded context length', () => {
    const prompt = buildTitlePrompt('q', 'y'.repeat(5_000));
    assert.ok(Array.from(prompt.match(/CONTEXT[\s\S]*?USER MESSAGE:/)?.[0] ?? '').length < 1_200);
  });

  it('reads per-runtime models from the environment with off switches', () => {
    const saved = { ...process.env };
    try {
      delete process.env.MICHI_TITLE_MODEL_KIRO;
      assert.equal(titleModelConfig('kiro').model, 'gpt-5.6-luna');
      assert.equal(titleModelConfig('codex').model, 'gpt-5.6-luna');
      process.env.MICHI_TITLE_MODEL_KIRO = 'off';
      assert.equal(titleModelConfig('kiro').model, null);
      process.env.MICHI_TITLE_MODEL_KIRO = 'claude-haiku-4.5';
      assert.equal(titleModelConfig('kiro').model, 'claude-haiku-4.5');
      process.env.MICHI_TITLE_TIMEOUT_MS = '250';
      assert.equal(titleModelConfig('kiro').timeoutMs, 250);
    } finally {
      process.env = saved;
    }
  });
});

interface FakeClientOptions {
  /** Chunks yielded for each prompt call, in order. */
  replies?: string[][];
  setModelError?: Error;
  hang?: boolean;
}

function fakeClient(opts: FakeClientOptions = {}) {
  const calls = { newSession: 0, setModel: [] as string[], prompts: [] as string[], cancelled: 0, destroyed: [] as string[], cancelledPermissions: [] as number[] };
  let sessions = 0;
  const live = new Set<string>();
  let alive = true;
  const client: KiroTitleClient & { kill(): void } = {
    isAlive: () => alive,
    hasSession: (sid) => live.has(sid),
    async newSession() {
      calls.newSession += 1;
      const sid = `title-${++sessions}`;
      live.add(sid);
      return { sessionId: sid };
    },
    async setModel(_sid, model) {
      calls.setModel.push(model);
      if (opts.setModelError) throw opts.setModelError;
    },
    prompt(_sid, text, _blocks, signal) {
      calls.prompts.push(text);
      const reply = opts.replies?.[calls.prompts.length - 1] ?? ['Generated title'];
      return (async function* () {
        if (opts.hang) {
          await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
          yield { sessionUpdate: 'turn_end', stopReason: 'cancelled' };
          return;
        }
        yield { sessionUpdate: 'permission_request', requestId: 7, toolCall: {}, options: [] };
        for (const chunk of reply) {
          yield { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } };
        }
        yield { sessionUpdate: 'turn_end', stopReason: 'end_turn' };
      })();
    },
    async cancel() { calls.cancelled += 1; return true; },
    cancelPermission(requestId) { calls.cancelledPermissions.push(requestId); },
    destroySession(sid) { calls.destroyed.push(sid); live.delete(sid); },
    kill() { alive = false; },
  };
  return { client, calls };
}

describe('KiroTitleGenerator', () => {
  it('rotates the session after maxTurnsPerSession prompts', async () => {
    const { client, calls } = fakeClient();
    const generator = new KiroTitleGenerator({ ensureClient: async () => client, prompt: buildTitlePrompt, model: 'm', timeoutMs: 1_000, maxTurnsPerSession: 2 });
    await generator.generate('one');
    await generator.generate('two');
    assert.deepEqual(calls.destroyed, ['title-1']);
    await generator.generate('three');
    assert.equal(calls.newSession, 2);
  });

  it('times out a hung prompt, cancels the native session and drops the handle', async () => {
    const { client, calls } = fakeClient({ hang: true });
    const generator = new KiroTitleGenerator({ ensureClient: async () => client, prompt: buildTitlePrompt, model: 'm', timeoutMs: 30 });
    await assert.rejects(generator.generate('slow'), /timed out/);
    assert.equal(calls.cancelled, 1);
    assert.deepEqual(calls.destroyed, ['title-1']);
  });
});
