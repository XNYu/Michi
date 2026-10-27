import './isolatedConfigDir';
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { claudeProjectSlug, claudeTranscriptFindable, getClaudeProjectsDir, getClaudeJsonlPath } from 'michi-runtime/internal/adapters/claude/claudeProjectsPath';
import { updateAgentConfig } from '../src/services/agentConfig';
import { claudeTestOptions } from './helpers/claudeTestOptions';

/** The adapter options the paths depend on: Michi's, over a test host. */
const claude = claudeTestOptions();

// claudeConfigBase() resolves an explicit config dir before falling back to
// os.homedir(): resolveClaudeConfigDir() (the agentConfig singleton) then
// $CLAUDE_CONFIG_DIR. These tests exercise the ~/.claude default branch, so we
// must neutralize BOTH override sources — otherwise a leaked agentConfig
// claudeConfigDir (set by agentConfig.test.ts) or an inherited
// $CLAUDE_CONFIG_DIR makes the result independent of HOME and the asserts fail
// only under the full suite (test-isolation, not a source bug).
let savedHome: string | undefined;
let savedConfigDirEnv: string | undefined;

describe('claudeProjectsPath', () => {
  beforeEach(() => {
    savedHome = process.env.HOME;
    savedConfigDirEnv = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    updateAgentConfig({ claudeConfigDir: undefined });
  });

  afterEach(() => {
    updateAgentConfig({ claudeConfigDir: undefined });
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
    const result = getClaudeProjectsDir(claude, '/Users/foo/bar');
    const expected = path.join(os.homedir(), '.claude', 'projects', '-Users-foo-bar');
    assert.equal(result, expected);
  });

  test('encodes underscores, spaces, and dots like the native CLI', () => {
    assert.equal(getClaudeProjectsDir(claude, '/tmp/my_project.v1/work dir'),
      path.join(os.homedir(), '.claude', 'projects', '-tmp-my-project-v1-work-dir'));
  });

  test('cuts a name past 200 characters and adds the hash of the path, like the native CLI', () => {
    const cwd = `/Users/me/work/${'deeply_nested_folder/'.repeat(10)}`;
    const slug = claudeProjectSlug(cwd);
    // Claude Code 2.1: `${name.slice(0, 200)}-${Math.abs(hashCode(cwd)).toString(36)}`.
    assert.equal(slug, `${cwd.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200)}-4580t`);
    assert.equal(claudeProjectSlug('/a/b'), '-a-b');
  });

  test('finds a transcript in the cwd\'s project directory, through a symlink, or in another one, and only there', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-find-'));
    try {
      process.env.CLAUDE_CONFIG_DIR = path.join(root, 'profile');
      const real = path.join(fs.realpathSync(root), 'work');
      fs.mkdirSync(real);
      const link = path.join(root, 'link');
      fs.symlinkSync(real, link);
      const write = (cwd: string, id: string) => {
        const file = getClaudeJsonlPath(claude, cwd, id);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '');
      };
      write(real, 'here');
      write('/somewhere/else', 'moved');
      assert.equal(await claudeTranscriptFindable(claude, real, 'here'), true);
      assert.equal(await claudeTranscriptFindable(claude, link, 'here'), true, 'the CLI sees its cwd with symlinks resolved');
      assert.equal(await claudeTranscriptFindable(claude, real, 'moved'), true, "the CLI's own scan finds a session from another directory");
      assert.equal(await claudeTranscriptFindable(claude, real, 'gone'), false);
      fs.rmSync(path.join(root, 'profile'), { recursive: true });
      assert.equal(await claudeTranscriptFindable(claude, real, 'here'), false, 'no profile, no transcript');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('in cloud mode, finds a transcript where the CLI writes it, outside the per-user directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-find-cloud-'));
    const savedCloud = process.env.MICHI_CLOUD;
    try {
      process.env.CLAUDE_CONFIG_DIR = path.join(root, 'profile');
      process.env.MICHI_CLOUD = '1';
      const cwd = path.join(fs.realpathSync(root), 'work');
      fs.mkdirSync(cwd);
      // spawnClaude sets only CLAUDE_CONFIG_DIR: the CLI writes <config>/projects/<slug>.
      const written = path.join(root, 'profile', 'projects', claudeProjectSlug(cwd), 'native-1.jsonl');
      fs.mkdirSync(path.dirname(written), { recursive: true });
      fs.closeSync(fs.openSync(written, 'w'));
      assert.notEqual(getClaudeJsonlPath(claude, cwd, 'native-1', 'user-1'), written, 'Michi\'s own layout adds the user');
      assert.equal(await claudeTranscriptFindable(claude, cwd, 'native-1', 'user-1'), true);
      assert.equal(await claudeTranscriptFindable(claude, '/moved/elsewhere', 'native-1', 'user-1'), true, 'and its scan too');
      assert.equal(await claudeTranscriptFindable(claude, cwd, 'native-2', 'user-1'), false);
      // One in Michi's per-user layout is found as well.
      const perUser = getClaudeJsonlPath(claude, cwd, 'native-3', 'user-1');
      fs.mkdirSync(path.dirname(perUser), { recursive: true });
      fs.closeSync(fs.openSync(perUser, 'w'));
      assert.equal(await claudeTranscriptFindable(claude, cwd, 'native-3', 'user-1'), true);
    } finally {
      if (savedCloud === undefined) delete process.env.MICHI_CLOUD;
      else process.env.MICHI_CLOUD = savedCloud;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ── Case 2: getClaudeJsonlPath appends sessionId.jsonl ───────────────────

  test('getClaudeJsonlPath returns <HOME>/.claude/projects/-x-y/sid-1.jsonl', () => {
    const result = getClaudeJsonlPath(claude, '/x/y', 'sid-1');
    const expected = path.join(os.homedir(), '.claude', 'projects', '-x-y', 'sid-1.jsonl');
    assert.equal(result, expected);
  });

  // ── Case 3: trailing slash behavior ──────────────────────────────────────
  //
  // Non-alphanumeric characters in the raw cwd string become dashes.
  // '/Users/foo/bar/' → '-Users-foo-bar-'  (trailing dash)
  // This is the actual behavior — document it as a known quirk.

  test('getClaudeProjectsDir produces trailing dash when cwd has trailing slash', () => {
    const result = getClaudeProjectsDir(claude, '/Users/foo/bar/');
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
    const result = getClaudeProjectsDir(claude, '/a/b');
    const expected = path.join(currentHome, '.claude', 'projects', '-a-b');
    assert.equal(result, expected, 'result must use the current HOME value at call time');
  });
});
