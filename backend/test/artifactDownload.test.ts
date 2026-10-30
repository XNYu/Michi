import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { setupArtifactRoutes } from '../src/routes/artifacts';
import { NotFoundError } from '../src/services/workspaceSandbox';

test('downloads arbitrary original bytes with ownership and containment checks', async (t) => {
  // Like the scratch root ~/.michi/workspaces/<id>, the workspace sits inside a dot directory.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-download-'));
  const root = path.join(home, '.michi', 'workspaces', 'owned');
  fs.mkdirSync(root, { recursive: true });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-outside-'));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const bytes = Buffer.from([0, 255, 128, 42]);
  fs.writeFileSync(path.join(root, 'data.unknown'), bytes);
  fs.writeFileSync(path.join(root, 'page.html'), '<script>alert(1)</script>');
  fs.writeFileSync(path.join(outside, 'secret'), 'secret');
  fs.symlinkSync(path.join(outside, 'secret'), path.join(root, 'escape'));
  const app = express();
  app.use(setupArtifactRoutes({ resolveRoot: (_req, id) => {
    if (id !== 'owned') throw new NotFoundError(id);
    return root;
  } }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/artifacts`;
  const res = await fetch(`${base}/owned/download?path=data.unknown`);
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
  assert.match(res.headers.get('content-disposition')!, /^attachment;/);
  const html = await fetch(`${base}/owned/download?path=page.html`);
  assert.equal(html.headers.get('content-type'), 'application/octet-stream');
  assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
  assert.match(html.headers.get('content-disposition')!, /^attachment;/);
  for (const [owner, file] of [['other', 'data.unknown'], ['owned', 'escape'], ['owned', '../secret'], ['owned', '.'], ['owned', 'missing']]) {
    assert.equal((await fetch(`${base}/${owner}/download?path=${encodeURIComponent(file)}`)).status, 404);
  }
});
