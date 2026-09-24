import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { AgentRuntime, AgentSession } from '../src/agents/types';

// Explicit opt-in: real CLI processes and three conversation turns per runtime.
const enabled = (process.env.MICHI_NATIVE_FORK_SMOKE ?? '').split(',');
for (const runtimeId of ['codex', 'claude']) {
  test(`real ${runtimeId} fork inherits native history and resumes the independent child`, {
    skip: !enabled.includes(runtimeId), timeout: 180_000,
  }, async () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `michi-native-fork-${runtimeId}-`)));
    const priorEnv = { ...process.env };
    Object.assign(process.env, { MICHI_DATA_DIR: directory, MICHI_CLAUDE_POOL_DISABLED: '1',
      MICHI_CLAUDE_BARE: '1', MICHI_CLAUDE_STRICT_MCP: '1', MICHI_TITLE_MODEL_CODEX: 'off',
      MICHI_TITLE_MODEL_CLAUDE: 'off', MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC: '0',
      MICHI_CODEX_FOLLOW_UPS_HOOK_POC: '0' });
    delete process.env.MICHI_CLOUD;
    const { closeDb, getDb, initDb } = require('../src/services/db') as typeof import('../src/services/db');
    const repo = require('../src/services/dbRepository') as typeof import('../src/services/dbRepository');
    const { configureRuntimeDeps, __resetRuntimeDeps } = require('../src/agents/runtimeDeps') as typeof import('../src/agents/runtimeDeps');
    const { clearAllSessions } = require('../src/agents/sessionRegistry') as typeof import('../src/agents/sessionRegistry');
    const config = require('../src/services/agentConfig') as typeof import('../src/services/agentConfig');
    const { McpSlotRegistry, mountMcp } = require('../src/services/mcpServer') as typeof import('../src/services/mcpServer');
    const { tryForkChatSession } = require('../src/services/nativeFork') as typeof import('../src/services/nativeFork');
    closeDb(); initDb();
    configureRuntimeDeps({ historyStore: { getNode: repo.getNode, listMessages: repo.listMessages,
      getWorkspace: repo.getWorkspace, getWorkspaceInstructions: repo.getWorkspaceInstructions,
      hasGrant: repo.hasGrant, grantPermission: repo.grantPermission }, dataDir: directory,
      providerKeys: { getProviderApiKey: () => null },
      agentConfig: { getAgentConfig: config.getAgentConfig, resolveModel: config.resolveModel, resolveReasoning: config.resolveReasoning } });
    const registry = new McpSlotRegistry();
    const app = express(); app.use(express.json());
    const router = express.Router(); mountMcp(router, registry); app.use('/api', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    let runtime: AgentRuntime | undefined;
    const timer = setTimeout(() => { void runtime?.shutdown(); }, 150_000);
    const bridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null };
    const nodeId = `fork-smoke-${randomUUID()}`;
    const childId = `fork-smoke-${randomUUID()}`;
    const token = `FORKCHECK_${randomUUID().replace(/-/g, '')}`;
    const options = { cwd: directory, workspaceId: 'smoke', enableFollowUps: false, reasoning: 'low' as const };
    async function answer(session: AgentSession, prompt: string) {
      let text = '';
      for await (const event of session.send(prompt)) {
        if (event.kind === 'chunk') text += event.text;
        if (event.kind === 'runtime_error') throw new Error(event.error);
        if (event.kind === 'turn_end') assert.ok(!['error', 'cancelled'].includes(event.stopReason ?? ''));
      }
      return text;
    }
    try {
      getDb().prepare('INSERT INTO workspaces (id,name,cwd,created_at,updated_at) VALUES (?,?,?,1,1)').run('smoke', 'Disposable fork smoke', directory);
      for (const [id, parent] of [[nodeId, null], [childId, nodeId]]) {
        getDb().prepare("INSERT INTO nodes (id,workspace_id,parent_node_id,kind,status,created_at) VALUES (?,'smoke',?,'chat','idle',1)").run(id, parent);
      }
      const port = (server.address() as AddressInfo).port;
      runtime = runtimeId === 'codex'
        ? new (require('../src/agents/codex/CodexRuntime').CodexRuntime)(bridge, registry, port)
        : new (require('../src/agents/claude/ClaudeRuntime').ClaudeRuntime)(bridge, registry, port);
      const parent = await runtime!.newSession({ ...options, sessionId: nodeId });
      const parentReply = await answer(parent, `Do not use tools. Remember this exact test token: ${token}. Reply only ACK.`);
      assert.ok(parentReply.trim());
      assert.ok(parent.nativeSessionId);
      if (runtimeId === 'claude') {
        const { getClaudeJsonlPath } = require('../src/agents/claude/claudeProjectsPath') as typeof import('../src/agents/claude/claudeProjectsPath');
        const transcriptPath = getClaudeJsonlPath(directory, parent.nativeSessionId!);
        assert.ok(fs.existsSync(transcriptPath), `Claude did not persist its transcript at ${transcriptPath}`);
      }
      repo.updateNodeResumeBinding(nodeId, { acp_session_id: parent.nativeSessionId!, runtime_id: runtimeId,
        model_id: parent.currentModelId ?? null, reasoning: 'low' });
      getDb().prepare("INSERT INTO messages (id,node_id,role,content,seq,created_at) VALUES (?,?,'assistant',?,1,1)").run(randomUUID(), nodeId, parentReply);
      const sourceId = parent.nativeSessionId;
      const child = await tryForkChatSession(runtime!, { ...options, sessionId: childId, parentChatId: nodeId });
      assert.ok(child, 'eligible branch should use native fork');
      assert.notEqual(child.nativeSessionId, sourceId);
      const inherited = await answer(child, 'Do not use tools. What exact test token did I ask you to remember? Output that token.');
      assert.ok(inherited.includes(token), `fork did not recall the native token: ${inherited}`);
      assert.equal(parent.nativeSessionId, sourceId);
      assert.equal(repo.getNode(nodeId)?.external_session_id, sourceId);
      repo.updateNodeResumeBinding(childId, { acp_session_id: child.nativeSessionId!, runtime_id: runtimeId,
        model_id: child.currentModelId ?? null, reasoning: 'low' });
      const childNativeId = child.nativeSessionId;
      await runtime!.releaseSession(child.id);
      const resumed = await runtime!.loadSession!({ ...options, sessionId: childId, nodeId: childId });
      assert.equal(resumed.nativeSessionId, childNativeId);
      const continued = await answer(resumed, 'Do not use tools. Repeat the exact remembered test token.');
      assert.ok(continued.includes(token), `resumed fork lost native history: ${continued}`);
    } finally {
      clearTimeout(timer);
      await runtime?.shutdown();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      clearAllSessions(); __resetRuntimeDeps(); closeDb(); process.env = priorEnv;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
