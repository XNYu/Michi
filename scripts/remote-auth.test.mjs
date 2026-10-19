import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteAuthenticationProcess } from '../electron/remoteAuthentication.ts';
import { SIGN_IN_COMMANDS } from '../electron/remoteCredentials.ts';
import { REMOTE_CREDENTIALS } from '../shared/src/remoteCredentials.ts';

const commands = { local: ['example-login', '--refresh'], remote: ['example-login', '--remote'] };

test('authentication uses fixed argv for local sign-in or remote SSH with strict host checks', () => {
  assert.deepEqual(remoteAuthenticationProcess({ scope: 'local', host: 'build+' }, commands), { binary: 'example-login', args: ['--refresh'] });
  const remote = remoteAuthenticationProcess({ scope: 'remote', host: 'build+', user: 'builder', port: 2222 }, commands);
  assert.equal(remote.binary, 'ssh');
  assert.deepEqual(remote.args.slice(-4, -1), ['-p', '2222', 'builder@build+']);
  assert.ok(remote.args.includes('StrictHostKeyChecking=yes'));
  assert.match(remote.args.at(-1), /exec example-login --remote$/);
});
test('remote sign-in is refused when the build has no remote command', () => {
  assert.throws(() => remoteAuthenticationProcess({ scope: 'remote', host: 'build+' }, { ...commands, remote: null }), /not available/);
});
test('native terminal commands match the shared remote credential provider', () => {
  assert.deepEqual(SIGN_IN_COMMANDS, { local: REMOTE_CREDENTIALS.localCommand, remote: REMOTE_CREDENTIALS.remoteCommand });
});
test('authentication rejects shell injection, SSH options and invalid ports', () => {
  for (const bad of [null, {}, { scope: 'other', host: 'host' }, { scope: 'local', host: '-oProxyCommand=x' },
    { scope: 'remote', host: 'host;id' }, { scope: 'remote', host: 'host', user: 'u;id' }, { scope: 'remote', host: 'host', user: '-F' },
    { scope: 'remote', host: 'host', port: 0 }, { scope: 'remote', host: 'host', port: 65536 }]) assert.throws(() => remoteAuthenticationProcess(bad, commands));
});
