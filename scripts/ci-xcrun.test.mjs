import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const shim = fileURLToPath(new URL('./ci/bin/xcrun', import.meta.url));
function invoke(args, statuses) {
  const result = spawnSync('/bin/bash', ['-c', `
    source "$1"
    shift
    calls=0
    tool() {
      calls=$((calls + 1))
      printf 'call:%s\\n' "$*"
      local statuses=(${statuses.join(' ')})
      return "\u0024{statuses[calls-1]:-0}"
    }
    sleep() { printf 'sleep:%s\\n' "$1"; }
    xcrun_with_retry tool "$@"
  `, 'test', shim, ...args], { encoding: 'utf8' });
  assert.ifError(result.error);
  return result;
}

test('recovers ticket delivery and preserves paths with spaces', () => {
  const r = invoke(['stapler', 'staple', '-v', '/tmp/My App.app'], [68, 68, 0]);
  assert.equal(r.status, 0);
  assert.equal((r.stdout.match(/call:stapler staple -v \/tmp\/My App.app/g) || []).length, 3);
  assert.match(r.stdout, /sleep:15/);
  assert.match(r.stdout, /sleep:30/);
});

test('stops after five failed attempts and propagates failure', () => {
  const r = invoke(['stapler', 'staple', 'app.dmg'], [68, 68, 68, 68, 68]);
  assert.equal(r.status, 68);
  assert.equal((r.stdout.match(/call:/g) || []).length, 5);
  assert.equal((r.stdout.match(/sleep:/g) || []).length, 4);
});

for (const [args, status] of [
  [['stapler', 'staple', 'app.dmg'], 65],
  [['stapler', 'validate', 'app.dmg'], 68],
  [['notarytool', 'submit', 'app.dmg'], 68],
  [['--find', 'notarytool'], 1],
]) {
  test(`does not retry ${args.join(' ')} exit ${status}`, () => {
    const r = invoke(args, [status]);
    assert.equal(r.status, status);
    assert.equal((r.stdout.match(/call:/g) || []).length, 1);
    assert.doesNotMatch(r.stdout, /sleep:/);
  });
}
