import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  CLAUDE_MODEL_PROBE_ARGV,
  parseClaudeInitializeModels,
  probeClaudeModels,
} from '../src/agents/claude/claudeModelProbe';

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
  test('maps CLI entries onto concrete ids with reasoning levels', () => {
    const models = parseClaudeInitializeModels(INITIALIZE_RESPONSE);
    assert.deepEqual(models.map((m) => m.id), [
      'sample-large-v1[1m]',
      'sample-reasoner-v1',
      'sample-fast-v1',
      'provider.sample-large-v1[1m]',
    ]);
    const [def, reasoner, fast] = models;
    assert.equal(def.isDefault, true);
    assert.equal(def.label, 'Default');
    assert.equal(reasoner.isDefault, undefined);
    assert.equal(reasoner.label, 'Sample Reasoner');
    assert.equal(reasoner.description, 'Sample Reasoner · Example model');
    assert.equal(reasoner.supportsReasoning, true);
    assert.deepEqual(fast.supportedReasoningLevels, ['low', 'medium', 'high', 'max']);
    assert.equal(fast.defaultReasoning, 'high');
  });

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

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = undefined;
  exitCode = null;
  signalCode = null;
  received = '';
  constructor() {
    super();
    this.stdin.on('data', (chunk) => { this.received += chunk.toString(); });
  }
}

describe('probeClaudeModels', () => {
  const savedEnv = { bin: process.env.CLAUDE_CLI_BIN, key: process.env.ANTHROPIC_API_KEY };
  before(() => {
    process.env.CLAUDE_CLI_BIN = process.execPath;
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });
  after(() => {
    if (savedEnv.bin === undefined) delete process.env.CLAUDE_CLI_BIN; else process.env.CLAUDE_CLI_BIN = savedEnv.bin;
    if (savedEnv.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedEnv.key;
  });

  function spawnWith(child: FakeChild, seen: { argv?: string[]; cwd?: string } = {}) {
    return (_binary: string, argv: string[], cwd: string) => {
      seen.argv = argv;
      seen.cwd = cwd;
      return child as unknown as ChildProcessWithoutNullStreams;
    };
  }

  test('sends initialize and parses the matching control_response', async () => {
    const child = new FakeChild();
    const seen: { argv?: string[]; cwd?: string } = {};
    const promise = probeClaudeModels({ spawn: spawnWith(child, seen), cwd: '/tmp/probe' });

    await new Promise((r) => setImmediate(r));
    const request = JSON.parse(child.received.trim());
    assert.equal(request.type, 'control_request');
    assert.equal(request.request.subtype, 'initialize');
    assert.deepEqual(seen.argv, [...CLAUDE_MODEL_PROBE_ARGV]);
    assert.equal(seen.cwd, '/tmp/probe');

    // Unrelated output and a response for another request id are ignored;
    // the real response arrives split across chunks.
    child.stdout.write('not json\n');
    child.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'other', response: { models: [] } } })}\n`);
    const line = JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: request.request_id, response: INITIALIZE_RESPONSE },
    });
    child.stdout.write(line.slice(0, 50));
    child.stdout.write(`${line.slice(50)}\n`);

    const models = await promise;
    assert.equal(models.length, 4);
    assert.equal(models[1].id, 'sample-reasoner-v1');
  });

  test('rejects on an error control_response', async () => {
    const child = new FakeChild();
    const promise = probeClaudeModels({ spawn: spawnWith(child) , cwd: '/tmp/probe' });
    await new Promise((r) => setImmediate(r));
    const request = JSON.parse(child.received.trim());
    child.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: request.request_id, error: 'nope' } })}\n`);
    await assert.rejects(promise, /initialize failed: nope/);
  });

  test('rejects when the CLI exits before answering', async () => {
    const child = new FakeChild();
    const promise = probeClaudeModels({ spawn: spawnWith(child), cwd: '/tmp/probe' });
    child.stderr.write('auth expired\n');
    await new Promise((r) => setImmediate(r));
    child.emit('close', 1);
    await assert.rejects(promise, /exited \(code 1\).*auth expired/);
  });

  test('rejects on timeout', async () => {
    const child = new FakeChild();
    await assert.rejects(
      probeClaudeModels({ spawn: spawnWith(child), cwd: '/tmp/probe', timeoutMs: 20 }),
      /timed out after 20ms/,
    );
  });
});
