import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseClaudeInitializeModels,
  probeClaudeModels,
} from 'michi-runtime/internal/adapters/claude/claudeModelProbe';
import { claudeTestOptions } from './helpers/claudeTestOptions';

// Synthetic initialize payload: fictional model names exercise CLI catalog parsing.
const INITIALIZE_RESPONSE = {
  commands: [{ name: 'sample-command', description: 'Example command' }],
  models: [
    {
      value: 'default', resolvedModel: 'sample-large-v1[1m]', displayName: 'Default',
      description: 'Use the default model (currently Sample Large (1M context))',
      supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      value: 'reasoner', resolvedModel: 'sample-reasoner-v1', displayName: 'Sample Reasoner',
      description: 'Sample Reasoner · Example model', supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      value: 'sample-fast-v1', resolvedModel: 'sample-fast-v1', displayName: 'Sample Fast',
      description: 'Sample Fast · Lightweight example', supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'max'],
    },
    {
      value: 'provider.sample-large-v1[1m]', resolvedModel: 'provider.sample-large-v1[1m]',
      displayName: 'Sample Large (1M context)', description: 'Sample Large · Example provider', supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
  ],
  account: { apiProvider: 'example-provider' },
};

describe('parseClaudeInitializeModels', () => {
  test('falls back to value when resolvedModel is missing and drops invalid entries', () => {
    const models = parseClaudeInitializeModels({
      models: [
        { value: 'sample-small-v1' },
        { value: 'bad id; rm -rf /' },
        { displayName: 'no id at all' },
        null,
        'not an object',
      ],
    });
    assert.equal(models.length, 1);
    assert.equal(models[0].id, 'sample-small-v1');
    assert.equal(models[0].label, 'sample-small-v1');
    assert.equal(models[0].supportsReasoning, false);
    assert.deepEqual(models[0].supportedReasoningLevels, []);
  });

  test('deduplicates by id and keeps the default flag', () => {
    const models = parseClaudeInitializeModels({
      models: [
        { value: 'sample-large-v1', resolvedModel: 'sample-large-v1', displayName: 'Sample Large' },
        { value: 'default', resolvedModel: 'sample-large-v1', displayName: 'Default' },
      ],
    });
    assert.equal(models.length, 1);
    assert.equal(models[0].label, 'Sample Large');
    assert.equal(models[0].isDefault, true);
  });

  test('returns [] for malformed responses', () => {
    assert.deepEqual(parseClaudeInitializeModels(null), []);
    assert.deepEqual(parseClaudeInitializeModels({}), []);
    assert.deepEqual(parseClaudeInitializeModels({ models: 'nope' }), []);
  });
});

describe('SDK model discovery', () => {
  const savedEnv = { bin: process.env.CLAUDE_CLI_BIN, key: process.env.ANTHROPIC_API_KEY };
  before(() => {
    process.env.CLAUDE_CLI_BIN = process.execPath;
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });
  after(() => {
    if (savedEnv.bin === undefined) delete process.env.CLAUDE_CLI_BIN; else process.env.CLAUDE_CLI_BIN = savedEnv.bin;
    if (savedEnv.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedEnv.key;
  });
  test('uses no-persistence bare SDK initialization and always closes', async () => {
    let closed = false;
    const models = await probeClaudeModels(claudeTestOptions(), { cwd: '/tmp/probe', sdk: { query: ((args: any) => {
      assert.equal(args.options.cwd, '/tmp/probe');
      assert.equal(args.options.persistSession, false);
      assert.deepEqual(args.options.extraArgs, { bare: null });
      return { initializationResult: async () => INITIALIZE_RESPONSE, close: () => { closed = true; } };
    }) as any } });
    assert.equal(models.length, 4); assert.ok(closed);
  });
  test('propagates SDK failure and closes', async () => {
    let closed = false;
    await assert.rejects(probeClaudeModels(claudeTestOptions(), { sdk: { query: (() => ({ initializationResult: async () => { throw new Error('auth expired'); }, close: () => { closed = true; } })) as any } }), /auth expired/);
    assert.ok(closed);
  });
  test('bounds initialization and closes on timeout', async () => {
    let closed = false;
    await assert.rejects(probeClaudeModels(claudeTestOptions(), { timeoutMs: 20, sdk: { query: (() => ({ initializationResult: () => new Promise(() => {}), close: () => { closed = true; } })) as any } }), /timed out after 20ms/);
    assert.ok(closed);
  });
});
