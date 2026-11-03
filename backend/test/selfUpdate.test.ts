import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import express from 'express';
import { SelfUpdater, type SelfUpdateOptions } from '../src/services/selfUpdate';
import { setupSelfUpdateRoutes } from '../src/routes/selfUpdate';

const CURRENT = 'a'.repeat(40);
const LATEST = 'b'.repeat(40);

function fixture(t: TestContext, michi = '#!/usr/bin/env bash\necho "✔ Michi updated"\n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-self-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'release');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(path.join(repoRoot, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, '.git'));
  fs.writeFileSync(path.join(repoRoot, 'bin', 'michi'), michi, { mode: 0o755 });
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'remote.env'), 'MICHI_REMOTE_ACCESS="1"\n');
  return { repoRoot, dataDir };
}

/** A git that answers the check's commands for a branch two commits ahead. */
function fakeGit(calls: string[][], options: { dirty?: boolean; fetchError?: string; latest?: string } = {}): SelfUpdateOptions['git'] {
  return async (args) => {
    calls.push(args);
    const [command] = args;
    if (command === 'fetch') {
      if (options.fetchError) throw Object.assign(new Error('git failed'), { stderr: `${options.fetchError}\n` });
      return '';
    }
    if (command === 'rev-parse') return `${options.latest ?? LATEST}\n`;
    if (command === 'cat-file') return '';
    if (command === 'merge-base') throw new Error('not an ancestor');
    if (command === 'log') return `${LATEST}\x1ffeat: Newest\x1f2026-10-31T10:00:00Z\n${'c'.repeat(40)}\x1ffix: Older\x1f2026-10-30T10:00:00Z\n`;
    if (command === 'rev-list') return '2\n';
    if (command === 'status') return options.dirty ? ' M backend/src/server.ts\n' : '';
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

function rejectsWith(promise: Promise<unknown>, status: number, code?: string, check?: (body: Record<string, any>) => void) {
  return assert.rejects(promise, (error: Error & { status?: number; body?: Record<string, any> }) => {
    assert.equal(error.status, status);
    if (code) assert.equal(error.body?.code, code);
    check?.(error.body ?? {});
    return true;
  });
}

function updater(t: TestContext, overrides: Partial<SelfUpdateOptions> = {}) {
  const paths = fixture(t);
  const calls: string[][] = [];
  const launches: Array<{ command: string; args: string[]; logFile: string; env: NodeJS.ProcessEnv }> = [];
  const alive = new Set<number>();
  const instance = new SelfUpdater({
    ...paths,
    current: { version: '1.0.0', revision: CURRENT },
    remoteAccess: true,
    platform: 'linux',
    env: { PATH: '/usr/bin:/bin', HOME: '/home/owner', NODE_ENV: 'production', MICHI_REMOTE_TOKEN: 'secret-token-value', PORT: '4123' },
    git: fakeGit(calls),
    launch: (command, args, logFile, env) => { launches.push({ command, args, logFile, env }); alive.add(4242); return 4242; },
    cgroup: () => '0::/user.slice/user-1000.slice/session-3.scope\n',
    isAlive: (pid) => alive.has(pid),
    ...overrides,
  });
  return { instance, calls, launches, alive, ...paths };
}

test('only a remote Linux backend started by the launcher can update itself, and it runs nothing otherwise', async (t) => {
  for (const overrides of [{ remoteAccess: false }, { platform: 'darwin' as const }]) {
    const { instance, calls } = updater(t, overrides);
    const status = instance.status();
    assert.equal(status.supported, false);
    assert.match(status.reason!, /remote Linux machine/);
    await rejectsWith(instance.check(), 409);
    await rejectsWith(instance.start(), 409);
    assert.deepEqual(calls, []);
  }
  const { instance, dataDir } = updater(t);
  fs.rmSync(path.join(dataDir, 'remote.env'));
  assert.equal(instance.status().supported, false);
});

test('a check fetches the configured branch into a private ref and lists what the update brings in', async (t) => {
  const { instance, calls } = updater(t);
  const check = await instance.check();
  assert.equal(check.supported, true);
  assert.equal(check.branch, 'main');
  assert.equal(check.state, 'available');
  assert.equal(check.latest, LATEST);
  assert.equal(check.total, 2);
  assert.deepEqual(check.commits.map((commit) => commit.subject), ['feat: Newest', 'fix: Older']);
  assert.equal(check.blocked, undefined);
  assert.deepEqual(calls[0], ['fetch', '--quiet', '--no-tags', '--', 'https://github.com/michiworks/Michi.git', '+refs/heads/main:refs/michi/self-update/latest']);
  assert.ok(calls.some((args) => args[0] === 'log' && args.includes(`${CURRENT}..${LATEST}`)));
});

test('a check reports up to date, local changes and an unreachable source', async (t) => {
  const current = updater(t, { git: fakeGit([], { latest: CURRENT }) });
  const upToDate = await current.instance.check();
  assert.equal(upToDate.state, 'current');
  assert.deepEqual(upToDate.commits, []);

  const dirty = updater(t, { git: fakeGit([], { dirty: true }) });
  assert.match((await dirty.instance.check()).blocked!, /local changes/);
  await rejectsWith(dirty.instance.start(LATEST), 409, 'blocked', (body) => assert.equal(body.check.state, 'available'));
  assert.equal(dirty.launches.length, 0);

  const offline = updater(t, { git: fakeGit([], { fetchError: 'Permission denied (publickey).' }) });
  await assert.rejects(offline.instance.check(), (error: Error & { status?: number }) => {
    assert.equal(error.status, 502);
    assert.match(error.message, /Permission denied \(publickey\)\..*repository credentials/);
    return true;
  });
});

test('the source comes from the machine environment, and an invalid branch is refused', async (t) => {
  const calls: string[][] = [];
  const custom = updater(t, { git: fakeGit(calls), env: { PATH: '/bin', MICHI_REMOTE_SOURCE_URL: '/srv/michi.git', MICHI_REMOTE_SOURCE_REF: 'release' } });
  const check = await custom.instance.check();
  assert.equal(check.branch, 'release');
  assert.deepEqual(calls[0].slice(-2), ['/srv/michi.git', '+refs/heads/release:refs/michi/self-update/latest']);
  const invalid = updater(t, { env: { PATH: '/bin', MICHI_REMOTE_SOURCE_REF: '--upload-pack=x' } });
  assert.equal(invalid.instance.status().supported, false);
});

test('starting runs michi update for the confirmed revision without the backend-only environment', async (t) => {
  const { instance, launches, repoRoot, dataDir } = updater(t);
  await rejectsWith(instance.start('d'.repeat(40)), 409, 'moved', (body) => assert.equal(body.check.latest, LATEST));
  assert.equal(launches.length, 0);

  const job = await instance.start(LATEST);
  assert.equal(job.phase, 'running');
  assert.equal(job.stage, 'building');
  assert.equal(job.from, CURRENT);
  assert.equal(job.target, LATEST);
  assert.equal(launches.length, 1);
  const [{ command, args, env, logFile }] = launches;
  assert.equal(command, 'bash');
  assert.deepEqual(args.slice(-5), ['bash', path.join(repoRoot, 'bin', 'michi'), 'update', '--data-dir', dataDir]);
  assert.equal(env.NODE_ENV, undefined);
  assert.equal(env.MICHI_REMOTE_TOKEN, undefined);
  assert.equal(env.PORT, undefined);
  assert.equal(env.MICHI_DATA_DIR, dataDir);
  assert.equal(env.HOME, '/home/owner');
  assert.equal(path.dirname(logFile), path.join(dataDir, 'self-update'));
  assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);

  await rejectsWith(instance.start(LATEST), 409, 'running');
  assert.equal(launches.length, 1);
});

test('under the systemd service the updater gets a scope of its own, or Settings explains the manual update', async (t) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-self-update-bin-'));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bin, 'systemd-run'), '#!/bin/sh\n', { mode: 0o755 });
  const cgroup = () => '0::/user.slice/user-1000.slice/user@1000.service/app.slice/michi-remote.service\n';
  const service = updater(t, { cgroup, env: { PATH: bin } });
  await service.instance.start();
  assert.equal(service.launches[0].command, 'systemd-run');
  assert.deepEqual(service.launches[0].args.slice(0, 3), ['--user', '--scope', '--quiet']);
  assert.match(service.launches[0].args[3], /^--unit=michi-self-update-[0-9a-f]{8}$/);
  assert.equal(service.launches[0].args[4], 'bash');

  const without = updater(t, { cgroup, env: { PATH: '/nonexistent' } });
  assert.match(without.instance.status().reason!, /systemd-run/);
});

