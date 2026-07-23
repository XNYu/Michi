import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { getClaudeProjectsDir, getClaudeJsonlPath } from '../src/agents/claude/claudeProjectsPath';
import { updateAgentConfig } from '../src/services/agentConfig';

// claudeConfigBase() resolves an explicit config dir before falling back to
// os.homedir(): resolveClaudeConfigDir() (the agentConfig singleton) then
// $CLAUDE_CONFIG_DIR. These tests exercise the ~/.claude default branch, so we
// must neutralize BOTH override sources — otherwise a leaked agentConfig
// claudeConfigDir (set by agentConfig.test.ts) or an inherited
// $CLAUDE_CONFIG_DIR makes the result independent of HOME and the asserts fail
// only under the full suite (test-isolation, not a source bug).
let savedHome: string | undefined;
let savedConfigDirEnv: string | undefined;
// updateAgentConfig() persists via fs.writeFileSync — stub it so resetting the
// singleton here never churns the real ~/.michi/config.json.
let origWriteFileSync: typeof import('node:fs').writeFileSync;

describe('claudeProjectsPath', () => {
  beforeEach(() => {
    const fsCjs = require('fs');
    origWriteFileSync = fsCjs.writeFileSync;
    fsCjs.writeFileSync = () => { /* noop */ };
    savedHome = process.env.HOME;
    savedConfigDirEnv = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    updateAgentConfig({ claudeConfigDir: undefined });
  });

  afterEach(() => {
    updateAgentConfig({ claudeConfigDir: undefined });
    require('fs').writeFileSync = origWriteFileSync;
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    if (savedConfigDirEnv === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = savedConfigDirEnv;
    }
  });

  // ── Case 1: getClaudeProjectsDir converts cwd slashes to dashes ──────────

  test('getClaudeProjectsDir returns <HOME>/.claude/projects/-Users-foo-bar for /Users/foo/bar', () => {
    const result = getClaudeProjectsDir('/Users/foo/bar');
    const expected = path.join(os.homedir(), '.claude', 'projects', '-Users-foo-bar');
    assert.equal(result, expected);
  });

  // ── Case 2: getClaudeJsonlPath appends sessionId.jsonl ───────────────────

  test('getClaudeJsonlPath returns <HOME>/.claude/projects/-x-y/sid-1.jsonl', () => {
    const result = getClaudeJsonlPath('/x/y', 'sid-1');
    const expected = path.join(os.homedir(), '.claude', 'projects', '-x-y', 'sid-1.jsonl');
    assert.equal(result, expected);
  });

  // ── Case 3: trailing slash behavior ──────────────────────────────────────
  //
  // Implementation: replace(/\//g, '-') on the raw cwd string.
  // '/Users/foo/bar/' → '-Users-foo-bar-'  (trailing dash)
  // This is the actual behavior — document it as a known quirk.

  test('getClaudeProjectsDir produces trailing dash when cwd has trailing slash', () => {
    const result = getClaudeProjectsDir('/Users/foo/bar/');
    // The implementation replaces every '/' with '-', including the trailing one.
    // Expected: '-Users-foo-bar-' (trailing dash)
    const expected = path.join(os.homedir(), '.claude', 'projects', '-Users-foo-bar-');
    assert.equal(
      result,
      expected,
      'trailing slash becomes trailing dash — callers should strip trailing slashes before calling',
    );
  });

  // ── Case 4: $HOME env var change is reflected ─────────────────────────────
  //
  // os.homedir() reads from HOME env var on POSIX.
  // This confirms the function is not caching homedir at module load time.

  test('getClaudeProjectsDir uses current HOME env var (no module-load-time caching)', () => {
    const fakeHome = '/tmp/fake-home-for-test';
    process.env.HOME = fakeHome;

    // os.homedir() on macOS/Linux reads from process.env.HOME
    const currentHome = os.homedir();
    const result = getClaudeProjectsDir('/a/b');
    const expected = path.join(currentHome, '.claude', 'projects', '-a-b');
    assert.equal(result, expected, 'result must use the current HOME value at call time');
  });
});
