import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { getMichiConfigPaths } from '../src/services/configPaths';

test('config paths default to the home profile when no override is set', () => {
  const home = path.join('fixture', 'home');
  const configDir = path.join(home, '.michi');
  assert.deepEqual(getMichiConfigPaths({}, home), { configDir, configPath: path.join(configDir, 'config.json') });
  assert.deepEqual(getMichiConfigPaths({ MICHI_CONFIG_DIR: '' }, home), getMichiConfigPaths({}, home));
});

test('config paths preserve the selected config directory', () => {
  const configDir = path.join('fixture', 'preview-profile');
  assert.deepEqual(getMichiConfigPaths({ MICHI_CONFIG_DIR: configDir }, 'unused-home'), {
    configDir,
    configPath: path.join(configDir, 'config.json'),
  });
});
