import test, { afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AntigravityBinaryNotFoundError,
  findAntigravityBinary,
  resetAntigravityBinaryCacheForTest,
} from '../src/agents/antigravity/antigravityBinary';

const originalOverride = process.env.ANTIGRAVITY_CLI_BIN;

afterEach(() => {
  if (originalOverride === undefined) delete process.env.ANTIGRAVITY_CLI_BIN;
  else process.env.ANTIGRAVITY_CLI_BIN = originalOverride;
  resetAntigravityBinaryCacheForTest();
});

describe('findAntigravityBinary', () => {
  test('ANTIGRAVITY_CLI_BIN wins and is cached', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bin-'));
    const binary = path.join(dir, 'agy');
    fs.writeFileSync(binary, '#!/bin/sh\n', { mode: 0o755 });
    process.env.ANTIGRAVITY_CLI_BIN = binary;
    resetAntigravityBinaryCacheForTest();
    assert.equal(findAntigravityBinary(), binary);
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(findAntigravityBinary(), binary);
  });

  test('a dangling override is never returned', () => {
    process.env.ANTIGRAVITY_CLI_BIN = '/definitely/missing/agy';
    resetAntigravityBinaryCacheForTest();
    try {
      assert.notEqual(findAntigravityBinary(), process.env.ANTIGRAVITY_CLI_BIN);
    } catch (err) {
      assert.ok(err instanceof AntigravityBinaryNotFoundError);
    }
  });
});
