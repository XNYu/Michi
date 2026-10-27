/**
 * The Michi assistant's native history stays with its lockdown: no native
 * fork carries an assistant conversation into an ordinary chat, or an
 * ordinary chat's into the assistant (assistant/policy.ts). Branches there use
 * the exact text path instead. No CLI runs; the fork entry points refuse first.
 */

import './helpers/claudeSdkFixture';
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeTestOptions } from './helpers/claudeTestOptions';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assistantToolProfile } from '../src/assistant/policy';
import { ensureAssistant } from '../src/assistant/store';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { closeDb, initDb } from '../src/services/db';
import { saveWorkspace } from '../src/services/dbRepository';
import { NativeResumeUnavailableError } from '../src/services/nativeResume';
import { tryForkChatSession } from '../src/services/nativeFork';

const bridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null } as any;

describe('assistant native forks', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-native-fork-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
    configureRuntimeDeps({
      historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null } as any,
      agentConfig: { getAgentConfig: () => ({ runtime: 'claude', provider: 'x', modelByRuntime: {}, reasoningByRuntime: {} }), resolveModel: () => '', resolveReasoning: () => undefined } as any,
      dataDir: tmpDir,
      chatPermissions: { getMode: () => 'yolo', hasGrant: () => false, grant: () => {} },
    } as any);
  });

  afterEach(() => {
    __resetRuntimeDeps();
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('native history never forks into or out of the assistant', async () => {
    const { ClaudeRuntime } = require('michi-runtime/internal/adapters/claude/ClaudeRuntime') as typeof import('michi-runtime/internal/adapters/claude/ClaudeRuntime');
    const runtime = new ClaudeRuntime({ ...claudeTestOptions(), bridge, mcpSlots: { create: () => ({ slotId: 's' }), dispose: async () => {}, get: () => undefined } as any });
    const home = ensureAssistant();
    saveWorkspace({ id: 'ws-user', name: 'Mine', cwd: tmpDir, created_at: 1, updated_at: 1, settings: null });
    const fork = { sessionId: 'n-child', parentChatId: 'n-parent', cwd: tmpDir, sourceNativeSessionId: 'native-parent' };
    try {
      await assert.rejects(runtime.forkSession({ ...fork, workspaceId: 'ws-user', toolProfile: assistantToolProfile() } as any),
        (error: unknown) => error instanceof NativeResumeUnavailableError && /assistant does not fork/.test(error.message),
        'an assistant session does not inherit an ordinary chat');
      await assert.rejects(runtime.forkSession({ ...fork, workspaceId: home.workspaceId } as any),
        (error: unknown) => error instanceof NativeResumeUnavailableError && /assistant does not fork/.test(error.message),
        "an ordinary session does not inherit the assistant's conversation");
    } finally {
      await runtime.shutdown();
    }

    // The shared entry point declines before asking any runtime, for a branch
    // that would otherwise qualify (the text path is used instead).
    const { saveMessage, saveNode, saveTree } = require('../src/services/dbRepository') as typeof import('../src/services/dbRepository');
    const seedBranch = (workspaceId: string, prefix: string) => {
      saveTree({ id: `t-${prefix}`, workspace_id: workspaceId, root_node_id: `${prefix}-parent`, last_active_at: 1, created_at: 1 });
      const base = { workspace_id: workspaceId, tree_id: `t-${prefix}`, kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, runtime_id: 'claude', created_at: 1 };
      saveNode({ ...base, id: `${prefix}-parent`, title: 'Parent', acp_session_id: `${prefix}-parent`, external_session_id: `native-${prefix}` } as any);
      saveNode({ ...base, id: `${prefix}-child`, title: 'Child', parent_node_id: `${prefix}-parent`, acp_session_id: null } as any);
      saveMessage({ id: `m-${prefix}`, node_id: `${prefix}-parent`, role: 'assistant', content: 'Earlier answer', seq: 1, created_at: 2 });
    };
    seedBranch(home.workspaceId, 'a');
    seedBranch('ws-user', 'u');
    const asked: string[] = [];
    const stub = { id: 'claude', resumeTokenFromBinding: ClaudeRuntime.resumeTokenFromBinding,
      forkSession: async (opts: { sessionId: string }) => { asked.push(opts.sessionId); throw new NativeResumeUnavailableError('stub'); } } as any;
    const homeCwd = (require('../src/services/dbRepository') as typeof import('../src/services/dbRepository')).getWorkspace(home.workspaceId)!.cwd!;
    assert.equal(await tryForkChatSession(stub, { sessionId: 'a-child', cwd: homeCwd, workspaceId: home.workspaceId } as any), null);
    assert.equal(await tryForkChatSession(stub, { sessionId: 'u-child', cwd: tmpDir, workspaceId: 'ws-user', toolProfile: assistantToolProfile() } as any), null);
    assert.deepEqual(asked, [], 'no runtime is asked to fork either');
    // An ordinary branch still reaches the runtime.
    assert.equal(await tryForkChatSession(stub, { sessionId: 'u-child', cwd: tmpDir, workspaceId: 'ws-user' } as any), null);
    assert.deepEqual(asked, ['u-child']);
  });
});
