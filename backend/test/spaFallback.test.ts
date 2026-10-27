import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { setupSpaFallback } from '../src/routes/spaFallback';

/** Raw GET: fetch would normalise the path. */
function get(base: string, p: string): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    http.get({ host: url.hostname, port: url.port, path: p }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body }));
    }).on('error', reject);
  });
}

describe('SPA fallback', () => {
  let dir: string;
  let server: http.Server;
  let base: string;
  const errors: string[] = [];

  before(async () => {
    // A build inside a dot-directory, as in a `.worktrees/<name>` checkout.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-'));
    const build = path.join(dir, '.worktrees', 'w', 'frontend', 'build');
    fs.mkdirSync(path.join(build, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(build, 'index.html'), '<!doctype html><title>Michi</title>');
    fs.writeFileSync(path.join(build, 'assets', 'app.js'), 'console.log(1)');
    fs.writeFileSync(path.join(build, '.env'), 'BUILD_SECRET=1');
    fs.writeFileSync(path.join(dir, 'outside.txt'), 'OUTSIDE_SECRET');
    const app = express();
    app.get('/api/known', (_req, res) => { res.json({ ok: true }); });
    setupSpaFallback(app, build);
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      errors.push(err.message);
      res.status(500).json({ error: 'Something broke!' });
    });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves the page on a deep link and the build’s files, from a build under a dot-directory', async () => {
    const page = await get(base, '/threads/t1');
    assert.equal(page.status, 200);
    assert.match(page.type, /^text\/html/);
    assert.match(page.body, /<title>Michi<\/title>/);
    const asset = await get(base, '/assets/app.js');
    assert.equal(asset.status, 200);
    assert.match(asset.type, /javascript/);
    assert.equal(asset.body, 'console.log(1)');
    assert.deepEqual(errors, []);
  });

  it('never serves a dotfile from the build, nor anything outside it', async () => {
    for (const p of ['/.env', '/assets/../.env', '/%2eenv', '/%2Eenv']) {
      const res = await get(base, p);
      assert.doesNotMatch(res.body, /BUILD_SECRET/, p);
    }
    for (const p of [
      '/../../../../outside.txt',
      '/assets/../../../../../outside.txt',
      '/assets/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/outside.txt',
      '/..%2f..%2f..%2f..%2f..%2foutside.txt',
      '/assets/..%5c..%5c..%5c..%5c..%5coutside.txt',
    ]) {
      const res = await get(base, p);
      assert.doesNotMatch(res.body, /OUTSIDE_SECRET/, p);
      assert.ok(res.status === 200 || res.status === 400 || res.status === 403 || res.status === 404, `${p}: ${res.status}`);
      if (res.status === 200) assert.match(res.type, /^text\/html/, p);
    }
    assert.deepEqual(errors, []);
  });

  it('answers an MCP client’s OAuth discovery probe with a plain 404, never the page or a 500', async () => {
    const probe = await get(base, '/.well-known/oauth-protected-resource/api/mcp/2d7b309553d7405c737386641d4a49e7');
    assert.equal(probe.status, 404);
    assert.doesNotMatch(probe.body, /<title>Michi/);
    for (const p of ['/.well-known/oauth-authorization-server', '/.well-known', '/.WELL-KNOWN/x']) {
      const res = await get(base, p);
      assert.equal(res.status, 404, p);
      assert.doesNotMatch(res.body, /<title>Michi/, p);
    }
    assert.deepEqual(errors, []);
  });

  it('leaves /api/ to the API routes', async () => {
    assert.equal((await get(base, '/api/known')).status, 200);
    assert.equal((await get(base, '/API/known')).status, 200, 'Express routes ignore case');
    for (const p of ['/api/nope', '/api', '/API/nope', '/Api']) {
      const res = await get(base, p);
      assert.equal(res.status, 404, p);
      assert.doesNotMatch(res.body, /<title>Michi/, p);
    }
  });
});
