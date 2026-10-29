import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

// The benchmarks start Electron, so these tests run the real shell scripts in a
// throwaway git repository with npm/npx replaced by stubs that only log where
// and how they were called.
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.email=bench@test', '-c', 'user.name=bench', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function fixtureRepo(t) {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'michi-bench-test-')));
  t.after(() => {
    try { git(path.join(tmp, 'repo'), 'worktree', 'prune'); } catch { /* repo may not exist */ }
    rmSync(tmp, { recursive: true, force: true });
  });
  const repo = path.join(tmp, 'repo');
  const bin = path.join(tmp, 'bin');
  const calls = path.join(tmp, 'calls.log');
  mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  mkdirSync(bin);

  for (const name of ['bench-startup-comparison.sh', 'bench-startup.sh', 'electron-dev-env.mjs']) {
    copyFileSync(path.join(scriptsDir, name), path.join(repo, 'scripts', name));
  }
  writeFileSync(path.join(repo, 'scripts', 'kill-stale-dev.mjs'), '');
  writeFileSync(path.join(repo, 'scripts', 'analyze-startup.mjs'), '');
  writeFileSync(path.join(repo, 'scripts', 'find-open-port.mjs'), 'console.log(3001);\n');
  // The files the old comparison script stashed by name.
  for (const file of [
    'backend/src/services/dbRepository.ts',
    'electron/main.ts',
    'frontend/src/components/terminal/TPane.tsx',
    'frontend/src/components/terminal/manage/ManageComposer.test.tsx',
    'frontend/src/components/terminal/manage/ManageComposer.tsx',
    'frontend/src/index.css',
    'frontend/viteChunks.ts',
  ]) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), 'committed\n');
  }
  writeFileSync(path.join(repo, 'marker.txt'), 'committed\n');
  writeFileSync(path.join(repo, '.gitignore'), 'logs/\n');
  git(tmp, 'init', '-q', repo);
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');

  // A stub that records the command, its directory, what that checkout's
  // marker says and the environment the benchmark launched with.
  const stub = (name) => {
    const file = path.join(bin, name);
    writeFileSync(
      file,
      [
        '#!/usr/bin/env bash',
        `echo "${name} $* | pwd=$PWD | marker=$(cat marker.txt 2>/dev/null) | config=\${MICHI_CONFIG_DIR:-} | userdata=\${MICHI_ELECTRON_USER_DATA_DIR:-}" >> "${calls}"`,
        `if [[ "${name} $1" == "\${STUB_FAIL:-}" ]]; then exit 1; fi`,
        'exit 0',
        '',
      ].join('\n'),
    );
    chmodSync(file, 0o755);
  };
  stub('npm');
  stub('npx');
  return { tmp, repo, bin, calls };
}

function runScript(fx, script, args, extraEnv = {}) {
  return spawnSync('bash', [path.join('scripts', script), ...args], {
    cwd: fx.repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fx.tmp,
      PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`,
      BENCH_DURATION: '0',
      MICHI_DATA_DIR: path.join(fx.tmp, 'data'),
      MICHI_CONFIG_DIR: '',
      MICHI_ELECTRON_USER_DATA_DIR: '',
      MICHI_DEV_INSTANCE_ID: '',
      TMPDIR: fx.tmp,
      ...extraEnv,
    },
  });
}

function calls(fx) {
  return existsSync(fx.calls) ? readFileSync(fx.calls, 'utf8').trim().split('\n') : [];
}

test('comparison benchmark never stashes or rewrites the working tree', (t) => {
  const fx = fixtureRepo(t);
  // A stash the developer already had, plus uncommitted work outside the
  // files the old script stashed by name.
  writeFileSync(path.join(fx.repo, 'electron/main.ts'), 'stashed earlier\n');
  git(fx.repo, 'stash', 'push', '-q', '-m', 'developer stash');
  writeFileSync(path.join(fx.repo, 'marker.txt'), 'uncommitted\n');
  const stashBefore = git(fx.repo, 'stash', 'list');
  const statusBefore = git(fx.repo, 'status', '--porcelain');

  const result = runScript(fx, 'bench-startup-comparison.sh', ['both', 'HEAD']);
  assert.equal(result.status, 0, result.stderr + result.stdout);

  assert.equal(git(fx.repo, 'stash', 'list'), stashBefore);
  assert.equal(git(fx.repo, 'status', '--porcelain'), statusBefore);
  assert.equal(readFileSync(path.join(fx.repo, 'marker.txt'), 'utf8'), 'uncommitted\n');

  const launches = calls(fx).filter((line) => line.startsWith('npx concurrently'));
  assert.equal(launches.length, 2, calls(fx).join('\n'));
  // "before" ran in a separate checkout of the base ref; "after" in this one.
  assert.match(launches[0], /marker=committed /);
  assert.ok(!launches[0].includes(`pwd=${fx.repo} `), launches[0]);
  assert.match(launches[1], /marker=uncommitted /);
  assert.ok(launches[1].includes(`pwd=${fx.repo} `), launches[1]);

  // The temporary checkout is gone and unregistered.
  const worktrees = git(fx.repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm) ?? [];
  assert.equal(worktrees.length, 1);
});

test('startup benchmark launches with the electron:dev config dir and Electron profile', (t) => {
  const fx = fixtureRepo(t);
  const result = runScript(fx, 'bench-startup.sh', ['probe']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const [launch] = calls(fx).filter((line) => line.startsWith('npx concurrently'));
  const dataDir = path.join(fx.tmp, 'data');
  // Not the installed app's ~/.michi config, and not Electron's default profile.
  assert.ok(launch.includes(`config=${dataDir} `), launch);
  assert.match(launch, new RegExp(`userdata=${dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/electron-repo-[0-9a-f]{12}$`));
  assert.ok(existsSync(path.join(fx.repo, 'logs', 'startup-probe.jsonl')));
});

test('comparison benchmark gives the base checkout its own stable Electron profile', (t) => {
  const fx = fixtureRepo(t);
  const result = runScript(fx, 'bench-startup-comparison.sh', ['both', 'HEAD']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const [before, after] = calls(fx).filter((line) => line.startsWith('npx concurrently'));
  const dataDir = path.join(fx.tmp, 'data');
  assert.ok(before.endsWith(`userdata=${path.join(dataDir, 'electron-bench-base')}`), before);
  assert.ok(after.includes(`config=${dataDir} `), after);
  assert.match(after, /userdata=.*electron-repo-[0-9a-f]{12}$/);
});

test('comparison benchmark removes its base checkout when a step fails', (t) => {
  const fx = fixtureRepo(t);
  const result = runScript(fx, 'bench-startup-comparison.sh', ['before', 'HEAD'], { STUB_FAIL: 'npm ci' });
  assert.notEqual(result.status, 0);
  const worktrees = git(fx.repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm) ?? [];
  assert.equal(worktrees.length, 1, git(fx.repo, 'worktree', 'list'));
  assert.deepEqual(calls(fx).filter((line) => line.startsWith('npx concurrently')), []);
});
