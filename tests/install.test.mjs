import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('README documents the one-command installer', () => {
  const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');

  assert.match(
    readme,
    /curl -fsSL https:\/\/raw\.githubusercontent\.com\/XNYu\/Michi\/main\/install\.sh \| bash/,
  );
});

test('install.sh is strict, public, and non-sudo by default', () => {
  const script = readFileSync(resolve(repoRoot, 'install.sh'), 'utf8');

  assert.match(script, /^#!\/usr\/bin\/env bash/);
  assert.match(script, /set -euo pipefail/);
  assert.match(script, /MICHI_REPO_URL:=https:\/\/github\.com\/XNYu\/Michi\.git/);
  assert.match(script, /MICHI_INSTALL_DIR:=\$HOME\/Michi/);
  assert.doesNotMatch(script, /\bsudo\b/);
});

test('install.sh exposes help without starting installation', () => {
  const output = execFileSync('bash', ['install.sh', '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  assert.match(output, /Usage: install\.sh/);
  assert.match(output, /MICHI_INSTALL_DIR/);
  assert.match(output, /MICHI_REPO_URL/);
});
