import { afterEach, beforeEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { setupFilesRoutes } from '../src/routes/files';
import { setupArtifactRoutes } from '../src/routes/artifacts';
import { setupUploadsRoutes } from '../src/routes/uploads';
import { setupDiffRoutes } from '../src/routes/diff';
import { closeDb } from '../src/services/db';
import { saveWorkspace } from '../src/services/dbRepository';
import { desktopUploadRoot, resolveHttpWorkspacePath, assertWorkspaceRealpath } from '../src/services/workspaceFiles';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { trySymlinkSync } from './symlinkUtil';

let root: string; let workspaceId: string; let upload: string; let scratch: string;
let server: ReturnType<express.Express['listen']>; let base: string;
let savedEnv: { data?: string; cloud?: string };
beforeEach(async () => {
  savedEnv = { data: process.env.MICHI_DATA_DIR, cloud: process.env.MICHI_CLOUD };
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-workspace-file-routes-'));
  process.env.MICHI_DATA_DIR = path.join(root, 'data'); delete process.env.MICHI_CLOUD; closeDb();
  mock.method(os, 'homedir', () => path.join(root, 'home'));
  workspaceId = `ws-${randomUUID()}`; upload = path.join(desktopUploadRoot(), workspaceId); scratch = path.join(root, 'home/.michi/workspaces', workspaceId);
  saveWorkspace({ id: workspaceId, name: 'Fixture', created_at: 1, updated_at: 1 });
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { const id = req.header('x-user'); if (id) req.user = { id }; next(); });
  app.use('/api', setupFilesRoutes(), setupArtifactRoutes(), setupUploadsRoutes(), setupDiffRoutes());
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterEach(async () => {
  mock.restoreAll(); __resetRuntimeDeps(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); closeDb();
  if (savedEnv.data === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = savedEnv.data;
  if (savedEnv.cloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = savedEnv.cloud;
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(upload, { recursive: true, force: true });
});
function repo(dir: string, marker: string): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const args of [['init', '-q'], ['config', 'user.email', 'fixture@example.com'], ['config', 'user.name', 'Fixture'], ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture']]) execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'marker.png'), marker);
}
async function assertRoots(marker: string, expectedRoot: string): Promise<void> {
  const image = await fetch(`${base}/files/${workspaceId}/marker.png`); assert.equal(image.status, 200); assert.equal(await image.text(), marker);
  const artifact = await fetch(`${base}/artifacts/${workspaceId}/read?path=marker.png`); assert.equal(artifact.status, 200); assert.equal((await artifact.json() as any).content, marker);
  const diff = await fetch(`${base}/workspaces/${workspaceId}/diff?path=marker.png`); assert.equal(diff.status, 200); assert.ok((await diff.json() as any).diff.includes(marker));
  const allocated = await fetch(`${base}/uploads/web-cwd`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) });
  assert.equal(allocated.status, 200); assert.equal((await allocated.json() as any).cwd, path.resolve(expectedRoot));
}

test('persisted cwd wins across image, artifact, diff and upload even when fallback directories exist', async () => {
  const picked = path.join(root, 'picked'); repo(picked, 'picked-marker'); repo(upload, 'upload-marker'); repo(scratch, 'scratch-marker');
  saveWorkspace({ id: workspaceId, name: 'Fixture', cwd: picked, created_at: 1, updated_at: 2 });
  await assertRoots('picked-marker', picked);
});
test('existing upload root wins over legacy scratch across all four routes', async () => {
  repo(upload, 'upload-marker'); repo(scratch, 'scratch-marker'); await assertRoots('upload-marker', upload);
});
test('legacy scratch is consistently reused when no saved cwd or upload exists', async () => {
  repo(scratch, 'scratch-marker'); await assertRoots('scratch-marker', scratch);
});
test('new upload allocation is reused by all readers, which reject unknown workspaces', async () => {
  const allocated = await fetch(`${base}/uploads/web-cwd`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) });
  assert.equal(allocated.status, 200); assert.equal((await allocated.json() as any).cwd, path.resolve(upload)); repo(upload, 'new-upload'); await assertRoots('new-upload', upload);
  for (const url of ['/files/unknown/marker.png', '/artifacts/unknown/read?path=marker.png', '/workspaces/unknown/diff?path=marker.png']) {
    const result = await fetch(base + url); assert.equal(result.status, 404); await result.arrayBuffer();
  }
});
test('HTTP path validation preserves literal once-decoded names and refuses cross-platform escapes', async () => {
  repo(upload, 'marker'); fs.writeFileSync(path.join(upload, '%2e%2e.png'), 'literal-name');
  const literal = await fetch(`${base}/files/${workspaceId}/%252e%252e.png`); assert.equal(literal.status, 200); assert.equal(await literal.text(), 'literal-name');
  for (const relative of ['../secret.png', '/secret.png', '~home.png', 'a/@mention.png', 'a//b.png', '..\\secret.png', 'C:\\secret.png']) {
    assert.throws(() => resolveHttpWorkspacePath(relative, upload));
    for (const url of [`/files/${workspaceId}/${encodeURIComponent(relative)}`, `/artifacts/${workspaceId}/read?path=${encodeURIComponent(relative)}`, `/workspaces/${workspaceId}/diff?path=${encodeURIComponent(relative)}`]) {
      const result = await fetch(base + url); assert.equal(result.status, 404, url); await result.arrayBuffer();
    }
  }
});
test('realpath containment rejects symlink escapes in reads and diffs, including deleted targets', async () => {
  repo(upload, 'marker'); const outside = path.join(root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.png'), 'secret');
  if (!trySymlinkSync(outside, path.join(upload, 'link'))) return;
  for (const url of [`/files/${workspaceId}/link/secret.png`, `/artifacts/${workspaceId}/read?path=link/secret.png`, `/workspaces/${workspaceId}/diff?path=link/secret.png`]) {
    const result = await fetch(base + url); assert.equal(result.status, 404); await result.arrayBuffer();
  }
  assert.throws(() => assertWorkspaceRealpath(path.join(upload, 'link/missing.png'), upload));
});
test('cloud requests require the owner for files, artifacts, diff and upload allocation', async () => {
  process.env.MICHI_CLOUD = '1';
  configureRuntimeDeps({ dataDir: path.join(root, 'sandbox'), agentConfig: {} as any, historyStore: { getWorkspace: (id: string, userId?: string) => id === workspaceId && userId === 'owner' ? { owner_user_id: 'owner' } : null } as any });
  for (const user of [undefined, 'other']) {
    const headers = user ? { 'x-user': user } : undefined;
    for (const url of [`/files/${workspaceId}/marker.png`, `/artifacts/${workspaceId}/read?path=marker.png`, `/workspaces/${workspaceId}/diff?path=marker.png`]) {
      const result = await fetch(base + url, { headers }); assert.equal(result.status, 404); await result.arrayBuffer();
    }
    const result = await fetch(`${base}/uploads/web-cwd`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) }); assert.equal(result.status, 404); await result.arrayBuffer();
  }
});

test('image and artifact routes preserve distinct MIME and size error policies', async () => {
  repo(upload, 'marker'); fs.writeFileSync(path.join(upload, 'plain.txt'), 'text');
  let result = await fetch(`${base}/files/${workspaceId}/plain.txt`); assert.equal(result.status, 404); await result.arrayBuffer();
  result = await fetch(`${base}/artifacts/${workspaceId}/read?path=plain.txt`); assert.equal(result.status, 200); assert.equal((await result.json() as any).content, 'text');
  fs.writeFileSync(path.join(upload, 'oversize.png'), Buffer.alloc(5 * 1024 * 1024 + 1));
  result = await fetch(`${base}/files/${workspaceId}/oversize.png`); assert.equal(result.status, 404); assert.equal(await result.text(), '');
  result = await fetch(`${base}/artifacts/${workspaceId}/read?path=oversize.png`); assert.equal(result.status, 413); assert.match((await result.json() as any).error, /open externally/);
});
