import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { setupArtifactRoutes } from '../src/routes/artifacts';
import { NotFoundError } from '../src/services/workspaceSandbox';

function write(root: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

async function serve(t: { after: (fn: () => void) => void }, root: string): Promise<(file: string, preview?: boolean) => Promise<Response>> {
  const app = express();
  app.use(setupArtifactRoutes({ resolveRoot: (_req, id) => {
    if (id !== 'owned') throw new NotFoundError(id);
    return root;
  } }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/artifacts/owned/read`;
  return (file, preview = true) => fetch(`${base}?path=${encodeURIComponent(file)}${preview ? '&preview=1' : ''}`);
}

function fixture(t: { after: (fn: () => void) => void }, prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}outside-`));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  write(root, 'frontend/src/settings/metaAgent/runtimeCopy.ts', 'export const runtime = 1;\n');
  write(root, 'frontend/src/scheduled/metaAgent/metaAgentCopy.ts', 'export const meta = 1;\n');
  write(root, 'a/dup.ts', 'a');
  write(root, 'b/dup.ts', 'b');
  write(outside, 'secret.ts', 'secret');
  fs.symlinkSync(outside, path.join(root, 'linked'));
  return root;
}

async function assertSuffixResolution(read: (file: string, preview?: boolean) => Promise<Response>): Promise<void> {
  const bare = await read('runtimeCopy.ts');
  assert.equal(bare.status, 200);
  const body = await bare.json() as { content: string; path: string };
  assert.equal(body.content, 'export const runtime = 1;\n');
  assert.equal(body.path, 'frontend/src/settings/metaAgent/runtimeCopy.ts');

  const trailing = await read('./scheduled/metaAgent/metaAgentCopy.ts');
  assert.equal(trailing.status, 200);
  assert.equal((await trailing.json() as { path: string }).path, 'frontend/src/scheduled/metaAgent/metaAgentCopy.ts');

  // Exact paths keep their requested form.
  const exact = await read('a/dup.ts');
  assert.equal((await exact.json() as { path: string }).path, 'a/dup.ts');

  // Ambiguous, partial-name, escaping and symlinked-outside suffixes stay missing.
  for (const file of ['dup.ts', 'Copy.ts', '../runtimeCopy.ts', 'secret.ts', 'metaAgent/../runtimeCopy.ts']) {
    assert.equal((await read(file)).status, 404, file);
  }
  // Workspace artifact reads (non-preview) keep exact paths.
  assert.equal((await read('runtimeCopy.ts', false)).status, 404);
}

test('preview reads resolve a unique trailing path in a non-git workspace', async (t) => {
  const root = fixture(t, 'artifact-suffix-walk-');
  await assertSuffixResolution(await serve(t, root));
});

test('preview reads resolve a unique trailing path from git tracked and unignored files', async (t) => {
  const root = fixture(t, 'artifact-suffix-git-');
  try {
    execFileSync('git', ['init', '-q', root], { stdio: 'ignore' });
  } catch {
    t.skip('git is unavailable');
    return;
  }
  write(root, '.gitignore', 'ignored/\n');
  write(root, 'ignored/onlyIgnored.ts', 'ignored');
  const read = await serve(t, root);
  await assertSuffixResolution(read);
  assert.equal((await read('onlyIgnored.ts')).status, 404);
});
