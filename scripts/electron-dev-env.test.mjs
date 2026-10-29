import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { devDataEnvironment, electronDevEnvironment } from './electron-dev-env.mjs';

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

test('runtime/model preferences follow the development data directory, not the installed app', () => {
  // agentConfig and prefsConfig read MICHI_CONFIG_DIR, defaulting to ~/.michi.
  // Without this, a dev backend rewrites the installed app's runtime and model.
  assert.equal(electronDevEnvironment(path.resolve('rabbitholes'), {}).MICHI_CONFIG_DIR, path.join(os.homedir(), '.michi-dev'));
  const preview = path.resolve('preview-data');
  assert.equal(electronDevEnvironment(path.resolve('rabbitholes'), { MICHI_DATA_DIR: preview }).MICHI_CONFIG_DIR, preview);
});

test('explicit development data, config, instance and Electron profile overrides are preserved', () => {
  const env = {
    MICHI_DATA_DIR: path.resolve('preview-data'),
    MICHI_CONFIG_DIR: path.resolve('preview-config'),
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

test('run as a script, it prints the variables it sets for shell launchers', () => {
  const root = path.resolve('rabbitholes');
  const dataDir = path.resolve('preview-data');
  const { MICHI_CONFIG_DIR, MICHI_DEV_INSTANCE_ID, MICHI_ELECTRON_USER_DATA_DIR, ...env } = process.env;
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('./electron-dev-env.mjs', import.meta.url)), root], {
    encoding: 'utf8',
    env: { ...env, MICHI_DATA_DIR: dataDir, MICHI_CONFIG_DIR: '' },
  });
  const expected = electronDevEnvironment(root, { MICHI_DATA_DIR: dataDir });
  assert.deepEqual(output.trim().split('\n').sort(), [
    `MICHI_CONFIG_DIR=${expected.MICHI_CONFIG_DIR}`,
    `MICHI_DEV_INSTANCE_ID=${expected.MICHI_DEV_INSTANCE_ID}`,
    `MICHI_ELECTRON_USER_DATA_DIR=${expected.MICHI_ELECTRON_USER_DATA_DIR}`,
  ]);
});

test('development data defaults treat an empty variable as unset, like the old shell defaults', () => {
  const home = path.join(os.homedir(), '.michi-dev');
  assert.deepEqual(devDataEnvironment({}), { MICHI_DATA_DIR: home, MICHI_CONFIG_DIR: home });
  assert.deepEqual(devDataEnvironment({ MICHI_DATA_DIR: '', MICHI_CONFIG_DIR: '' }), { MICHI_DATA_DIR: home, MICHI_CONFIG_DIR: home });
  const env = { MICHI_DATA_DIR: path.resolve('preview-data'), MICHI_CONFIG_DIR: path.resolve('preview-config'), PORT: '3010' };
  assert.deepEqual(devDataEnvironment(env), env);
});

test('root dev scripts apply the data defaults in Node, not with POSIX-only shell syntax', () => {
  // npm runs package.json scripts with cmd.exe on Windows.
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const name of ['dev', 'backend:dev']) {
    assert.doesNotMatch(scripts[name], /\$\{|MICHI_(DATA|CONFIG)_DIR=/, name);
    assert.match(scripts[name], /node scripts\/dev\.mjs/, name);
  }
});
