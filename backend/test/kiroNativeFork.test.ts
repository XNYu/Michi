import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpClient } from '../src/services/acpClient';
import { KiroRuntime } from '../src/agents/kiro/KiroRuntime';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import { NativeResumeUnavailableError } from '../src/services/nativeResume';
import { closeDb, initDb } from '../src/services/db';

for (const supported of [true, false]) {
  test(`v3 cold fork negotiates the child worker before checking fork support (${supported})`, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-v3-fork-'));
    const previousDataDir = process.env.MICHI_DATA_DIR;
    process.env.MICHI_DATA_DIR = directory;
    closeDb();
    initDb();
    const clients: AcpClient[] = [];
    let forks = 0;
    t.mock.method(AcpClient.prototype, 'start', function(this: AcpClient) { clients.push(this); });
    t.mock.method(AcpClient.prototype, 'isAlive', () => true);
    t.mock.method(AcpClient.prototype, 'initialize', async function(this: AcpClient) {
      (this as any).initialization = { agentCapabilities: {
        loadSession: true, sessionCapabilities: supported ? { fork: {} } : {},
      } };
    });
    t.mock.method(AcpClient.prototype, 'loadSession', async () => ({}));
    t.mock.method(AcpClient.prototype, 'forkSession', async () => { forks++; return 'native-child'; });
    t.mock.method(AcpClient.prototype, 'shutdown', async () => {});
    const runtime = new KiroRuntime({} as AgentToolBridge, undefined, 0, directory, undefined, { engine: 'v3' });
    try {
      assert.equal(runtime.capabilityDescriptor.sessionFork.availability, 'invisible');
      const pending = runtime.forkSession({ sessionId: 'child', sourceNativeSessionId: 'parent-native', cwd: directory });
      if (supported) {
        const child = await pending;
        assert.equal(child.id, 'child');
        assert.equal(child.nativeSessionId, 'native-child');
        assert.deepEqual(child.getNativeResumeToken?.(), { engine: 'v3', sessionId: 'native-child' });
        assert.equal(runtime.getBinding('child')?.nativeSessionId, 'native-child');
        assert.equal(forks, 1);
      } else {
        await assert.rejects(pending, NativeResumeUnavailableError);
        assert.equal(forks, 0);
        assert.equal(runtime.getBinding('child'), undefined);
      }
      assert.equal(clients.length, 1, 'one independent child process negotiates support');
    } finally {
      await runtime.shutdown();
      closeDb();
      fs.rmSync(directory, { recursive: true, force: true });
      if (previousDataDir === undefined) delete process.env.MICHI_DATA_DIR;
      else process.env.MICHI_DATA_DIR = previousDataDir;
    }
  });
}
