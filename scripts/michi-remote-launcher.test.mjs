import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = `const { execFileSync } = require('node:child_process');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
require('node:http').createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ status: 'healthy', service: 'michi-backend', build: { revision } }));
}).listen(Number(process.env.PORT), process.env.MICHI_BIND_HOST);
`;

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(work, server, message) {
  writeFileSync(path.join(work, 'backend/dist/server.js'), server);
  writeFileSync(path.join(work, 'CHANGES'), `${message}\n`);
  git(work, 'add', '-A');
  git(work, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', message);
  git(work, 'push', '-q', 'origin', 'HEAD:dev');
  return git(work, 'rev-parse', 'HEAD');
}

// A source repository whose server.js answers /api/health with its own
// revision, and a running installation of its first commit.
async function installation() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'michi-launcher-')));
  const home = path.join(root, 'home');
  const source = path.join(root, 'source.git');
  const work = path.join(root, 'work');
  git(root, 'init', '-q', '--bare', source);
  git(root, 'clone', '-q', source, work);
  git(work, 'checkout', '-q', '-b', 'dev');
  mkdirSync(path.join(work, 'scripts'), { recursive: true });
  mkdirSync(path.join(work, 'bin'));
  mkdirSync(path.join(work, 'backend/dist'), { recursive: true });
  copyFileSync(path.join(REPO, 'scripts/remote-control.mjs'), path.join(work, 'scripts/remote-control.mjs'));
  copyFileSync(path.join(REPO, 'bin/michi'), path.join(work, 'bin/michi'));
  chmodSync(path.join(work, 'bin/michi'), 0o755);
  writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'fake-michi', version: '1.0.0', private: true, scripts: { 'remote:setup': 'node -e ""' } }));
  const first = commit(work, SERVER, 'first');
  const old = path.join(home, '.local/share/michi/devdesktop/source');
  git(root, 'clone', '-q', '--branch', 'dev', source, old);

  const env = { ...process.env, HOME: home, MICHI_REMOTE_SOURCE_URL: source };
  for (const key of ['PORT', 'MICHI_DATA_DIR', 'MICHI_REMOTE_TOKEN', 'MICHI_BIND_HOST']) delete env[key];
  const michi = (...args) => spawnSync(path.join(home, '.local/bin/michi'), args, { env, encoding: 'utf8' });
  const launched = spawnSync(process.execPath, ['scripts/remote-control.mjs', 'launch', '--no-setup', '--port', String(await freePort())], {
    cwd: old, env: { ...env, MICHI_REMOTE_TOKEN: 'launcher-test-token-0123456789' }, encoding: 'utf8',
  });
  assert.equal(launched.status, 0, launched.stderr);
  return { root, home, work, old, first, michi, cleanup: () => { michi('stop'); rmSync(root, { recursive: true, force: true }); } };
}

test('michi update builds the new revision beside the running backend and switches to it', async () => {
  const fixture = await installation();
  try {
    assert.equal(readlinkSync(path.join(fixture.home, '.local/bin/michi')), path.join(fixture.old, 'bin/michi'));
    assert.match(fixture.michi('status').stdout, new RegExp(`revision: ${fixture.first}`));
    const second = commit(fixture.work, SERVER, 'second');

    const updated = fixture.michi('update');
    assert.equal(updated.status, 0, updated.stderr);
    const status = fixture.michi('status').stdout;
    assert.match(status, new RegExp(`revision: ${second}`));
    const link = readlinkSync(path.join(fixture.home, '.local/bin/michi'));
    assert.match(path.basename(path.dirname(path.dirname(link))), new RegExp(`^${second}-`));
    const record = JSON.parse(readFileSync(path.join(fixture.home, '.michi/remote-installation.json'), 'utf8'));
    assert.equal(record.serverPath, path.join(path.dirname(path.dirname(link)), 'backend/dist/server.js'));
    assert.match(fixture.michi('update').stdout, /already at dev/);
  } finally {
    fixture.cleanup();
  }
});

test('michi update restarts the old build when the new one does not start', { timeout: 60_000 }, async () => {
  const fixture = await installation();
  try {
    commit(fixture.work, 'process.exit(1);\n', 'broken');

    const updated = fixture.michi('update');
    assert.notEqual(updated.status, 0);
    assert.match(updated.stderr, /did not start; restarted/);
    assert.match(fixture.michi('status').stdout, new RegExp(`revision: ${fixture.first}`));
    assert.equal(readlinkSync(path.join(fixture.home, '.local/bin/michi')), path.join(fixture.old, 'bin/michi'));
  } finally {
    fixture.cleanup();
  }
});
