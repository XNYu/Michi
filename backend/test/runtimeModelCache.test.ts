import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileRuntimeModelCache } from '../src/agents/runtimeModelCache';

test('FileRuntimeModelCache round-trips a model catalog', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-model-cache-'));
  try {
    const cache = new FileRuntimeModelCache(dataDir);
    cache.save('codex', [
      { id: 'gpt-test', label: 'GPT Test', description: 'cached', isDefault: true },
    ]);

    assert.deepEqual(cache.load('codex'), [
      { id: 'gpt-test', label: 'GPT Test', description: 'cached', isDefault: true },
    ]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
test('FileRuntimeModelCache ignores malformed snapshots', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-model-cache-'));
  try {
    const cacheDir = path.join(dataDir, 'runtime-models');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'kiro.json'), '{not-json');

    assert.equal(new FileRuntimeModelCache(dataDir).load('kiro'), null);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('FileRuntimeModelCache does not replace a good snapshot with an empty catalog', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-model-cache-'));
  try {
    const cache = new FileRuntimeModelCache(dataDir);
    cache.save('codex', [{ id: 'keep-me' }]);
    cache.save('codex', []);

    assert.deepEqual(cache.load('codex')?.map((model) => model.id), ['keep-me']);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
