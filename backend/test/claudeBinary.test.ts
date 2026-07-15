/**
 * Integration tests for claudeBinary.ts
 *
 * Uses node:test (Node 22+) + ts-node.
 * Run:
 *   cd backend && npm test -- --test-name-pattern claudeBinary
 */

import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

// ─── module cache reset helper ────────────────────────────────────────────────

function bustClaudeBinaryCache(): void {
  const target = require.resolve('../src/agents/claude/claudeBinary');
  delete require.cache[target];
}

function freshFindClaudeBinary(): typeof import('../src/agents/claude/claudeBinary')['findClaudeBinary'] {
  bustClaudeBinaryCache();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../src/agents/claude/claudeBinary').findClaudeBinary;
}

function freshModule(): typeof import('../src/agents/claude/claudeBinary') {
  bustClaudeBinaryCache();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../src/agents/claude/claudeBinary');
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

  // ── Case 1: CLAUDE_CLI_BIN env var resolves when file exists ────────────────

  test('findClaudeBinary resolves via CLAUDE_CLI_BIN when set and file exists', () => {
    const fakeBin = path.join(tmpDir, 'fake-claude');
    fs.writeFileSync(fakeBin, '#!/bin/sh\necho fake', { mode: 0o755 });

    process.env.CLAUDE_CLI_BIN = fakeBin;
    const findClaudeBinary = freshFindClaudeBinary();
    const result = findClaudeBinary();
    assert.equal(result, fakeBin);
  });

  // ── Case 2: throws ClaudeBinaryNotFoundError when nothing exists ─────────────

  test('findClaudeBinary throws ClaudeBinaryNotFoundError when CLAUDE_CLI_BIN points to nonexistent file and PATH has no claude', () => {
    process.env.CLAUDE_CLI_BIN = '/nonexistent/path/to/claude-does-not-exist-abc123';
    // Override PATH to an empty dir so `which claude` / `execSync('which claude')` fails
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
        () => findClaudeBinary(),
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

  // ── Case 3: findClaudeBinary is cached (fs.existsSync called only once) ──────

  test('findClaudeBinary is cached — fs.existsSync not called on second invocation', () => {
    const fakeBin = path.join(tmpDir, 'cached-claude');
    fs.writeFileSync(fakeBin, '#!/bin/sh\necho cached', { mode: 0o755 });
    process.env.CLAUDE_CLI_BIN = fakeBin;

    bustClaudeBinaryCache();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../src/agents/claude/claudeBinary');

    let existsSyncCallCount = 0;
    const origExistsSync = fs.existsSync.bind(fs);
    const origMethod = fs.existsSync;
    (fs as typeof fs & { existsSync: typeof fs.existsSync }).existsSync = (p: fs.PathLike) => {
      existsSyncCallCount++;
      return origExistsSync(p);
    };

    try {
      mod.findClaudeBinary();
      const countAfterFirst = existsSyncCallCount;

      // Second call — must use cache, existsSync should not be called again
      mod.findClaudeBinary();
      const countAfterSecond = existsSyncCallCount;

      assert.equal(countAfterFirst, countAfterSecond, 'existsSync should not be called on second invocation (cached)');
    } finally {
      fs.existsSync = origMethod;
    }
  });

  // ── Case 4: preflightClaudeAuth returns silently with ANTHROPIC_API_KEY ──────

  test('preflightClaudeAuth returns silently when ANTHROPIC_API_KEY is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key-123';
    const { preflightClaudeAuth } = freshModule();
    assert.doesNotThrow(() => preflightClaudeAuth());
  });

  // ── Case 5: preflightClaudeAuth throws for Bedrock without AWS creds ─────────

  test('preflightClaudeAuth throws ClaudeAuthMissingError for Bedrock without AWS creds', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_PROFILE;

    const { preflightClaudeAuth, ClaudeAuthMissingError } = freshModule();
    assert.throws(
      () => preflightClaudeAuth(),
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
    assert.doesNotThrow(() => preflightClaudeAuth());
  });

  // ── Case 7: preflightClaudeAuth accepts Bedrock with AWS_ACCESS_KEY_ID ───────

  test('preflightClaudeAuth accepts Bedrock when AWS_ACCESS_KEY_ID is set', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
    const { preflightClaudeAuth } = freshModule();
    assert.doesNotThrow(() => preflightClaudeAuth());
  });

  // ── Case 8: preflightClaudeAuth throws for Vertex without GCP creds ──────────

  test('preflightClaudeAuth throws ClaudeAuthMissingError for Vertex without GCP creds', () => {
    process.env.CLAUDE_CODE_USE_VERTEX = '1';
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.GCP_PROJECT;

    const { preflightClaudeAuth, ClaudeAuthMissingError } = freshModule();
    assert.throws(
      () => preflightClaudeAuth(),
      (err: unknown) => {
        assert.ok(err instanceof ClaudeAuthMissingError, `expected ClaudeAuthMissingError, got ${err}`);
        return true;
      },
    );
  });

  // ── Case 9: throws when no auth path matches AND auth.json is absent ──────────

  test('preflightClaudeAuth throws ClaudeAuthMissingError when no auth env set and auth.json is absent', () => {
    // All auth env keys already cleared in beforeEach.
    // Mock fs.existsSync to return false for the entire ~/.claude/ dir AND
    // every candidate file the preflight checks (auth.json / settings.json /
    // session-env) so the lenient OAuth-fallback branch is fully blocked.
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
      return origExistsSync(p);
    };

    try {
      const { preflightClaudeAuth, ClaudeAuthMissingError } = freshModule();
      assert.throws(
        () => preflightClaudeAuth(),
        (err: unknown) => {
          assert.ok(err instanceof ClaudeAuthMissingError, `expected ClaudeAuthMissingError, got ${err}`);
          return true;
        },
      );
    } finally {
      fs.existsSync = origExistsSync;
    }
  });

  // ── Case 10: preflightClaudeAuth accepts OAuth when auth.json exists ──────────

  test('preflightClaudeAuth accepts OAuth when ~/.claude/auth.json exists', () => {
    // All auth env keys already cleared in beforeEach.
    const origExistsSync = fs.existsSync;
    const authFile = path.join(os.homedir(), '.claude', 'auth.json');
    (fs as typeof fs & { existsSync: typeof fs.existsSync }).existsSync = (p: fs.PathLike) => {
      if (p === authFile) return true;
      return origExistsSync(p);
    };

    try {
      const { preflightClaudeAuth } = freshModule();
      assert.doesNotThrow(() => preflightClaudeAuth());
    } finally {
      fs.existsSync = origExistsSync;
    }
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

    bustClaudeBinaryCache();
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
});
