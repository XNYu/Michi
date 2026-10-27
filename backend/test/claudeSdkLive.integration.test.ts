import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeTestOptions } from './helpers/claudeTestOptions';
import { chatOwner, runOwner } from './helpers/owners';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { AgentSession, NewAgentSessionOptions } from '../src/agents/types';
import type { NormalizedEvent } from '../src/services/chatEvents';

// Explicit opt-in: uses the installed CLI, existing provider auth and model quota.
// Only provider settings are copied; all histories and Michi data are disposable.
test('real SDK: durable historical fork, restart, native question, policy and interrupt', {
  skip: process.env.MICHI_CLAUDE_SDK_SMOKE !== '1', timeout: 420_000,
}, async (t) => {
  const originalEnv = { ...process.env };
  const sourceConfig = process.env.MICHI_CLAUDE_SDK_LIVE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR;
  assert.ok(sourceConfig, 'Set MICHI_CLAUDE_SDK_LIVE_CONFIG_DIR to an authenticated Claude config directory');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'michi-sdk-live-')));
  const cwd = path.join(root, 'workspace');
  const configDir = path.join(root, 'claude-config');
  fs.mkdirSync(cwd); fs.mkdirSync(configDir);
  const source = JSON.parse(fs.readFileSync(path.join(sourceConfig, 'settings.json'), 'utf8'));
  const settings: Record<string, unknown> = { autoMemoryEnabled: false };
  for (const key of ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'model', 'fallbackModel',
    'availableModels', 'enforceAvailableModels', 'modelOverrides', 'modelSettings']) {
    if (source[key] !== undefined) settings[key] = source[key];
  }
  settings.env = Object.fromEntries(Object.entries(source.env ?? {})
    .filter(([key]) => /^(ANTHROPIC_|AWS_|GOOGLE_|CLOUD_ML_|CLAUDE_CODE_USE_)/.test(key)));
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(settings), { mode: 0o600 });
  Object.assign(process.env, {
    MICHI_DATA_DIR: path.join(root, 'data'), MICHI_CONFIG_DIR: path.join(root, 'config'),
    MICHI_LOG_DIR: path.join(root, 'logs'), CLAUDE_CONFIG_DIR: configDir,
    MICHI_CLAUDE_POOL_DISABLED: '1', MICHI_CLAUDE_BARE: '1', MICHI_CLAUDE_STRICT_MCP: '1',
    MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC: '0',
  });
  delete process.env.MICHI_CLOUD;
  const express = require('express') as typeof import('express');
  const db = require('../src/services/db') as typeof import('../src/services/db');
  const repo = require('../src/services/dbRepository') as typeof import('../src/services/dbRepository');
  const config = require('../src/services/agentConfig') as typeof import('../src/services/agentConfig');
  const permissions = require('../src/services/chatPermissions') as typeof import('../src/services/chatPermissions');
  const deps = require('../src/agents/runtimeDeps') as typeof import('../src/agents/runtimeDeps');
  const { ClaudeRuntime } = require('michi-runtime/internal/adapters/claude/ClaudeRuntime') as typeof import('michi-runtime/internal/adapters/claude/ClaudeRuntime');
  const { ChatHub } = require('../src/agents/chatHub') as typeof import('../src/agents/chatHub');
  const { McpSlotRegistry, mountMcp } = require('../src/services/mcpServer') as typeof import('../src/services/mcpServer');
  db.closeDb(); db.initDb();
  config.loadAgentConfig();
  permissions.writeChatPermissionSettings({ global: false, mode: 'ask' });
  deps.configureRuntimeDeps({
    historyStore: { getNode: repo.getNode, listMessages: repo.listMessages, getWorkspace: repo.getWorkspace,
      getWorkspaceInstructions: repo.getWorkspaceInstructions, hasGrant: repo.hasGrant, grantPermission: repo.grantPermission },
    dataDir: process.env.MICHI_DATA_DIR,
    agentConfig: { getAgentConfig: config.getAgentConfig, resolveModel: config.resolveModel, resolveReasoning: config.resolveReasoning },
    chatPermissions: { getMode: permissions.resolveChatPermissionMode, hasGrant: permissions.hasChatToolGrant,
      grant: permissions.grantChatTool, resetToken: permissions.chatPermissionResetToken },
  });
  repo.saveWorkspace({ id: 'ws', name: 'Disposable SDK validation', cwd, created_at: 1, updated_at: 1, active_tree_id: 'tree' });
  repo.saveTree({ id: 'tree', workspace_id: 'ws', root_node_id: 'parent', last_active_at: 1, created_at: 1 });
  function node(id: string, parent: string | null = null) {
    repo.saveNode({ id, workspace_id: 'ws', tree_id: 'tree', parent_node_id: parent, kind: 'chat', status: 'idle', runtime_id: 'claude',
      minimized: 0, spawned_by_agent: 0, created_at: Date.now() });
  }
  // Read once the server below listens: the port the runtime gets.
  const registry = new McpSlotRegistry({ mcpPort: () => (server.address() as AddressInfo).port });
  const app = express(); app.use(express.json());
  const router = express.Router(); mountMcp(router, registry); app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const model = process.env.MICHI_CLAUDE_SDK_LIVE_MODEL ?? 'sonnet';
  const runtime = new ClaudeRuntime({ ...claudeTestOptions(), bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null }, mcpSlots: registry });
  const hub = new ChatHub({ retentionMs: 1000, titleGenerator: null });
  const options = { cwd, workspaceId: 'ws', model, reasoning: 'low' as const, enableFollowUps: false };
  async function session(id: string, extra: Partial<NewAgentSessionOptions> = {}) {
    node(id);
    return runtime.newSession({ ...options, sessionId: id, ...extra });
  }
  async function turn(s: AgentSession, text: string, onEvent?: (event: NormalizedEvent) => void | Promise<void>) {
    const events: NormalizedEvent[] = [];
    let answer = '';
    const timer = setTimeout(() => { void s.cancel(); }, 70_000);
    try {
      for await (const event of s.send(text)) {
        events.push(event);
        if (event.kind === 'chunk') answer += event.text;
        if (event.kind === 'permission_request') s.respondToPermission?.(event.requestId, 'allow_once');
        if (event.kind === 'user_input_request') s.respondToUserInput?.(event.requestId,
          event.questions.map(question => ({ question: question.question, answer: 'Blue' })));
        await onEvent?.(event);
      }
    } finally { clearTimeout(timer); }
    assert.ok(!events.some(event => event.kind === 'runtime_error'), 'Runtime error during live turn');
    return { answer, events };
  }
  async function durable(s: AgentSession, text: string) {
    const started = await hub.startTurn({ chatId: s.id, nodeId: s.id, session: s, text });
    await started.done;
    const message = repo.listMessages(s.id).find(message => message.id === started.assistantId);
    assert.ok(message, 'Durable assistant answer is missing');
    assert.ok(message.content.trim(), 'Durable assistant answer is empty');
    return message;
  }
  try {
    await t.test('historical fork keeps 6241 while parent and resumed parent keep 7352', async () => {
      const parent = await session('parent');
      const first = await durable(parent, 'Remember my project number as 6241. Reply only ACK. Do not use tools.');
      await durable(parent, 'Replace my project number with 7352. Reply only ACK. Do not use tools.');
      assert.ok(parent.nativeSessionId);
      const parentNativeId = parent.nativeSessionId;
      node('child', 'parent');
      repo.saveEdge({ id: randomUUID(), workspace_id: 'ws', source_node_id: 'parent', target_node_id: 'child', kind: 'branch',
        anchor_message_id: first.id, fork_boundary_message_id: first.id, created_at: Date.now() });
      const { tryForkChatSession } = require('../src/services/nativeFork') as typeof import('../src/services/nativeFork');
      const { resolveBranchBoundary, toBranchContext } = require('../src/services/branchBoundary') as typeof import('../src/services/branchBoundary');
      const boundary = resolveBranchBoundary({ childNodeId: 'child', parentNodeId: 'parent' });
      assert.ok(boundary);
      const child = await tryForkChatSession(runtime, { ...options, sessionId: 'child', parentChatId: 'parent',
        branchContext: toBranchContext(boundary),
        owner: chatOwner('child') });
      assert.ok(child, 'Historical branch fell back to text instead of native history');
      assert.notEqual(child.nativeSessionId, parentNativeId);
      const reply = await durable(child, 'What is my project number? Reply only the number. Do not use tools.');
      assert.match(reply.content, /6241/); assert.doesNotMatch(reply.content, /7352/);
      await runtime.releaseSession(parent.id);
      const resumed = await runtime.loadSession({ ...options, sessionId: parent.id, nodeId: parent.id });
      assert.equal(resumed.nativeSessionId, parentNativeId);
      assert.match((await durable(resumed, 'What is my project number? Reply only the number. Do not use tools.')).content, /7352/);
    });
    await t.test('native AskUserQuestion uses the Michi interaction and returns its answer', async () => {
      const s = await session('question', { toolProfile: { allowedToolNames: ['AskUserQuestion'] } });
      const result = await turn(s, 'Use AskUserQuestion now to ask which color I prefer, with Blue and Red options. After I answer, reply only the selected color. Do not ask in plain text.');
      assert.ok(result.events.some(event => event.kind === 'tool_call' && event.title === 'AskUserQuestion'));
      assert.ok(result.events.some(event => event.kind === 'user_input_request'));
      assert.match(result.answer, /Blue/);
    });
    await t.test('default non-bare chat exposes and answers native AskUserQuestion without a restricted tool profile', async questionTest => {
      const previousBare = process.env.MICHI_CLAUDE_BARE;
      process.env.MICHI_CLAUDE_BARE = '0';
      const transport = require('michi-runtime/internal/adapters/claude/claudeSdkTransport') as typeof import('michi-runtime/internal/adapters/claude/claudeSdkTransport');
      const create = transport.createClaudeSdkTransport;
      let nativeTools: string[] | undefined;
      let nativeVersion: string | undefined;
      questionTest.mock.method(transport, 'createClaudeSdkTransport', (args: Parameters<typeof create>[0]) => create({
        ...args,
        onMessage: message => {
          if (message.type === 'system' && message.subtype === 'init') {
            nativeTools = Array.isArray(message.tools) ? message.tools.filter((tool): tool is string => typeof tool === 'string') : [];
            nativeVersion = typeof message.claude_code_version === 'string' ? message.claude_code_version : undefined;
          }
          args.onMessage(message);
        },
      }));
      try {
        // The isolated config has provider settings only: no user hooks or
        // plugin config. This follows the production default (bare=false),
        // without a tool profile that could hide a missing default tool.
        const s = await session('default-native-question');
        const result = await turn(s, 'Use the built-in AskUserQuestion tool now, not any MCP tool, to ask which color I prefer with Blue and Red options. After the user answers, reply only COLOR=<selected color>. Do not ask in plain text or answer the question yourself.');
        assert.ok(nativeTools?.includes('AskUserQuestion'), 'Default non-bare native initialization did not expose AskUserQuestion');
        assert.ok(result.events.some(event => event.kind === 'tool_call' && event.title === 'AskUserQuestion'),
          'The default chat used a substitute instead of native AskUserQuestion');
        assert.ok(result.events.some(event => event.kind === 'user_input_request'));
        assert.match(result.answer, /COLOR=Blue/);
        questionTest.diagnostic(JSON.stringify({ scenario: 'default-nonbare-native-question', cliVersion: nativeVersion,
          tools: nativeTools, nativeQuestionObserved: true, interactionAnswered: true, answer: result.answer }));
      } finally {
        if (previousBare === undefined) delete process.env.MICHI_CLAUDE_BARE;
        else process.env.MICHI_CLAUDE_BARE = previousBare;
      }
    });
    await t.test('mandatory Run broker overrides native auto-approval before a file side effect', async policyTest => {
      const transport = require('michi-runtime/internal/adapters/claude/claudeSdkTransport') as typeof import('michi-runtime/internal/adapters/claude/claudeSdkTransport');
      const create = transport.createClaudeSdkTransport;
      policyTest.mock.method(transport, 'createClaudeSdkTransport', (args: Parameters<typeof create>[0]) => create({
        ...args, settingsInline: JSON.stringify({ permissions: { allow: ['Bash'] } }),
      }));
      const denied = path.join(cwd, 'must-not-exist.txt');
      const seen: string[] = [];
      const id = randomUUID();
      const s = await runtime.newSession({ ...options, sessionId: id,
        owner: runOwner('live-policy', id),
        toolProfile: { allowedToolNames: ['Bash'] },
        permissionBroker: { requestPermission: async request => { seen.push(request.toolName); return 'deny'; } } });
      await turn(s, `Use Bash once to run exactly: printf DENIED > ${denied}. If denied, stop. Do not use another tool.`);
      assert.ok(seen.includes('Bash'), 'Model did not exercise the broker');
      assert.equal(fs.existsSync(denied), false);
    });
    await t.test('interrupt text then continue without leaking the cancelled answer', async () => {
      const s = await session('interrupt');
      await turn(s, 'Remember my marker 8294. Reply only ACK. Do not use tools.');
      let cancellation: Promise<unknown> | undefined;
      const result = await turn(s, 'Print numbers 1 to 2000, one per line. Do not use tools.', event => {
        if (event.kind === 'chunk' && event.text.trim() && !cancellation) cancellation = Promise.resolve(s.cancel());
      });
      assert.ok(cancellation); await cancellation;
      assert.ok(result.events.some(event => event.kind === 'turn_end' && event.stopReason === 'cancelled'));
      const next = await turn(s, 'Reply only with my remembered four digit marker. Do not use tools.');
      assert.match(next.answer, /8294/);
    });
    await t.test('interrupt an approved long tool before its delayed file side effect', async () => {
      const s = await session('tool-interrupt');
      const started = path.join(cwd, 'cancelled-tool-started.txt');
      const forbidden = path.join(cwd, 'cancelled-tool-must-not-finish.txt');
      let cancellation: Promise<unknown> | undefined;
      let observedStart = 0;
      const result = await turn(s, `Use Bash once to run exactly: printf STARTED > ${started}; sleep 5; printf OLD_TASK_FINISHED > ${forbidden}. Then reply OLD_TASK_FINISHED.`, event => {
        // Observe an actual subprocess side effect before cancelling, rather
        // than racing cancellation against native permission approval.
        if (event.kind === 'permission_request' && !cancellation) {
          cancellation = (async () => {
            const deadline = Date.now() + 8_000;
            while (!fs.existsSync(started) && Date.now() < deadline) {
              await new Promise(resolve => setTimeout(resolve, 25));
            }
            if (fs.existsSync(started)) observedStart = Date.now();
            await s.cancel();
          })();
        }
      });
      assert.ok(cancellation, 'The model did not request the cancellable tool'); await cancellation;
      assert.ok(observedStart, 'The approved Bash subprocess did not start');
      assert.ok(result.events.some(event => event.kind === 'turn_end' && event.stopReason === 'cancelled'));
      assert.equal(fs.existsSync(forbidden), false);
      const next = await turn(s, 'Reply only RECOVERED. Do not use tools.');
      assert.match(next.answer, /RECOVERED/); assert.doesNotMatch(next.answer, /OLD_TASK_FINISHED/);
      // Wait beyond the original shell's sleep so an orphaned subprocess
      // cannot produce a delayed write after the assertions have finished.
      await new Promise(resolve => setTimeout(resolve, Math.max(0, observedStart + 5_500 - Date.now())));
      assert.equal(fs.existsSync(forbidden), false);
    });
  } finally {
    await runtime.shutdown();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    deps.__resetRuntimeDeps(); db.closeDb();
    process.env = originalEnv;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
