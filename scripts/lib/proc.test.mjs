import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { npm, repoRoot, run } from './proc.mjs';

const node = process.execPath;

test('runs from the repository root with the parent environment by default', async () => {
  assert.equal(repoRoot, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
  assert.equal(npm, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const check = `if (process.cwd() !== ${JSON.stringify(realpathSync(repoRoot))}) process.exit(3)`;
  await run(node, ['-e', check]);
});

test('passes an explicit working directory and environment', async () => {
  const cwd = realpathSync(tmpdir());
  const check = `if (process.cwd() !== ${JSON.stringify(cwd)} || process.env.PROC_TEST !== 'yes') process.exit(4)`;
  await run(node, ['-e', check], { cwd, env: { ...process.env, PROC_TEST: 'yes' } });
});

test('rejects with the command and exit code when the command fails', async () => {
  await assert.rejects(run(node, ['-e', 'process.exit(7)']), (error) => {
    assert.equal(error.message, `${node} -e process.exit(7) exited 7`);
    return true;
  });
});
