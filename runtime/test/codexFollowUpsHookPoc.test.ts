import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';

import os from 'node:os';
import path from 'node:path';

import { buildCodexFollowUpsHookPocConfig, prepareCodexFollowUpsHookPocEnv } from '../src/adapters/codex/codexFollowUpsHookPoc';
import { CODEX_STOP_HOOK_RUNNER as runnerPath } from './helpers/adapterPaths';

test('the Stop hook config refuses an empty slot id or endpoint', () => {
  const endpoint = 'http://127.0.0.1:3001/api/codex-hooks/slot-1/stop';
  assert.throws(() => buildCodexFollowUpsHookPocConfig('', endpoint, { runnerPath }), /requires an MCP slot id/);
  assert.throws(() => buildCodexFollowUpsHookPocConfig('slot-1', '', { runnerPath }), /requires a Stop hook endpoint/);
  assert.equal(buildCodexFollowUpsHookPocConfig('slot-1', endpoint, { runnerPath }).bypass_hook_trust, true);
});

test('without a runnerPath the Stop hook runs the adapter\'s own runner', () => {
  const config = buildCodexFollowUpsHookPocConfig('slot-1', 'http://127.0.0.1:3001/api/codex-hooks/slot-1/stop') as {
    hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
  };
  assert.ok(fs.existsSync(runnerPath), runnerPath);
  assert.ok(config.hooks.Stop[0].hooks[0].command.includes(` '${runnerPath}' `), config.hooks.Stop[0].hooks[0].command);
});

test('isolated CODEX_HOME shares auth only and does not copy user hook config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-codex-hook-home-test-'));
  const sourceHome = path.join(root, 'user-codex');
  const dataDir = path.join(root, 'michi-data');
  fs.mkdirSync(sourceHome, { recursive: true });
  fs.writeFileSync(path.join(sourceHome, 'auth.json'), '{"token":"test"}');
  fs.writeFileSync(path.join(sourceHome, 'config.toml'), '[[hooks.Stop]]\n');

  try {
    const isolatedHome = path.join(dataDir, 'codex-follow-ups-hook-poc');
    const env = prepareCodexFollowUpsHookPocEnv(
      { CODEX_HOME: sourceHome, PROVIDER_KEY: 'kept' },
      { codexHome: sourceHome, isolatedHome },
    );

    assert.equal(env.CODEX_HOME, isolatedHome);
    assert.equal(env.PROVIDER_KEY, 'kept');
    assert.equal(fs.readFileSync(path.join(isolatedHome, 'auth.json'), 'utf8'), '{"token":"test"}');
    assert.equal(fs.existsSync(path.join(isolatedHome, 'config.toml')), false);
    assert.equal(fs.existsSync(path.join(isolatedHome, 'hooks.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