test('the job reads the outcome michi update wrote, also from the backend that replaced the old one', async (t) => {
  const { instance, launches, alive, repoRoot, dataDir } = updater(t);
  await instance.start();
  const { logFile } = launches[0];
  fs.appendFileSync(logFile, '🐰 Building main bbbbbbbb (log: /tmp/x.log)\n');
  assert.equal(instance.status().job!.message, 'Building main bbbbbbbb (log: /tmp/x.log)');
  fs.appendFileSync(logFile, '🐰 Switching to the new build; running chats will be interrupted\n');
  assert.equal(instance.status().job!.stage, 'switching');

  // The new build reads the same data directory after the switch.
  const replaced = new SelfUpdater({ repoRoot, dataDir, current: { version: '1.0.1', revision: LATEST }, remoteAccess: true, platform: 'linux', env: {}, isAlive: () => false, cgroup: () => '' });
  assert.equal(replaced.status().job!.phase, 'succeeded');
  fs.appendFileSync(logFile, '✔ Michi updated to bbbbbbb feat: Newest\n[michi-self-update exit 0]\n');
  const done = replaced.status().job!;
  assert.deepEqual([done.phase, done.stage, done.message], ['succeeded', 'done', 'Michi updated to bbbbbbb feat: Newest']);
  assert.ok(done.finishedAt);

  // A failed build keeps the old backend; its ✖ line is the message.
  fs.writeFileSync(logFile, '🐰 Building main bbbbbbbb\nnpm ERR! build failed\n✖ Build failed; Michi keeps running /old\n[michi-self-update exit 1]\n');
  assert.deepEqual([instance.status().job!.phase, instance.status().job!.message], ['failed', 'Build failed; Michi keeps running /old']);

  // An updater that disappeared without finishing is a failure, not a hang.
  fs.writeFileSync(logFile, '🐰 Building main bbbbbbbb\n');
  alive.clear();
  assert.deepEqual([instance.status().job!.phase, instance.status().job!.message], ['failed', 'The update stopped before it finished.']);
});

