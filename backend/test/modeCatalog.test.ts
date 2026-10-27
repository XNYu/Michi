import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatManager } from '../src/services/chatManager';
import type { KiroRuntime } from 'michi-runtime/internal/adapters/kiro/KiroRuntime';

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
