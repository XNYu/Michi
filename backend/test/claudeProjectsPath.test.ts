import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { getClaudeProjectsDir, getClaudeJsonlPath } from '../src/agents/claude/claudeProjectsPath';

// Save / restore HOME so tests don't pollute each other
let savedHome: string | undefined;

describe('claudeProjectsPath', () => {
  beforeEach(() => {
    savedHome = process.env.HOME;
  });

  afterEach(() => {
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
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
