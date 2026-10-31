import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';

const childProcess = require('node:child_process') as typeof import('node:child_process');

test('public source update discovery uses origin/main and tolerates missing tracking refs', async (t) => {
  const calls: string[][] = [];
  let remotes = 'origin\nbackup';
  let hasTrackingRef = true;
  const exec = async (command: string, args: string[]) => {
    assert.equal(command, 'git');
    calls.push(args);
    const key = args.join(' ');
    if (key === 'remote') return { stdout: remotes };
    if (key === 'rev-parse --short HEAD') return { stdout: '1234567' };
    if (key === 'log -1 --format=%ci') return { stdout: '2026-10-28 00:00:00 +0000' };
    if (key === 'rev-parse --verify refs/remotes/origin/main') {
      if (!hasTrackingRef) throw new Error('missing tracking ref');
      return { stdout: '7654321' };
    }
    if (key === 'ls-remote origin HEAD') return { stdout: '7654321000000000000000000000000000000000\tHEAD' };
    if (key === 'rev-list --count HEAD..origin/main') return { stdout: '2' };
    throw new Error(`Unexpected Git operation: ${key}`);
  };
  const original = childProcess.execFile;
  childProcess.execFile = Object.assign(() => { throw new Error('expected promisified execution'); }, {
    [promisify.custom]: exec,
  }) as unknown as typeof childProcess.execFile;
  t.after(() => { childProcess.execFile = original; });
  const { setupVersionRoutes } = require('../src/routes/version') as typeof import('../src/routes/version');
  const router = setupVersionRoutes();
  const route = router.stack.find((layer) => layer.route?.path === '/version')!.route!;
  const handler = route.stack[0].handle;
  const read = async () => {
    let payload: Record<string, unknown> | undefined;
    const response = {
      json: (value: Record<string, unknown>) => { payload = value; },
      status: (code: number) => { assert.fail(`Unexpected HTTP ${code}`); },
    };
    await handler({} as never, response as never, () => {});
    return payload!;
  };

  assert.deepEqual(await read(), {
    localHash: '1234567', localDate: '2026-10-28 00:00:00 +0000',
    remoteHash: '7654321', remoteName: 'origin', updateAvailable: true, updateAllowed: false,
  });
  assert.ok(calls.some((args) => args.join(' ') === 'rev-list --count HEAD..origin/main'));
  calls.length = 0;
  remotes = 'backup';
  assert.equal((await read()).remoteName, null);
  assert.ok(!calls.some((args) => args[0] === 'ls-remote'));
  remotes = 'origin';
  hasTrackingRef = false;
  assert.equal((await read()).updateAvailable, false);
  assert.ok(calls.every((args) => !['fetch', 'reset', 'update-ref'].includes(args[0])));
});
