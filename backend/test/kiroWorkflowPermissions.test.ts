/**
 * A Kiro workflow step's tool request follows the permissions of the chat
 * that launched the run (KiroSession.approvesWorkflowRequest): the chat's
 * mode now, its tool grants and its trust for the session.
 */
import './isolatedConfigDir';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatPermissionMode } from 'michi-shared';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { AcpAgentSession } from 'michi-runtime/internal/adapters/kiro/AcpAgentSession';
import type { AcpAgentRuntime } from 'michi-runtime/internal/adapters/kiro/AcpAgentRuntime';
import type { RuntimeSessionOwner } from '../src/agents/types';
import { michiTestHost } from './helpers/michiTestHost';
import { chatOwner, runOwner } from './helpers/owners';

let mode: ChatPermissionMode = 'ask';
const grants = new Set<string>();

beforeEach(() => {
  mode = 'ask';
  grants.clear();
  configureRuntimeDeps({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'michi-kiro-workflow-permissions-')),
    historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null },
    agentConfig: {
      getAgentConfig: () => ({ runtime: 'kiro', provider: 'kiro', modelByRuntime: {}, reasoningByRuntime: {} }),
      resolveModel: () => 'test-model', resolveReasoning: () => undefined,
    },
    providerKeys: { getProviderApiKey: () => 'test-key' },
    chatPermissions: {
      getMode: () => mode,
      hasGrant: (nodeId, tool) => grants.has(`${nodeId}:${tool}`),
      grant: (nodeId, tool) => { grants.add(`${nodeId}:${tool}`); },
      resetToken: () => '0',
    },
  });
});

after(() => __resetRuntimeDeps());

function session(owner: RuntimeSessionOwner, opts: Record<string, unknown> = {}): AcpAgentSession {
  const runtime = {
    host: michiTestHost(),
    getCurrentMode: () => undefined, getCurrentModel: () => undefined,
  } as unknown as AcpAgentRuntime;
  return new AcpAgentSession('chat-1', 'native-1', runtime, '/tmp', { owner, ownerUserId: 'alice', workspaceId: 'ws', ...opts });
}

const WRITE = { toolCall: { title: 'Write File' }, meta: { toolName: 'write' } };

test('Trust and YOLO approve a workflow step; Ask does not', () => {
  const chat = session(chatOwner('chat-1'));
  assert.equal(chat.approvesWorkflowRequest(WRITE.toolCall, WRITE.meta), false);
  mode = 'trust';
  assert.equal(chat.approvesWorkflowRequest(WRITE.toolCall, WRITE.meta), true, 'the mode is read now, not at the turn that launched the run');
  mode = 'yolo';
  assert.equal(chat.approvesWorkflowRequest({ title: 'Bash' }), true);
});

test("In Ask, the chat's tool grant and its trust for the session approve a step", () => {
  const chat = session(chatOwner('chat-1'));
  grants.add('chat-1:write');
  assert.equal(chat.approvesWorkflowRequest(WRITE.toolCall, WRITE.meta), true, 'Trust this tool covers the step');
  assert.equal(chat.approvesWorkflowRequest({ title: 'Running: rm -rf build' }, { toolName: 'shell' }), false, 'another tool still asks');
  chat['approvals'].accept('allow_session', chatOwner('chat-1'), 'shell');
  assert.equal(chat.approvesWorkflowRequest({ title: 'Running: rm -rf build' }, { toolName: 'shell' }), true,
    'Trust all tools for this session covers the step');
});

test('Agent Runs and restricted sessions never approve on their behalf', () => {
  mode = 'trust';
  assert.equal(session(runOwner('run-1', 'attempt-1')).approvesWorkflowRequest(WRITE.toolCall, WRITE.meta), false);
  const restricted = session(chatOwner('chat-1'), { toolProfile: { allowedToolNames: ['read'], restricted: true } });
  assert.equal(restricted.approvesWorkflowRequest(WRITE.toolCall, WRITE.meta), false);
});