test('the real launcher detaches michi update and records its exit status', async (t) => {
  const paths = fixture(t, [
    '#!/usr/bin/env bash',
    'echo "🐰 Building main bbbbbbbb ($1 $2 $3 NODE_ENV=${NODE_ENV:-unset})"',
    'echo "✖ Build failed; Michi keeps running /old" >&2',
    'exit 3',
    '',
  ].join('\n'));
  const instance = new SelfUpdater({
    ...paths, current: { version: '1.0.0', revision: CURRENT }, remoteAccess: true, platform: 'linux',
    env: { PATH: process.env.PATH, NODE_ENV: 'production' }, git: fakeGit([]), cgroup: () => '',
  });
  await instance.start(LATEST);
  const deadline = Date.now() + 10_000;
  while (instance.status().job!.phase === 'running' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  const job = instance.status().job!;
  assert.deepEqual([job.phase, job.message], ['failed', 'Build failed; Michi keeps running /old']);
  const log = fs.readFileSync(job.logFile, 'utf8');
  assert.match(log, new RegExp(`Building main bbbbbbbb \\(update --data-dir ${paths.dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} NODE_ENV=unset\\)`));
  assert.match(log, /\[michi-self-update exit 3\]/);
});

test('routes accept the owner (local app or remote token), refuse foreign origins, and validate the revision', async (t) => {
  const { instance, launches } = updater(t);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.headers.authorization === 'Bearer fixture') res.locals.remoteAccessAuthenticated = true;
    next();
  });
  app.use('/api', setupSelfUpdateRoutes(instance));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/self-update`;
  const post = (url: string, headers: Record<string, string>, body?: unknown) => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });

  assert.equal((await post(`${base}/start`, { origin: 'https://foreign.example' }, { revision: LATEST })).status, 403);
  assert.equal((await post(`${base}/check`, { origin: 'https://foreign.example' })).status, 403);
  const status = await fetch(base, { headers: { authorization: 'Bearer fixture' } });
  assert.equal(status.status, 200);
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.equal(((await status.json()) as { supported: boolean }).supported, true);
  assert.equal((await post(`${base}/check`, { authorization: 'Bearer fixture' })).status, 200);
  assert.equal((await post(`${base}/start`, { authorization: 'Bearer fixture' }, { revision: 'main' })).status, 400);
  assert.equal(launches.length, 0);
  const started = await post(`${base}/start`, { authorization: 'Bearer fixture' }, { revision: LATEST });
  assert.equal(started.status, 202);
  assert.equal(((await started.json()) as { job: { target: string } }).job.target, LATEST);
  const again = await post(`${base}/start`, { authorization: 'Bearer fixture' }, { revision: LATEST });
  assert.equal(again.status, 409);
  assert.equal(((await again.json()) as { code: string }).code, 'running');
});
