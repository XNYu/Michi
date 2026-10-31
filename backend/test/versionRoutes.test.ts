import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import express from 'express';
import { setupVersionRoutes } from '../src/routes/version';

const ADMIN = 'admin@example.com';
const originalEnv = { ...process.env };
const originalCwd = process.cwd();
let repo: string;
let server: ReturnType<typeof express.application.listen>;
let base: string;

// The session gate's result, injected per request: local-auth sets only the
// login principal, cloud also sets the owner (see sessionAccess.ts).
function principal(req: express.Request): void {
  const email = req.header('x-test-email');
  if (!email) return;
  const user = { id: email.split('@')[0], email, emailVerified: req.header('x-test-unverified') !== '1' };
  Object.assign(req, { authUser: user, user: process.env.MICHI_CLOUD === '1' ? user : undefined });
}

function mode(name: 'local' | 'local-auth' | 'cloud'): void {
  process.env.MICHI_REQUIRE_AUTH = String(name !== 'local');
  process.env.MICHI_CLOUD = name === 'cloud' ? '1' : '0';
  if (name === 'local-auth') process.env.MICHI_LOCAL_AUTH_EMAIL = ADMIN;
  else delete process.env.MICHI_LOCAL_AUTH_EMAIL;
  process.env.MICHI_ADMIN_EMAILS = ADMIN;
}

async function version(email?: string, unverified = false) {
  const headers: Record<string, string> = {};
  if (email) headers['x-test-email'] = email;
  if (unverified) headers['x-test-unverified'] = '1';
  const response = await fetch(`${base}/version`, { headers });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

before(() => {
  // A repository with no remotes: GET /version never reaches the network.
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-version-routes-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
  process.chdir(repo);
});

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { principal(req); next(); });
  app.use('/api', setupVersionRoutes());
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.env = { ...originalEnv };
});

after(() => {
  process.chdir(originalCwd);
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('GET /version reports whether this caller may update', () => {
  test('local mode never allows the HTTP update, and the update route stays closed', async () => {
    mode('local');
    const result = await version();
    assert.equal(result.status, 200);
    assert.equal(result.body.updateAllowed, false);
    assert.equal((await version(ADMIN)).body.updateAllowed, false);
    const update = await fetch(`${base}/version/update`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(update.status, 404);
  });

  test('local-auth allows only a verified admin', async () => {
    mode('local-auth');
    assert.equal((await version(ADMIN)).body.updateAllowed, true);
    assert.equal((await version(ADMIN, true)).body.updateAllowed, false);
    process.env.MICHI_ADMIN_EMAILS = '';
    assert.equal((await version(ADMIN)).body.updateAllowed, false);
  });

  test('cloud allows an admin and not another user', async () => {
    mode('cloud');
    assert.equal((await version(ADMIN)).body.updateAllowed, true);
    assert.equal((await version('bob@example.com')).body.updateAllowed, false);
    assert.equal((await version()).body.updateAllowed, false);
  });

  test('a misconfigured access mode reports the update as not allowed', async () => {
    mode('cloud');
    process.env.MICHI_REQUIRE_AUTH = 'false';
    const result = await version(ADMIN);
    assert.equal(result.status, 200);
    assert.equal(result.body.updateAllowed, false);
  });
});
