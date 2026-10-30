import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MIN_NODE_VERSION, readMinimumNodeVersion } from './remote-control.mjs';

// Michi's minimum Node version has one source, engines.node in the root
// package.json. bin/lib/node-select.sh (install.sh, bin/michi),
// scripts/remote-control.mjs and crew-app/launch.py read it.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(resolve(repoRoot, file), 'utf8');
const rootRange = JSON.parse(read('package.json')).engines?.node;
const rootMinimum = rootRange?.replace(/^>=/, '');
const lib = resolve(repoRoot, 'bin/lib/node-select.sh');

function bash(script, env = process.env) {
  return spawnSync('bash', ['-c', `set -euo pipefail\nsource "$1"\n${script}`, 'bash', lib], { encoding: 'utf8', env });
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'michi-node-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the root package.json states the minimum as >=X.Y.Z', () => {
  assert.match(rootRange ?? '', /^>=\d+\.\d+\.\d+$/);
});

test('workspace packages that declare engines.node use the root minimum', () => {
  for (const workspace of JSON.parse(read('package.json')).workspaces) {
    const engines = JSON.parse(read(`${workspace}/package.json`)).engines;
    if (engines?.node !== undefined) assert.equal(engines.node, rootRange, `${workspace}/package.json`);
  }
});

test('node-select.sh reads the same minimum as package.json', () => {
  const result = bash('michi_node_minimum "$REPO"', { ...process.env, REPO: repoRoot });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), rootMinimum);
});

test('node-select.sh compares full versions', () => {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  const cases = [
    [process.versions.node, 0],
    [`${major}.${minor}.${patch + 1}`, 1],
    [`${major}.${minor + 1}.0`, 1],
    [`${major + 1}.0.0`, 1],
    [`${major - 1}.99.99`, 0],
    [`${major}.${Math.max(minor - 1, 0)}.99`, minor > 0 ? 0 : 1],
  ];
  for (const [minimum, status] of cases) {
    const result = bash(`michi_node_meets_minimum "${process.execPath}" "${minimum}"`);
    assert.equal(result.status, status, `Node ${process.versions.node} against ${minimum}`);
  }
});

test('michi_select_node takes the first preferred node that qualifies and puts it on PATH', (t) => {
  const dir = tempDir(t);
  const old = join(dir, 'old/bin/node');
  const good = join(dir, 'good/bin/node');
  mkdirSync(dirname(old), { recursive: true });
  mkdirSync(dirname(good), { recursive: true });
  writeFileSync(old, '#!/bin/sh\nexit 1\n');
  chmodSync(old, 0o755);
  // A wrapper, not a symlink: process.execPath can itself be a wrapper that
  // finds the real binary beside it.
  writeFileSync(good, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
  chmodSync(good, 0o755);
  const env = { HOME: join(dir, 'home'), PATH: `/Applications/Codex.app/Contents/bin:${dirname(old)}:/usr/bin:/bin` };

  const picked = bash(`michi_select_node "${process.versions.node}" "${old}" "${good}"\nprintf '%s\\n%s\\n' "$MICHI_NODE" "$PATH"`, env);
  assert.equal(picked.status, 0, picked.stderr);
  const [node, path] = picked.stdout.trim().split('\n');
  assert.equal(node, good);
  assert.equal(path.split(':')[0], dirname(good));
  assert.doesNotMatch(path, /Codex\.app/);

  const [major] = process.versions.node.split('.').map(Number);
  const none = bash(`michi_select_node "${major + 1}.0.0" "${good}"`, env);
  assert.equal(none.status, 1);
});

test('remote-control.mjs takes its minimum from package.json', (t) => {
  assert.equal(`>=${MIN_NODE_VERSION.join('.')}`, rootRange);
  const dir = tempDir(t);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ engines: { node: '>=23.4.5' } }));
  assert.deepEqual(readMinimumNodeVersion(dir), [23, 4, 5]);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ engines: { node: '>=22' } }));
  assert.throws(() => readMinimumNodeVersion(dir), /engines\.node/);
});

test('install.sh and bin/michi use the shared selection without their own minimum', () => {
  for (const file of ['install.sh', 'bin/michi']) {
    const text = read(file);
    assert.match(text, /^\s*source "\$\{?INSTALL_DIR\}?\/bin\/lib\/node-select\.sh"$/m, `${file} sources node-select.sh`);
    assert.doesNotMatch(text, /-ge 22\b|22\.19|node@22|process\.versions\.node/, `${file} has its own version check`);
    assert.doesNotMatch(text, /codesign -dv|candidate_nodes\(\)/, `${file} has its own selection logic`);
  }
});

test('the Crew launcher and the remote launcher hold no version literal', () => {
  assert.doesNotMatch(read('crew-app/launch.py'), /22, ?19|22\.19/);
  assert.doesNotMatch(read('scripts/remote-control.mjs'), /\[22, ?19|22\.19/);
});
