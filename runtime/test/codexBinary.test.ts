/**
 * Tests for codexBinary.ts
 *
 * Uses node:test (Node 22+) + ts-node.
 * Run:
 *   cd runtime && node --require ts-node/register --test test/codexBinary.test.ts
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
} from '../src/adapters/codex/codexBinary';

// ─── env save/restore helpers ─────────────────────────────────────────────────

// The binary path and Codex home are arguments now (the host reads CODEX_CLI_BIN and
// CODEX_HOME); only the PATH lookup still reads the environment.
const ENV_KEYS = ['PATH'];

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

  test('findCodexBinary resolves the Codex CLI bundled with ChatGPT.app', () => {
    const emptyBinDir = path.join(tmpDir, 'emptybin');
    fs.mkdirSync(emptyBinDir);
    process.env.PATH = emptyBinDir;

    const chatGptCodex = '/Applications/ChatGPT.app/Contents/Resources/codex';
    const origExistsSync = fs.existsSync;
    (fs as typeof fs & { existsSync: typeof fs.existsSync }).existsSync = (candidate: fs.PathLike) =>
      candidate.toString() === chatGptCodex;

    try {
      assert.equal(findCodexBinary(), chatGptCodex);
    } finally {
      fs.existsSync = origExistsSync;
    }
  });

  // ── Case 2: missing binary throws CodexBinaryNotFoundError with tried paths ─

  test('findCodexBinary throws CodexBinaryNotFoundError when binary is not found', () => {
    // Point the binary override at a nonexistent path
    const binaryPath = '/nonexistent/path/to/codex-does-not-exist-abc123';

    // Empty PATH so PATH lookup cannot find a real codex
    const emptyBinDir = path.join(tmpDir, 'emptybin');
    fs.mkdirSync(emptyBinDir);
    process.env.PATH = emptyBinDir;

    // Block all fs.existsSync lookups so standard-path fallback is also blocked
    const origExistsSync = fs.existsSync;
    (fs as typeof fs & { existsSync: typeof fs.existsSync }).existsSync = (_p: fs.PathLike) => false;

    try {
      assert.throws(
        () => findCodexBinary(binaryPath),
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
    // Point the Codex home at our empty tmpDir (no auth.json inside)
    assert.throws(
      () => preflightCodexAuth(tmpDir),
      (err: unknown) => {
        assert.ok(err instanceof CodexAuthMissingError, `expected CodexAuthMissingError, got ${err}`);
        const msg = (err as CodexAuthMissingError).message;
        assert.ok(msg.includes('auth.json'), `error message should mention auth.json, got: ${msg}`);
        return true;
      },
    );
  });

  test('codexHome takes the host override as given and falls back to ~/.codex only when unset', () => {
    assert.equal(codexHome(), path.join(os.homedir(), '.codex'));
    assert.equal(codexHome(tmpDir), tmpDir);
    // As `process.env.CODEX_HOME ?? …` did: an empty value is kept.
    assert.equal(codexHome(''), '');
  });

  // ── Case 6: cache — second findCodexBinary call skips existsSync ─────────────

  test('findCodexBinary is cached — existsSync not called on second invocation', () => {
    const fakeBin = path.join(tmpDir, 'cached-codex');
    fs.writeFileSync(fakeBin, '#!/bin/sh\necho cached', { mode: 0o755 });

    let callCount = 0;
    const origExistsSync = fs.existsSync.bind(fs);
    const origMethod = fs.existsSync;
    (fs as typeof fs & { existsSync: typeof fs.existsSync }).existsSync = (p: fs.PathLike) => {
      callCount++;
      return origExistsSync(p);
    };

    try {
      findCodexBinary(fakeBin);
      const afterFirst = callCount;

      findCodexBinary(fakeBin); // should use cache
      assert.equal(callCount, afterFirst, 'existsSync should not be called again after cache is warm');
    } finally {
      fs.existsSync = origMethod;
    }
  });
});
