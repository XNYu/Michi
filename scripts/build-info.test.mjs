import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { michiBuildInfo } from './build-info.mjs';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';

test('build identity includes ancestry, survives later checkout changes, and degrades without git', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-build-info-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    assert.equal(michiBuildInfo(dir).revision, null);
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
    git('commit', '--allow-empty', '-m', 'first'); const first = git('rev-parse', 'HEAD');
    git('commit', '--allow-empty', '-m', 'second'); const second = git('rev-parse', 'HEAD');
    const info = michiBuildInfo(dir);
    assert.equal(info.revision, second); assert.deepEqual(info.ancestors, [second, first]);
    git('checkout', '--detach', first); assert.equal(info.revision, second);
    assert.equal(michiBuildInfo(dir).revision, first);
    fs.mkdirSync(path.join(dir, 'backend')); fs.writeFileSync(path.join(dir, 'backend/unpublished.ts'), 'new code');
    assert.equal(michiBuildInfo(dir).dirty, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('packaged build identity does not require a source checkout or Git at runtime', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-packaged-build-info-'));
  try {
    const identity = { version: '1.2.3', revision: 'a'.repeat(40), ancestors: ['a'.repeat(40)], dirty: false };
    const outfile = path.join(dir, 'build-info.cjs');
    buildSync({ entryPoints: [new URL('../backend/src/services/buildInfo.ts', import.meta.url).pathname], outfile,
      bundle: true, platform: 'node', format: 'cjs', define: { __MICHI_BUILD_INFO__: JSON.stringify(identity) } });
    const compiled = createRequire(import.meta.url)(outfile);
    assert.deepEqual(compiled.runningBuild, identity);
    assert.deepEqual(compiled.publicBuildInfo(compiled.runningBuild), { version: '1.2.3', revision: identity.revision });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
