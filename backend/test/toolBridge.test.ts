import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentToolBridge } from '../src/agents/toolBridge';

const tmpDirs: string[] = [];

function mkTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-tool-bridge-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('AgentToolBridge contexts', () => {
  test('saveContext creates a context file and updateContext rewrites it', () => {
    const cwd = mkTmpDir();
    const bridge = createAgentToolBridge({ createChild: async () => 'child-1' });

    const saved = bridge.saveContext({ cwd, name: 'notes', body: 'v1' });
    assert.deepEqual(saved, { name: 'notes', filePath: '.contexts/notes.md', size: 2 });
    assert.equal(fs.readFileSync(path.join(cwd, '.contexts/notes.md'), 'utf-8'), 'v1');

    const updated = bridge.updateContext({ cwd, name: 'notes', body: 'version two' });
    assert.deepEqual(updated, { name: 'notes', filePath: '.contexts/notes.md', size: 11 });
    assert.equal(fs.readFileSync(path.join(cwd, '.contexts/notes.md'), 'utf-8'), 'version two');
  });

  test('updateContext rejects missing or invalid contexts', () => {
    const cwd = mkTmpDir();
    const bridge = createAgentToolBridge({ createChild: async () => 'child-1' });

    assert.equal(bridge.updateContext({ cwd, name: 'missing', body: 'new' }), null);
    assert.equal(bridge.updateContext({ cwd, name: '../bad', body: 'new' }), null);
  });
});
