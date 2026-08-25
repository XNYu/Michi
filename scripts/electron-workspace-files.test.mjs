import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { listWorkspaceDirectory, resolveAllowedDirectory } = require('../electron/dist/workspaceFiles.js');

test('workspace directory listing is shallow, sorted, and root constrained', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'michi-files-root-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'michi-files-outside-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'z.txt'), 'z');
  await fs.writeFile(path.join(root, 'a.txt'), 'a');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
  await fs.symlink(outside, path.join(root, 'escaped-link'));

  const entries = await listWorkspaceDirectory(root, [root]);
  assert.deepEqual(entries.map((entry) => [entry.name, entry.kind]), [
    ['src', 'directory'],
    ['a.txt', 'file'],
    ['z.txt', 'file'],
  ]);
  await assert.rejects(() => resolveAllowedDirectory(outside, [root]), /outside this workspace/);
});
