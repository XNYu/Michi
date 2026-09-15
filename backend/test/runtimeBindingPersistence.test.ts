import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb } from '../src/services/db';
import { saveWorkspace, saveNode, getNode, updateNodeResumeBinding, setNodeExternalSessionId } from '../src/services/dbRepository';
import { dbWorker, initDbWorker, shutdownDbWorker } from '../src/services/dbWorkerClient';
import { nativeResumeId } from '../src/services/nativeResume';

for (const worker of [false, true]) {
  test(`${worker ? 'worker' : 'sync'} binding commits native identity with its full settings`, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-runtime-binding-'));
    const old = process.env.MICHI_DATA_DIR;
    process.env.MICHI_DATA_DIR = directory;
    closeDb();
    initDb();
    t.after(async () => {
      await shutdownDbWorker();
      closeDb();
      if (old === undefined) delete process.env.MICHI_DATA_DIR;
      else process.env.MICHI_DATA_DIR = old;
      fs.rmSync(directory, { recursive: true, force: true });
    });
    saveWorkspace({ id: 'ws', name: 'test', created_at: 1, updated_at: 1 } as any);
    const node = { id: 'node', workspace_id: 'ws', title: 'Test node', kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 };
    saveNode(node as any);
    if (worker) await initDbWorker(path.join(directory, 'data.db'));
    const persist = (runtime: string, native: string, nodeId = 'node') => {
      const fields = { nodeId, acp_session_id: native, runtime_id: runtime, model_id: 'chosen-model',
        provider_id: null, reasoning: 'high', resume_fingerprint: null, current_mode_id: null };
      return worker ? dbWorker.persistResumeBinding(fields) : Promise.resolve().then(() => updateNodeResumeBinding(nodeId, fields));
    };
    for (const runtime of ['codex', 'claude']) {
      await persist(runtime, `native-${runtime}`);
      const row = getNode('node')!;
      assert.equal(row.acp_session_id, `native-${runtime}`);
      assert.equal(row.external_session_id, `native-${runtime}`);
      assert.equal(nativeResumeId(runtime, row), `native-${runtime}`);
      assert.equal(row.runtime_id, runtime);
      assert.equal(row.model_id, 'chosen-model');
      assert.equal(row.reasoning, 'high');
      saveNode({ ...node, external_session_id: 'stale-id', model_id: 'stale-model' } as any);
      assert.equal(getNode('node')?.external_session_id, `native-${runtime}`);
      assert.equal(getNode('node')?.model_id, 'chosen-model');
    }
    await persist('claude', 'node');
    assert.equal(getNode('node')?.external_session_id, null);
    assert.equal(nativeResumeId('claude', getNode('node')), null);
    setNodeExternalSessionId('node', 'claude-init');
    assert.equal(getNode('node')?.external_session_id, 'claude-init');
    assert.equal(getNode('node')?.acp_session_id, 'claude-init');
    await persist('kiro', 'native-kiro');
    saveNode({ ...node, external_session_id: 'stale-claude' } as any);
    assert.equal(getNode('node')?.external_session_id, null);
    assert.equal(nativeResumeId('kiro', getNode('node')), 'native-kiro');
    await assert.rejects(persist('codex', 'native', 'missing'), /does not exist/);
    assert.throws(() => setNodeExternalSessionId('missing', 'native'), /does not exist/);
  });
}
