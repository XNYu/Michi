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
  test('persists context metadata with the owning chat after writing the file', () => {
    const cwd = mkTmpDir();
    const mutations: Array<{ chatId: string; name: string; filePath: string; size: number }> = [];
    const bridge = createAgentToolBridge({
      createChild: async () => ({ chatId: 'child-1', nodeId: 'node-1' }),
      persistContext: (context) => { mutations.push(context); },
    });

    bridge.saveContext({ cwd, chatId: 'chat-parent', name: 'notes', body: 'v1' });
    bridge.updateContext({ cwd, chatId: 'chat-parent', name: 'notes', body: 'version two' });

    assert.deepEqual(mutations, [
      { chatId: 'chat-parent', name: 'notes', filePath: '.contexts/notes.md', size: 2 },
      { chatId: 'chat-parent', name: 'notes', filePath: '.contexts/notes.md', size: 11 },
    ]);
  });

  test('does not report success when durable metadata cannot be recorded', () => {
    const cwd = mkTmpDir();
    const bridge = createAgentToolBridge({
      createChild: async () => ({ chatId: 'child-1', nodeId: 'node-1' }),
      persistContext: () => false,
    });

    assert.equal(bridge.saveContext({ cwd, chatId: 'chat-parent', name: 'notes', body: 'v1' }), null);
    assert.equal(fs.readFileSync(path.join(cwd, '.contexts/notes.md'), 'utf-8'), 'v1');
  });

  test('returns the durable context id in save and update results', () => {
    const cwd = mkTmpDir();
    const bridge = createAgentToolBridge({
      createChild: async () => ({ chatId: 'child-1', nodeId: 'node-1' }),
      persistContext: () => 'ctx-durable',
    });

    assert.deepEqual(
      bridge.saveContext({ cwd, chatId: 'chat-parent', name: 'notes', body: 'v1' }),
      { id: 'ctx-durable', name: 'notes', filePath: '.contexts/notes.md', size: 2 },
    );
    assert.deepEqual(
      bridge.updateContext({ cwd, chatId: 'chat-parent', name: 'notes', body: 'version two' }),
      { id: 'ctx-durable', name: 'notes', filePath: '.contexts/notes.md', size: 11 },
    );
  });

  test('saveContext creates a context file and updateContext rewrites it', () => {
    const cwd = mkTmpDir();
    const bridge = createAgentToolBridge({ createChild: async () => ({ chatId: 'child-1', nodeId: 'node-1' }) });

    const saved = bridge.saveContext({ cwd, name: 'notes', body: 'v1' });
    assert.deepEqual(saved, { name: 'notes', filePath: '.contexts/notes.md', size: 2 });
    assert.equal(fs.readFileSync(path.join(cwd, '.contexts/notes.md'), 'utf-8'), 'v1');

    const updated = bridge.updateContext({ cwd, name: 'notes', body: 'version two' });
    assert.deepEqual(updated, { name: 'notes', filePath: '.contexts/notes.md', size: 11 });
    assert.equal(fs.readFileSync(path.join(cwd, '.contexts/notes.md'), 'utf-8'), 'version two');
  });

  test('updateContext rejects missing or invalid contexts', () => {
    const cwd = mkTmpDir();
    const bridge = createAgentToolBridge({ createChild: async () => ({ chatId: 'child-1', nodeId: 'node-1' }) });

    assert.equal(bridge.updateContext({ cwd, name: 'missing', body: 'new' }), null);
    assert.equal(bridge.updateContext({ cwd, name: '../bad', body: 'new' }), null);
  });
});

describe('AgentToolBridge spawned identity', () => {
  test('returns the backend-created nodeId together with chatId', async () => {
    const bridge = createAgentToolBridge({
      createChild: async () => ({ chatId: 'chat-child', nodeId: 'node-child' }),
    });
    const created = await bridge.spawnBranches({
      parentChatId: 'parent', cwd: mkTmpDir(), enableFollowUps: true,
      topics: [{ title: 'Child', prompt: 'Investigate' }],
    });
    assert.deepEqual(created, [{
      title: 'Child', prompt: 'Investigate', chatId: 'chat-child', nodeId: 'node-child',
    }]);
  });

  test('passes the durable title and pending prompt into child creation', async () => {
    let argsSeen: Record<string, unknown> | undefined;
    const bridge = createAgentToolBridge({
      createChild: async (args) => {
        argsSeen = args;
        return { chatId: 'chat-child', nodeId: 'node-child' };
      },
    });

    await bridge.spawnBranches({
      parentChatId: 'parent', cwd: mkTmpDir(), enableFollowUps: false, ownerUserId: 'owner-1',
      topics: [{ title: 'Durable child title', prompt: 'Durable child prompt' }],
    });

    assert.deepEqual(argsSeen, {
      parentChatId: 'parent',
      cwd: argsSeen?.cwd,
      enableFollowUps: false,
      ownerUserId: 'owner-1',
      title: 'Durable child title',
      prompt: 'Durable child prompt',
    });
  });
});
