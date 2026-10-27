import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

const BACKEND_DIR = path.resolve(__dirname, '..');

/**
 * Express 5 passes bind errors to the listen callback instead of throwing, so
 * a backend that lost the race for its port used to log "listening" and stay
 * up with no listener: runtimes running, scheduler lease held, unreachable.
 */
describe('server listen failure', () => {
  let holder: net.Server;
  let port: number;
  let tmpDir: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-listen-failure-'));
    holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    port = (holder.address() as net.AddressInfo).port;
  });

  after(async () => {
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('exits with an error instead of running without a listener', { timeout: 60_000 }, async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(port),
      MICHI_BIND_HOST: '127.0.0.1',
      MICHI_DATA_DIR: path.join(tmpDir, 'data'),
      MICHI_CONFIG_DIR: path.join(tmpDir, 'data'),
      MICHI_LOG_DIR: path.join(tmpDir, 'logs'),
      MICHI_ENABLED_RUNTIMES: 'pi',
      // Type-checking the whole server graph takes longer than the test budget;
      // `tsc --noEmit` in the build already covers types.
      TS_NODE_TRANSPILE_ONLY: '1',
    };
    delete env.MICHI_REMOTE_ACCESS;
    delete env.MICHI_REQUIRE_AUTH;
    delete env.MICHI_CLOUD;

    const child = spawn(process.execPath, ['--experimental-sqlite', '--require', 'ts-node/register', 'src/server.ts'], {
      cwd: BACKEND_DIR,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 45_000);
    const code = await new Promise<number | null>((resolve) => child.on('exit', (exitCode) => resolve(exitCode)));
    clearTimeout(killTimer);

    assert.equal(code, 1, 'the backend should exit 1 when its port is taken');
    const backendLog = fs.readFileSync(path.join(tmpDir, 'logs', 'backend.log'), 'utf8');
    assert.match(backendLog, /listen failed; exiting .*code=EADDRINUSE/);
    assert.doesNotMatch(backendLog, /boot\s+listening port=/);
    assert.doesNotMatch(backendLog, /scheduled jobs started/);
  });
});
