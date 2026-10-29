import { afterEach, beforeEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeBash } from '../src/agents/tools/bash';
import * as processes from '../src/agents/processTree';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';

const SENTINEL = 'MICHI_TEST_BASH_SENTINEL_SECRET';
const saved = { cloud: process.env.MICHI_CLOUD, sentinel: process.env[SENTINEL] };
let dir: string;

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function countSpawns(t: TestContext) {
  const spawn = processes.spawnAgentProcess;
  const calls = { count: 0 };
  t.mock.method(processes, 'spawnAgentProcess', (...args: Parameters<typeof spawn>) => {
    calls.count += 1;
    return spawn(...args);
  });
  return calls;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-bash-cloud-env-'));
});

afterEach(() => {
  restore('MICHI_CLOUD', saved.cloud);
  restore(SENTINEL, saved.sentinel);
  __resetRuntimeDeps();
  fs.rmSync(dir, { recursive: true, force: true });
});

for (const ownerUserId of [undefined, null, '', '   ']) {
  test(`cloud bash without an owner (${JSON.stringify(ownerUserId)}) fails closed and never spawns`, { skip: process.platform === 'win32' }, async (t) => {
    process.env.MICHI_CLOUD = '1';
    const spawns = countSpawns(t);
    const marker = path.join(dir, 'ran');
    const result = await executeBash({ command: `touch '${marker}'` }, dir, { ownerUserId });
    assert.equal(result.isError, true);
    assert.match(result.content.map((part) => ('text' in part ? part.text : '')).join(''), /owner/i);
    assert.equal(spawns.count, 0, 'no subprocess may be created');
    assert.equal(fs.existsSync(marker), false, 'the command must not run');
  });
}

test('cloud bash with an owner keeps the allowlist and hides parent secrets', { skip: process.platform === 'win32' }, async (t) => {
  process.env.MICHI_CLOUD = '1';
  process.env[SENTINEL] = 'parent-secret-value';
  configureRuntimeDeps({ historyStore: {} as any, agentConfig: {} as any, dataDir: dir });
  const spawns = countSpawns(t);
  const result = await executeBash(
    { command: `printf 'sentinel=%s home=%s' "\${${SENTINEL}-unset}" "$HOME"` },
    dir,
    { ownerUserId: 'owner-1' },
  );
  const text = result.content.map((part) => ('text' in part ? part.text : '')).join('');
  assert.equal(result.isError, false, text);
  assert.equal(spawns.count, 1);
  assert.ok(text.includes('sentinel=unset'), text);
  assert.ok(!text.includes('parent-secret-value'), text);
  assert.ok(text.includes(`home=${path.join(dir, 'user-cwds', 'owner-1')}`), text);
});
