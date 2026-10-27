/**
 * Integration tests for claudeBinary.ts
 *
 * Uses node:test (Node 22+) + ts-node.
 * Run:
 *   cd runtime && node --require ts-node/register --test test/claudeBinary.test.ts
 */

import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as claudeBinary from '../src/adapters/claude/claudeBinary';

// ─── env save/restore helpers ────────────────────────────────────────────────

const AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'AWS_ACCESS_KEY_ID',
  'AWS_PROFILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GCP_PROJECT',
  'CLAUDE_CLI_BIN',
  'CLAUDE_CONFIG_DIR',
];

let savedEnv: Record<string, string | undefined> = {};

function saveEnv(): void {
  savedEnv = {};
  for (const k of AUTH_ENV_KEYS) {
    savedEnv[k] = process.env[k];
  }
}

function restoreEnv(): void {
  for (const k of AUTH_ENV_KEYS) {
    if (savedEnv[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = savedEnv[k];
    }
  }
}

function clearAuthEnv(): void {
  for (const k of AUTH_ENV_KEYS) {
    delete process.env[k];
  }
}

// ─── binary cache reset helper ────────────────────────────────────────────────

/** The module with findClaudeBinary's cached path cleared. */
function freshModule(): typeof claudeBinary {
  claudeBinary.resetClaudeBinaryCacheForTest();
  return claudeBinary;
}

// ─── suite ───────────────────────────────────────────────────────────────────

describe('claudeBinary', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-claude-bin-'));
    saveEnv();
    clearAuthEnv();
    mock.restoreAll(); // reset any stubs from previous test
  });

  afterEach(() => {
    restoreEnv();
    mock.restoreAll();
    // Clean up tmp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Case 2: throws ClaudeBinaryNotFoundError when nothing exists ─────────────

  test('findClaudeBinary throws ClaudeBinaryNotFoundError when CLAUDE_CLI_BIN points to nonexistent file and PATH has no claude', () => {
    process.env.CLAUDE_CLI_BIN = '/nonexistent/path/to/claude-does-not-exist-abc123';
    // Override PATH to an empty dir so PATH lookup cannot find a real claude
    const emptyBinDir = path.join(tmpDir, 'emptybin');
    fs.mkdirSync(emptyBinDir);
    const origPath = process.env.PATH;
    process.env.PATH = emptyBinDir;

    // Also mock fs.existsSync to return false for ALL paths so the standard-paths
    // fallback (including ~/.toolbox/bin/claude which exists on this machine) is blocked.
    const origExistsSync = fs.existsSync;
    (fs as typeof fs & { existsSync: typeof fs.existsSync }).existsSync = (_p: fs.PathLike) => false;

    try {
      const { findClaudeBinary, ClaudeBinaryNotFoundError } = freshModule();
      assert.throws(
        () => findClaudeBinary(process.env.CLAUDE_CLI_BIN),
        (err: unknown) => {
          assert.ok(err instanceof ClaudeBinaryNotFoundError, `expected ClaudeBinaryNotFoundError, got ${err}`);
          return true;
        },
      );
    } finally {
      process.env.PATH = origPath;
      fs.existsSync = origExistsSync;
    }
  });

  // ── The found path is cached until the reset export clears it ───────────────

  test('findClaudeBinary caches the found path until resetClaudeBinaryCacheForTest', () => {
    const first = path.join(tmpDir, 'claude-first');
    const second = path.join(tmpDir, 'claude-second');
    for (const bin of [first, second]) fs.writeFileSync(bin, '#!/bin/sh\necho ok', { mode: 0o755 });

    const { findClaudeBinary, resetClaudeBinaryCacheForTest } = freshModule();
    assert.equal(findClaudeBinary(first), first);
    assert.equal(findClaudeBinary(second), first);
    resetClaudeBinaryCacheForTest();
    assert.equal(findClaudeBinary(second), second);
  });

  // ── Case 5: preflightClaudeAuth throws for Bedrock without AWS creds ─────────

  test('preflightClaudeAuth throws ClaudeAuthMissingError for Bedrock without AWS creds', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_PROFILE;

    const { preflightClaudeAuth, ClaudeAuthMissingError } = freshModule();
    assert.throws(
      () => preflightClaudeAuth(undefined, process.env),
      (err: unknown) => {
        assert.ok(err instanceof ClaudeAuthMissingError, `expected ClaudeAuthMissingError, got ${err}`);
        return true;
      },
    );
  });

  // ── Case 6: preflightClaudeAuth accepts Bedrock with AWS_PROFILE ─────────────

  test('preflightClaudeAuth accepts Bedrock when AWS_PROFILE is set', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    process.env.AWS_PROFILE = 'my-profile';
    const { preflightClaudeAuth } = freshModule();
    assert.doesNotThrow(() => preflightClaudeAuth(undefined, process.env));
  });

  // ── Case 8: preflightClaudeAuth throws for Vertex without GCP creds ──────────

  test('preflightClaudeAuth throws ClaudeAuthMissingError for Vertex without GCP creds', () => {
    process.env.CLAUDE_CODE_USE_VERTEX = '1';
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.GCP_PROJECT;

    const { preflightClaudeAuth, ClaudeAuthMissingError } = freshModule();
    assert.throws(
      () => preflightClaudeAuth(undefined, process.env),
      (err: unknown) => {
        assert.ok(err instanceof ClaudeAuthMissingError, `expected ClaudeAuthMissingError, got ${err}`);
        return true;
      },
    );
  });

  // ── Case 11: buildClaudeArgv builds argv in the right order ──────────────────
  //
  // Uses the exported `buildClaudeArgv` helper directly — no spawn monkey-patching needed.

  test('buildClaudeArgv builds argv with required flags in correct relative order', () => {
    const { buildClaudeArgv } = freshModule();
    const argv = buildClaudeArgv({
      cwd: tmpDir,
      permissionMode: 'acceptEdits',
      mcpConfigInline: '{}',
      sessionId: 'test-session-uuid',
      resumeSessionId: 'resume-id-abc',
      forkSession: true,
      addDirs: ['/dir/A', '/dir/B'],
      settingsInline: '{"hooks":{}}',
      includeHookEvents: true,
    });

    // Required flags present
    const hasFlag = (f: string) => argv.includes(f);
    assert.ok(hasFlag('--input-format'), 'missing --input-format');
    assert.ok(hasFlag('stream-json'), 'missing stream-json value');
    assert.ok(hasFlag('--output-format'), 'missing --output-format');
    assert.ok(hasFlag('--verbose'), 'missing --verbose');
    assert.ok(hasFlag('--include-partial-messages'), 'missing --include-partial-messages');
    assert.ok(hasFlag('--include-hook-events'), 'missing --include-hook-events');
    assert.ok(hasFlag('--print'), 'missing --print');

    // --print appears exactly once (D1 fix)
    assert.equal(argv.filter(f => f === '--print').length, 1, '--print must appear exactly once');

    // --permission-mode acceptEdits
    const pmIdx = argv.indexOf('--permission-mode');
    assert.ok(pmIdx !== -1, 'missing --permission-mode');
    assert.equal(argv[pmIdx + 1], 'acceptEdits');

    // --session-id <uuid>
    const sidIdx = argv.indexOf('--session-id');
    assert.ok(sidIdx !== -1, 'missing --session-id');
    assert.equal(argv[sidIdx + 1], 'test-session-uuid');

    // --resume <id> before --fork-session
    const resumeIdx = argv.indexOf('--resume');
    const forkIdx = argv.indexOf('--fork-session');
    assert.ok(resumeIdx !== -1, 'missing --resume');
    assert.equal(argv[resumeIdx + 1], 'resume-id-abc');
    assert.ok(forkIdx !== -1, 'missing --fork-session');
    assert.ok(resumeIdx < forkIdx, '--resume must appear before --fork-session');

    // --add-dir for each directory
    const addDirIndices = argv.reduce<number[]>((acc, v, i) => {
      if (v === '--add-dir') acc.push(i);
      return acc;
    }, []);
    assert.equal(addDirIndices.length, 2, 'expected two --add-dir flags');
    assert.equal(argv[addDirIndices[0] + 1], '/dir/A');
    assert.equal(argv[addDirIndices[1] + 1], '/dir/B');

    const settingsIdx = argv.indexOf('--settings');
    assert.ok(settingsIdx !== -1, 'missing --settings');
    assert.equal(argv[settingsIdx + 1], '{"hooks":{}}');

    // D2: --mcp-config is the last flag (or followed only by its value at end of argv)
    const mcpIdx = argv.indexOf('--mcp-config');
    assert.ok(mcpIdx !== -1, 'missing --mcp-config');
    assert.equal(argv[mcpIdx + 1], '{}');
    assert.equal(mcpIdx + 2, argv.length, '--mcp-config value should be the last element');
    assert.ok(settingsIdx < mcpIdx, '--settings must appear before variadic --mcp-config');

    // --input-format before --output-format before --verbose before --print
    const ifIdx = argv.indexOf('--input-format');
    const ofIdx = argv.indexOf('--output-format');
    const verbIdx = argv.indexOf('--verbose');
    const printIdx = argv.indexOf('--print');
    assert.ok(ifIdx < ofIdx, '--input-format must come before --output-format');
    assert.ok(ofIdx < verbIdx, '--output-format must come before --verbose');
    assert.ok(verbIdx < printIdx, '--verbose must come before --print');
  });

  // ── Case 12: spawnClaude calls preflight before spawning ─────────────────────

  test('spawnClaude does not call spawn when preflightClaudeAuth throws', () => {
    const fakeBin = path.join(tmpDir, 'claude-preflight');
    fs.writeFileSync(fakeBin, '#!/bin/sh\necho ok', { mode: 0o755 });
    process.env.CLAUDE_CLI_BIN = fakeBin;

    // No auth env set → preflight will throw, but only if ALL OAuth candidates
    // are blocked (auth.json / settings.json / session-env / the dir itself).
    const origExistsSync = fs.existsSync;
    const claudeDir = path.join(os.homedir(), '.claude');
    const blocked = new Set<string>([
      claudeDir,
      path.join(claudeDir, 'auth.json'),
      path.join(claudeDir, 'settings.json'),
      path.join(claudeDir, 'session-env'),
    ]);
    (fs as typeof fs & { existsSync: typeof fs.existsSync }).existsSync = (p: fs.PathLike) => {
      if (typeof p === 'string' && blocked.has(p)) return false;
      // Allow the CLAUDE_CLI_BIN path check to succeed
      return origExistsSync(p);
    };

    claudeBinary.resetClaudeBinaryCacheForTest();
    const cp = require('node:child_process') as typeof import('node:child_process');
    const originalSpawn = cp.spawn;

    let spawnCalled = false;
    // Cast through unknown because cp.spawn has many overloads and we only
    // need a sentinel that records "was I called?" — type fidelity is not the goal.
    cp.spawn = ((..._args: unknown[]): unknown => {
      spawnCalled = true;
      return null;
    }) as unknown as typeof cp.spawn;

    try {
      const { spawnClaude, ClaudeAuthMissingError } = freshModule();
      assert.throws(
        () =>
          spawnClaude({
            cwd: tmpDir,
            permissionMode: 'acceptEdits',
            mcpConfigInline: '',
            spawnEnv: process.env,
            binaryPath: process.env.CLAUDE_CLI_BIN,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ClaudeAuthMissingError, `expected ClaudeAuthMissingError, got ${err}`);
          return true;
        },
      );
      assert.equal(spawnCalled, false, 'spawn must NOT be called when preflight throws');
    } finally {
      cp.spawn = originalSpawn;
      fs.existsSync = origExistsSync;
    }
  });

  // ── Config-dir override: preflight must check the SAME dir the child uses ────

  test('preflightClaudeAuth accepts OAuth creds in an explicit configDir', () => {
    const altDir = path.join(tmpDir, 'claude-alt');
    fs.mkdirSync(altDir);
    fs.writeFileSync(path.join(altDir, 'settings.json'), '{}');

    const { preflightClaudeAuth } = freshModule();
    assert.doesNotThrow(() => preflightClaudeAuth(altDir, process.env));
  });
});
