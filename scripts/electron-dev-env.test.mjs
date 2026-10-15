import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { electronDevEnvironment } from './electron-dev-env.mjs';

test('same-named checkouts get different Electron user data and instance locks', () => {
  const main = electronDevEnvironment(path.resolve('main', 'rabbitholes'), {});
  const worktree = electronDevEnvironment(path.resolve('worktrees', 'rabbitholes'), {});
  assert.notEqual(main.MICHI_DEV_INSTANCE_ID, worktree.MICHI_DEV_INSTANCE_ID);
  assert.notEqual(main.MICHI_ELECTRON_USER_DATA_DIR, worktree.MICHI_ELECTRON_USER_DATA_DIR);
  assert.equal(main.MICHI_DATA_DIR, worktree.MICHI_DATA_DIR);
});

test('restarting the same checkout reuses its Electron profile', () => {
  const root = path.resolve('worktrees', 'rabbitholes');
  assert.deepEqual(electronDevEnvironment(root, {}), electronDevEnvironment(path.join(root, '.'), {}));
});

test('explicit development data, instance and Electron profile overrides are preserved', () => {
  const env = {
    MICHI_DATA_DIR: path.resolve('preview-data'),
    MICHI_DEV_INSTANCE_ID: 'crew-preview',
    MICHI_ELECTRON_USER_DATA_DIR: path.resolve('electron-profile'),
    PORT: '3010',
  };
  assert.deepEqual(electronDevEnvironment(path.resolve('rabbitholes'), env), env);
});

test('an explicit instance name selects its profile beneath the selected data directory', () => {
  const env = { MICHI_DATA_DIR: path.resolve('preview-data'), MICHI_DEV_INSTANCE_ID: 'crew-preview' };
  assert.equal(
    electronDevEnvironment(path.resolve('rabbitholes'), env).MICHI_ELECTRON_USER_DATA_DIR,
    path.join(env.MICHI_DATA_DIR, 'electron-crew-preview'),
  );
});
