import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTitlePrompt,
  cleanGeneratedTitle,
  fallbackTitleFromUserText,
  titleModelConfig,
  withTitleTimeout,
} from '../src/services/titleGeneration';
import { KiroTitleGenerator, type KiroTitleClient } from '../src/agents/kiro/kiroTitleGenerator';
import { buildClaudeTitleArgv } from '../src/agents/claude/claudeTitleGenerator';

describe('titleGeneration helpers', () => {
  it('cleans the usual ways a model ignores "output only the title"', () => {
    assert.equal(cleanGeneratedTitle('[TITLE: Fixing flaky tests]'), 'Fixing flaky tests');
    assert.equal(cleanGeneratedTitle('```\nFixing flaky tests\n```'), 'Fixing flaky tests');
    assert.equal(cleanGeneratedTitle('### Fixing flaky tests.'), 'Fixing flaky tests');
    assert.equal(cleanGeneratedTitle('Title: "Fixing flaky tests"'), 'Fixing flaky tests');
    assert.equal(cleanGeneratedTitle('标题：用小模型生成标题的方案探讨。'), '用小模型生成标题的方案探讨');
    assert.equal(cleanGeneratedTitle('**Fixing flaky tests**'), 'Fixing flaky tests');
    assert.equal(cleanGeneratedTitle('Sure!\n\nFixing flaky tests\nSecond line'), 'Sure');
    assert.equal(cleanGeneratedTitle('   '), '');
  });

  it('caps very long titles', () => {
    const long = 'word '.repeat(60);
    assert.ok(Array.from(cleanGeneratedTitle(long)).length <= 80);
  });

  it('falls back to the first sentence of the user text', () => {
    assert.equal(fallbackTitleFromUserText('/btw How do I fix this? And also that.'), 'How do I fix this');
    assert.equal(fallbackTitleFromUserText('看看 https://example.com/x 这个链接。然后呢'), '看看 这个链接');
  });

  it('truncates the user message inside the prompt', () => {
    const prompt = buildTitlePrompt('x'.repeat(10_000));
    assert.ok(prompt.length < 5_000);
    assert.ok(prompt.includes('USER MESSAGE:'));
  });

  it('embeds quoted context so the title can name its subject', () => {
    const prompt = buildTitlePrompt('具体修复的原理是什么？', '持久修复序列化：不要先调用 writeValueAsBytes()；应让 Jackson 直接写入 GZIP');
    assert.ok(prompt.includes('CONTEXT'));
    assert.ok(prompt.includes('writeValueAsBytes'));
    assert.ok(prompt.includes('USER MESSAGE:\n具体修复的原理是什么？'));
  });

  it('omits the context block when no context is given', () => {
    const prompt = buildTitlePrompt('hello', '   ');
    assert.ok(!prompt.includes('CONTEXT'));
  });

  it('caps the embedded context length', () => {
    const prompt = buildTitlePrompt('q', 'y'.repeat(5_000));
    assert.ok(Array.from(prompt.match(/CONTEXT[\s\S]*?USER MESSAGE:/)?.[0] ?? '').length < 1_200);
  });

  it('reads per-runtime models from the environment with off switches', () => {
    const saved = { ...process.env };
    try {
      delete process.env.MICHI_TITLE_MODEL_KIRO;
      assert.equal(titleModelConfig('kiro').model, 'gpt-5.6-luna');
      assert.equal(titleModelConfig('claude').model, 'haiku');
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

  it('withTitleTimeout aborts and rejects on deadline', async () => {
    let aborted = false;
    await assert.rejects(
      withTitleTimeout((signal) => new Promise<string>((_, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
      }), 20, 'test'),
      /timed out after 20ms/,
    );
    assert.equal(aborted, true);
  });
});

describe('buildClaudeTitleArgv', () => {
  it('runs a stateless text-only print call on the resolved cheap model', () => {
    const argv = buildClaudeTitleArgv('haiku');
    assert.ok(argv.includes('--print'));
    assert.ok(argv.includes('--bare'));
    assert.ok(argv.includes('--no-session-persistence'));
    assert.equal(argv[argv.indexOf('--output-format') + 1], 'text');
    assert.equal(argv[argv.indexOf('--tools') + 1], '');
    assert.equal(argv[argv.indexOf('--model') + 1], 'claude-haiku-4-5');
    assert.ok(!argv.includes('--resume'));
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
  it('opens one cheap-model session, reuses it, and declines tool permissions', async () => {
    const { client, calls } = fakeClient({ replies: [['Fixing ', 'flaky tests'], ['Second title']] });
    const generator = new KiroTitleGenerator({ ensureClient: async () => client, model: 'gpt-5.6-luna', timeoutMs: 1_000 });

    assert.equal(await generator.generate('How do I fix flaky tests?'), 'Fixing flaky tests');
    assert.equal(await generator.generate('Another question'), 'Second title');

    assert.equal(calls.newSession, 1);
    assert.deepEqual(calls.setModel, ['gpt-5.6-luna']);
    assert.deepEqual(calls.cancelledPermissions, [7, 7]);
    assert.ok(calls.prompts[0].includes('USER MESSAGE:\nHow do I fix flaky tests?'));
  });

  it('passes quoted context into the title prompt', async () => {
    const { client, calls } = fakeClient({ replies: [['S3 序列化 GZIP 修复']] });
    const generator = new KiroTitleGenerator({ ensureClient: async () => client, model: 'm', timeoutMs: 1_000 });
    await generator.generate('具体修复的原理是什么？', undefined, '持久修复序列化：应让 Jackson 直接写入 GZIP');
    assert.ok(calls.prompts[0].includes('CONTEXT'));
    assert.ok(calls.prompts[0].includes('Jackson'));
    assert.ok(calls.prompts[0].includes('USER MESSAGE:\n具体修复的原理是什么？'));
  });

  it('keeps working on the session default model when set_model is rejected', async () => {
    const { client, calls } = fakeClient({ setModelError: new Error('unknown model') });
    const generator = new KiroTitleGenerator({ ensureClient: async () => client, model: 'nope', timeoutMs: 1_000 });
    assert.equal(await generator.generate('hello'), 'Generated title');
    assert.equal(calls.newSession, 1);
  });

  it('recreates the session after the process died or the session was purged', async () => {
    const { client, calls } = fakeClient();
    const generator = new KiroTitleGenerator({ ensureClient: async () => client, model: 'm', timeoutMs: 1_000 });
    await generator.generate('one');
    client.destroySession('title-1');
    await generator.generate('two');
    assert.equal(calls.newSession, 2);
  });

  it('rotates the session after maxTurnsPerSession prompts', async () => {
    const { client, calls } = fakeClient();
    const generator = new KiroTitleGenerator({ ensureClient: async () => client, model: 'm', timeoutMs: 1_000, maxTurnsPerSession: 2 });
    await generator.generate('one');
    await generator.generate('two');
    assert.deepEqual(calls.destroyed, ['title-1']);
    await generator.generate('three');
    assert.equal(calls.newSession, 2);
  });

  it('times out a hung prompt, cancels the native session and drops the handle', async () => {
    const { client, calls } = fakeClient({ hang: true });
    const generator = new KiroTitleGenerator({ ensureClient: async () => client, model: 'm', timeoutMs: 30 });
    await assert.rejects(generator.generate('slow'), /timed out/);
    assert.equal(calls.cancelled, 1);
    assert.deepEqual(calls.destroyed, ['title-1']);
  });

  it('returns null for an empty model reply', async () => {
    const { client } = fakeClient({ replies: [['   ']] });
    const generator = new KiroTitleGenerator({ ensureClient: async () => client, model: 'm', timeoutMs: 1_000 });
    assert.equal(await generator.generate('blank'), null);
  });
});
