import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatManager } from '../src/services/chatManager';
import type { KiroRuntime } from '../src/agents/kiro/KiroRuntime';

test('mode catalog returns a known workspace default without waiting for another warm session', async () => {
  const modes = [{ id: 'vibe', name: 'Default' }];
  let warmCalls = 0;
  const runtime = {
    getDefaultModeId: () => 'vibe',
    getAvailableModes: async () => modes,
    warm: () => { warmCalls++; return new Promise(() => {}); },
  } as unknown as KiroRuntime;
  assert.deepEqual(await new ChatManager(runtime).getModeCatalog('/tmp/known'), {
    availableModes: modes, defaultModeId: 'vibe',
  });
  assert.equal(warmCalls, 0);
});

test('mode catalog discovers the fresh default separately for each workspace', async () => {
  const defaults = new Map<string, string>();
  const warmed: string[] = [];
  const runtime = {
    getDefaultModeId: (cwd: string) => defaults.get(cwd) ?? null,
    getAvailableModes: async () => [{ id: 'vibe', name: 'Default' }, { id: 'plan', name: 'Plan' }],
    warm: async (cwd: string) => { warmed.push(cwd); defaults.set(cwd, cwd === '/tmp/a' ? 'vibe' : 'plan'); },
  } as unknown as KiroRuntime;
  const manager = new ChatManager(runtime);
  assert.equal((await manager.getModeCatalog('/tmp/a')).defaultModeId, 'vibe');
  assert.equal((await manager.getModeCatalog('/tmp/b')).defaultModeId, 'plan');
  await manager.getModeCatalog('/tmp/a');
  assert.deepEqual(warmed, ['/tmp/a', '/tmp/b']);
});
