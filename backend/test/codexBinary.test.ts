/**
 * Tests for codexBinary.ts
 *
 * Uses node:test (Node 22+) + ts-node.
 * Run:
 *   cd backend && npm run test:raw -- test/codexBinary.test.ts
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  findCodexBinary,
  preflightCodexAuth,
  resetCodexBinaryCacheForTest,
  CodexBinaryNotFoundError,
  CodexAuthMissingError,
  codexHome,
} from '../src/agents/codex/codexBinary';

// ─── env save/restore helpers ─────────────────────────────────────────────────

const ENV_KEYS = ['CODEX_CLI_BIN', 'CODEX_HOME', 'PATH'];

let savedEnv: Record<string, string | undefined> = {};

function saveEnv(): void {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
  }
}

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = savedEnv[k];
    }
  }
}

// ─── suite ────────────────────────────────────────────────────────────────────

describe('codexBinary', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-codex-bin-'));
    saveEnv();
    resetCodexBinaryCacheForTest();
  });

  afterEach(() => {
    restoreEnv();
    resetCodexBinaryCacheForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Case 1: CODEX_CLI_BIN env override wins when file exists ──────────────

  test('findCodexBinary resolves via CODEX_CLI_BIN when set and file exists', () => {
    const fakeBin = path.join(tmpDir, 'fake-codex');
    fs.writeFileSync(fakeBin, '#!/bin/sh\necho fake', { mode: 0o755 });

    process.env.CODEX_CLI_BIN = fakeBin;

    const result = findCodexBinary();
    assert.equal(result, fakeBin);
  });

  // ── Case 2: missing binary throws CodexBinaryNotFoundError with tried paths ─

  test('findCodexBinary throws CodexBinaryNotFoundError when binary is not found', () => {
    // Point CODEX_CLI_BIN at a nonexistent path
    process.env.CODEX_CLI_BIN = '/nonexistent/path/to/codex-does-not-exist-abc123';

    // Empty PATH so `which codex` fails
    const emptyBinDir = path.join(tmpDir, 'emptybin');
    fs.mkdirSync(emptyBinDir);
    process.env.PATH = emptyBinDir;

    // Block all fs.existsSync lookups so standard-path fallback is also blocked
    const origExistsSync = fs.existsSync;
    (fs as typeof fs & { existsSync: typeof fs.existsSync }).existsSync = (_p: fs.PathLike) => false;

    try {
      assert.throws(
        () => findCodexBinary(),
        (err: unknown) => {
          assert.ok(err instanceof CodexBinaryNotFoundError, `expected CodexBinaryNotFoundError, got ${err}`);
          const msg = (err as CodexBinaryNotFoundError).message;
          // Error message should list the nonexistent path we tried
          assert.ok(
            msg.includes('/nonexistent/path/to/codex-does-not-exist-abc123'),
            `error message should mention the tried path, got: ${msg}`,
          );
          return true;
        },
      );
    } finally {
      fs.existsSync = origExistsSync;
    }
  });

  // ── Case 3: preflightCodexAuth throws when CODEX_HOME has no auth.json ──────

  test('preflightCodexAuth throws CodexAuthMissingError when auth.json is absent', () => {
    // Point CODEX_HOME at our empty tmpDir (no auth.json inside)
    process.env.CODEX_HOME = tmpDir;

    assert.throws(
      () => preflightCodexAuth(),
      (err: unknown) => {
        assert.ok(err instanceof CodexAuthMissingError, `expected CodexAuthMissingError, got ${err}`);
        const msg = (err as CodexAuthMissingError).message;
        assert.ok(msg.includes('auth.json'), `error message should mention auth.json, got: ${msg}`);
        return true;
      },
    );
  });

  // ── Case 4: preflightCodexAuth passes when auth.json exists ──────────────────

  test('preflightCodexAuth does not throw when auth.json exists in CODEX_HOME', () => {
    // Create a real auth.json in our tmpDir
    const authFile = path.join(tmpDir, 'auth.json');
    fs.writeFileSync(authFile, JSON.stringify({ token: 'test-token' }));

    process.env.CODEX_HOME = tmpDir;

    assert.doesNotThrow(() => preflightCodexAuth());
  });

  // ── Case 5: codexHome respects CODEX_HOME env var ────────────────────────────

  test('codexHome returns CODEX_HOME env when set', () => {
    process.env.CODEX_HOME = '/custom/codex/home';
    assert.equal(codexHome(), '/custom/codex/home');
  });

  test('codexHome returns ~/.codex when CODEX_HOME is not set', () => {
    delete process.env.CODEX_HOME;
    assert.equal(codexHome(), path.join(os.homedir(), '.codex'));
  });

  // ── Case 6: cache — second findCodexBinary call skips existsSync ─────────────

  test('findCodexBinary is cached — existsSync not called on second invocation', () => {
    const fakeBin = path.join(tmpDir, 'cached-codex');
    fs.writeFileSync(fakeBin, '#!/bin/sh\necho cached', { mode: 0o755 });
    process.env.CODEX_CLI_BIN = fakeBin;

    let callCount = 0;
    const origExistsSync = fs.existsSync.bind(fs);
    const origMethod = fs.existsSync;
    (fs as typeof fs & { existsSync: typeof fs.existsSync }).existsSync = (p: fs.PathLike) => {
      callCount++;
      return origExistsSync(p);
    };

    try {
      findCodexBinary();
      const afterFirst = callCount;

      findCodexBinary(); // should use cache
      assert.equal(callCount, afterFirst, 'existsSync should not be called again after cache is warm');
    } finally {
      fs.existsSync = origMethod;
    }
  });
});
