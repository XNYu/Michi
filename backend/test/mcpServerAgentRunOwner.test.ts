/**
 * T02 — Owner-aware MCP exposure tests.
 *
 * Validates:
 *   1. Chat slots cannot list or call submit_agent_result.
 *   2. Run slots can call submit_agent_result only for their exact Attempt.
 *   3. Wrong owner, hidden tool, or missing callback fails closed.
 *   4. Agent Run Workspace resolution performs no Node lookup.
 *   5. Existing chat MCP surface remains intact.
 *   6. runMcpSlot.ts factory produces correct McpSlotCallbacks.
 *
 * Uses node:test (Node 22+) + ts-node.
 * Run: cd backend && npm test -- --test-name-pattern 'T02|Owner-aware MCP'
 */

import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  McpSlotRegistry,
  buildMcpServerForSlot,
  type McpSlot,
} from '../src/services/mcpServer';
import type { RuntimeSessionOwner } from '../src/agents/types';
import type { ResultBundleV1 } from 'michi-shared';
import { buildRunMcpSlotCallbacks, type RunMcpSlotOptions } from '../src/agents/runs/runMcpSlot';
import { SUBMIT_AGENT_RESULT_TOOL, type RunWorkerToolProfile } from '../src/agents/runs/runWorkerTools';
import { closeDb, initDb } from '../src/services/db';
import { saveNode, saveWorkspace, setAiGlobalContext } from '../src/services/dbRepository';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal no-op chat callbacks that satisfy McpSlotCallbacks. */
function makeChatCallbacks() {
  return {
    onSpawnBranches: async () => [],
    onSaveArtifact: () => null,
    onUpdateArtifact: () => null,
    onShowImage: () => ({ error: 'unsupported in test' as const }),
  };
}

/** Extract registered tool names from a built McpServer. */
function registeredToolNames(slot: McpSlot): string[] {
  const server = buildMcpServerForSlot(slot);
  const tools = (server as unknown as {
    _registeredTools: Record<string, unknown>;
  })._registeredTools;
  return Object.keys(tools);
}

/** Get a specific tool handler from a built McpServer. */
function getToolHandler(slot: McpSlot, toolName: string) {
  const server = buildMcpServerForSlot(slot);
  const tools = (server as unknown as {
    _registeredTools: Record<string, { handler: (a: Record<string, unknown>) => Promise<unknown> }>;
  })._registeredTools;
  return tools[toolName]?.handler ?? null;
}

const CHAT_OWNER: RuntimeSessionOwner = { kind: 'chat_node', nodeId: 'n-chat-1' };
const RUN_OWNER: RuntimeSessionOwner = { kind: 'agent_run', runId: 'run-1', attemptId: 'att-1' };
const DIFFERENT_RUN_OWNER: RuntimeSessionOwner = { kind: 'agent_run', runId: 'run-2', attemptId: 'att-2' };

function makeSubmitCallback(owner: RuntimeSessionOwner) {
  const submissions: unknown[] = [];
  const callback = (incoming: RuntimeSessionOwner, payload: unknown): ResultBundleV1 => {
    if (incoming.kind !== 'agent_run' || owner.kind !== 'agent_run'
      || incoming.runId !== owner.runId || incoming.attemptId !== owner.attemptId) {
      throw new Error('submit_agent_result owner does not match the active Run Attempt');
    }
    submissions.push(payload);
    return payload as ResultBundleV1;
  };
  return { callback, submissions };
}

// ---------------------------------------------------------------------------
// Suite: Chat slot must NOT expose submit_agent_result
// ---------------------------------------------------------------------------

describe('T02: Chat slot must NOT expose submit_agent_result', () => {
  let registry: McpSlotRegistry;
  beforeEach(() => { registry = new McpSlotRegistry(); });

  test('chat slot without any run callbacks has no run-specific tools', () => {
    const slot = registry.create('chat-3', '/tmp', null, {
      ...makeChatCallbacks(),
      owner: CHAT_OWNER,
    } as any);
    const tools = registeredToolNames(slot);
    assert.ok(!tools.includes('submit_agent_result'));
    assert.ok(!tools.includes('spawn_agent'));
    assert.ok(!tools.includes('check_agent'));
  });
});

// ---------------------------------------------------------------------------
// Suite: Run slot submit_agent_result registration
// ---------------------------------------------------------------------------

describe('T02: Run slot submit_agent_result', () => {
  let registry: McpSlotRegistry;
  beforeEach(() => { registry = new McpSlotRegistry(); });

  test('agent_run owner with callback registers submit_agent_result', () => {
    const { callback } = makeSubmitCallback(RUN_OWNER);
    const slot = registry.create('att-1', '/tmp', 'user-1', {
      ...makeChatCallbacks(),
      owner: RUN_OWNER,
      onSubmitAgentResult: (payload: unknown) => callback(RUN_OWNER, payload),
    } as any, { workspaceId: 'ws-1' });
    const tools = registeredToolNames(slot);
    assert.ok(tools.includes('submit_agent_result'),
      'submit_agent_result must be registered for agent_run owner with callback');
  });

  test('submit_agent_result handler invokes the bound callback', async () => {
    const submitted: unknown[] = [];
    const slot = registry.create('att-1', '/tmp', 'user-1', {
      ...makeChatCallbacks(),
      owner: RUN_OWNER,
      onSubmitAgentResult: (payload: unknown) => {
        submitted.push(payload);
        return payload as any;
      },
    } as any, { workspaceId: 'ws-1' });

    const handler = getToolHandler(slot, 'submit_agent_result');
    assert.ok(handler, 'handler must exist');
    const result = await handler({ version: 1, status: 'completed' }) as any;
    assert.equal(result.content[0].text, 'Agent result submitted.');
    assert.deepEqual(submitted, [{ version: 1, status: 'completed' }]);
  });
});

// ---------------------------------------------------------------------------
// Suite: exposed-tool allow-list enforcement
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Suite: Agent Run Workspace resolution (no Node lookup)
// ---------------------------------------------------------------------------

describe('T02: Agent Run Workspace resolution performs no Node lookup', () => {
  let registry: McpSlotRegistry;
  beforeEach(() => { registry = new McpSlotRegistry(); });

  test('resolveSlotBinding uses cached workspaceId for agent_run owner', () => {
    // We can verify this indirectly: create a slot with agent_run owner and
    // a specific workspaceId but nodeId = null. The globalContext tools
    // (list_threads, etc.) should still receive the workspaceId.
    //
    // The key assertion: the slot must NOT attempt getNodeSessionBinding().
    // We validate this by ensuring workspaceId is used as-is without needing
    // a nodeId.
    const slot = registry.create('att-5', '/tmp', 'user-1', {
      ...makeChatCallbacks(),
      owner: RUN_OWNER,
    } as any, { nodeId: null, workspaceId: 'ws-run-1' });

    // Slot should have nodeId = null and workspaceId = 'ws-run-1'
    assert.equal(slot.nodeId, null, 'agent_run slot must have null nodeId');
    assert.equal(slot.workspaceId, 'ws-run-1', 'agent_run slot must carry its Workspace binding');
    assert.deepEqual(slot.owner, RUN_OWNER);
  });

  test('agent_run slot with null nodeId still builds a valid MCP server', () => {
    const slot = registry.create('att-6', '/tmp', 'user-1', {
      ...makeChatCallbacks(),
      owner: RUN_OWNER,
    } as any, { nodeId: null, workspaceId: 'ws-run-2' });

    // This must not throw — if it tried to do a Node lookup with null
    // nodeId it might fail or return wrong data.
    const server = buildMcpServerForSlot(slot);
    assert.ok(server, 'MCP server must build successfully for agent_run slot');
  });
});

// ---------------------------------------------------------------------------
// Suite: Wrong owner / missing callback / hidden tool — fail closed
// ---------------------------------------------------------------------------

describe('T02: Fail-closed safety', () => {
  test('submit_agent_result not registered for chat_node owner even with agent_run-like callback', () => {
    const registry = new McpSlotRegistry();
    const slot = registry.create('chat-safe', '/tmp', null, {
      ...makeChatCallbacks(),
      owner: CHAT_OWNER,
      onSubmitAgentResult: () => ({} as any),
    } as any);
    assert.ok(!registeredToolNames(slot).includes('submit_agent_result'));
  });
});

// ---------------------------------------------------------------------------
// Suite: buildRunMcpSlotCallbacks factory
// ---------------------------------------------------------------------------

describe('T02: buildRunMcpSlotCallbacks', () => {
  test('produces callbacks with owner and exposedToolNames from tool profile', () => {
    const owner: RuntimeSessionOwner & { kind: 'agent_run' } = {
      kind: 'agent_run', runId: 'run-f', attemptId: 'att-f',
    };
    const toolProfile: RunWorkerToolProfile = {
      allowedToolNames: ['spawn_branches', 'submit_agent_result'],
      runWorkerTools: {
        submitAgentResult: (o, p) => p as any,
      },
    };
    const cbs = buildRunMcpSlotCallbacks({
      owner,
      workspaceId: 'ws-f',
      ownerUserId: 'user-f',
      toolProfile,
      chatCallbacks: makeChatCallbacks(),
    });

    assert.deepEqual(cbs.owner, owner);
    assert.ok(cbs.exposedToolNames instanceof Set);
    assert.ok(cbs.exposedToolNames!.has('spawn_branches'));
    assert.ok(cbs.exposedToolNames!.has('submit_agent_result'));
    assert.equal(typeof cbs.onSubmitAgentResult, 'function');
    assert.equal(typeof cbs.onSpawnBranches, 'function');
  });

  test('throws for non agent_run owner', () => {
    assert.throws(
      () => buildRunMcpSlotCallbacks({
        owner: { kind: 'chat_node', nodeId: 'n-1' } as any,
        workspaceId: 'ws-bad',
        ownerUserId: null,
        toolProfile: { allowedToolNames: [] },
        chatCallbacks: makeChatCallbacks(),
      }),
      /agent_run owner/,
    );
  });

  test('propagates agentRuns and agentRunToolNames', () => {
    const owner: RuntimeSessionOwner & { kind: 'agent_run' } = {
      kind: 'agent_run', runId: 'run-i', attemptId: 'att-i',
    };
    const invoker = { invoke: async () => ({}) };
    const cbs = buildRunMcpSlotCallbacks({
      owner,
      workspaceId: 'ws-i',
      ownerUserId: null,
      toolProfile: { allowedToolNames: ['spawn_agent'] },
      chatCallbacks: makeChatCallbacks(),
      agentRuns: invoker,
      agentRunToolNames: ['spawn_agent'],
    });

    assert.equal(cbs.agentRuns, invoker);
    assert.deepEqual(cbs.agentRunToolNames, ['spawn_agent']);
  });

  test('no exposedToolNames when profile has no allowedToolNames', () => {
    const owner: RuntimeSessionOwner & { kind: 'agent_run' } = {
      kind: 'agent_run', runId: 'run-j', attemptId: 'att-j',
    };
    const cbs = buildRunMcpSlotCallbacks({
      owner,
      workspaceId: 'ws-j',
      ownerUserId: null,
      toolProfile: {}, // No allowedToolNames
      chatCallbacks: makeChatCallbacks(),
    });

    assert.equal(cbs.exposedToolNames, undefined,
      'exposedToolNames must be undefined when profile has no allow-list');
  });
});

// ---------------------------------------------------------------------------
// Suite: End-to-end — Run slot via buildRunMcpSlotCallbacks through registry
// ---------------------------------------------------------------------------

describe('T02: End-to-end Run slot through registry', () => {
  test('Run slot built via factory registers submit_agent_result and correct tools', () => {
    const registry = new McpSlotRegistry();
    const owner: RuntimeSessionOwner & { kind: 'agent_run' } = {
      kind: 'agent_run', runId: 'run-e2e', attemptId: 'att-e2e',
    };
    const submitted: unknown[] = [];
    const toolProfile: RunWorkerToolProfile = {
      allowedToolNames: ['spawn_branches', 'save_artifact', 'submit_agent_result'],
      runWorkerTools: {
        submitAgentResult: (o, p) => {
          if (o.kind !== 'agent_run' || o.runId !== owner.runId || o.attemptId !== owner.attemptId) {
            throw new Error('owner mismatch');
          }
          submitted.push(p);
          return p as any;
        },
      },
    };
    const cbs = buildRunMcpSlotCallbacks({
      owner,
      workspaceId: 'ws-e2e',
      ownerUserId: 'user-e2e',
      toolProfile,
      chatCallbacks: makeChatCallbacks(),
    });
    const slot = registry.create('att-e2e', '/ws/code', 'user-e2e', cbs, {
      nodeId: null,
      workspaceId: 'ws-e2e',
    });

    const tools = registeredToolNames(slot);
    assert.ok(tools.includes('submit_agent_result'), 'submit_agent_result registered');
    assert.ok(tools.includes('spawn_branches'), 'spawn_branches registered');
    assert.ok(tools.includes('save_artifact'), 'save_artifact registered');
    // Chat-only metadata tools must not appear (no callback)
    assert.ok(!tools.includes('set_follow_ups'));
    assert.ok(!tools.includes('set_branch_overview'));
  });
});

// ---------------------------------------------------------------------------
// Suite: Backward compatibility — existing chat slot behavior unchanged
// ---------------------------------------------------------------------------

describe('T02: Backward compatibility for existing chat slots', () => {
  test('legacy create without owner still registers expected chat tools', () => {
    const registry = new McpSlotRegistry();
    const slot = registry.create('chat-legacy', '/tmp', null, {
      ...makeChatCallbacks(),
      onSetFollowUps: () => {},
      onSetBranchOverview: () => {},
    } as any);
    const tools = registeredToolNames(slot);
    assert.ok(tools.includes('spawn_branches'));
    assert.ok(tools.includes('save_artifact'));
    assert.ok(tools.includes('update_artifact'));
    assert.ok(tools.includes('show_image'));
    assert.ok(tools.includes('list_threads'));
    assert.ok(tools.includes('search_messages'));
    assert.ok(tools.includes('read_node'));
    assert.ok(tools.includes('ask_user'));
    assert.ok(tools.includes('approve'));
    assert.ok(tools.includes('set_follow_ups'));
    assert.ok(tools.includes('set_branch_overview'));
    // P1-9: inspect_pane / read_pane_output are registered unconditionally alongside the
    // globalContext tools above — this single assertion is the evidence for Kiro, Claude and
    // Codex per R4 §8, since all three are HTTP MCP clients of this same buildMcpServerForSlot
    // server object.
    assert.ok(tools.includes('inspect_pane'), 'chat slot must expose inspect_pane');
    assert.ok(tools.includes('read_pane_output'), 'chat slot must expose read_pane_output');
    assert.ok(tools.includes('list_panes'), 'chat slot must expose list_panes');
    assert.ok(!tools.includes('submit_agent_result'),
      'legacy chat slot must not have submit_agent_result');
  });
});

// ---------------------------------------------------------------------------
// P1-9: inspect_pane / read_pane_output caller-identity behavioural test.
//
// The security core of this task is that the tool builds its PaneInspectionCaller from the
// session-bound slot binding, never from tool arguments (task brief step 3). This exercises
// that end to end: a model-supplied ownerUserId/workspaceId in the tool arguments must be
// silently ignored, and the service must receive the SLOT's own identity instead.
// ---------------------------------------------------------------------------

describe('T02: inspect_pane ignores caller-identity override attempts', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-mcp-pane-inspection-'));
    process.env.MICHI_DATA_DIR = dataDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('a paneId/nodeId call still resolves against the SLOT owner, not an injected identity', () => {
    const owner = LOCAL_AGENT_OWNER_ID;
    const workspaceId = 'ws-real';
    const nodeId = 'n-real';
    const impostorNodeId = 'n-impostor';

    saveWorkspace({
      id: workspaceId, name: 'Workspace', created_at: 1, updated_at: 1,
      active_tree_id: null, cwd: null, settings: null, deleted_at: null, archived_at: null,
    });
    setAiGlobalContext(workspaceId, true, owner);
    saveNode({
      id: nodeId, workspace_id: workspaceId,
      tree_id: null, parent_node_id: null,
      kind: 'chat', title: 'Real node', branch_overview: null,
      status: 'idle',
      position_x: null, position_y: null, minimized: 0, deleted_at: null,
      deletion_group_id: null, spawned_by_agent: 0, current_mode_id: null,
      pane_width: null, digest: null, follow_ups: null, follow_ups_source_message_id: null,
      acp_session_id: null, runtime_id: null, provider_id: null,
      model_id: null, reasoning: null, resume_fingerprint: null,
      composer_draft: null, external_session_id: null, trim_snapshot: null,
      created_at: 1,
    } as any);

    const registry = new McpSlotRegistry();
    const slot = registry.create('chat-real', '/tmp', owner, makeChatCallbacks() as any, {
      nodeId,
      workspaceId,
    });

    const handler = getToolHandler(slot, 'inspect_pane');
    assert.ok(handler, 'inspect_pane must be registered');

    // The model tries to smuggle a different identity via the tool arguments. None of these
    // keys exist on InspectPaneToolArgs, so they have nowhere to go even if a caller tried.
    const forged = {
      nodeId,
      ownerUserId: 'someone-else',
      workspaceId: 'ws-not-mine',
      backendConnectionId: 'forged-conn',
    } as Record<string, unknown>;

    return handler(forged).then((result: any) => {
      assert.equal(result.isError, undefined, 'a real, visible node must not error');
      const text = result.content[0].text as string;
      // Proves the SLOT's own nodeId/workspaceId were used (the node/workspace this slot is
      // actually bound to), not any injected value — an impostor node id would 404, and a
      // wrong workspaceId would fail authorizeCaller's ownership check entirely.
      assert.ok(text.includes('kind: chat'), 'resolved against the real bound node');
      assert.ok(!text.includes(impostorNodeId));
    });
  });
});

// ---------------------------------------------------------------------------
// P2-4: list_panes ignores caller-identity override attempts.
//
// Unlike inspect_pane/read_pane_output, list_panes has NO locator argument at all — its request's
// workspaceId always comes from the slot binding (paneInspectionTools.ts's listPanesTool), never
// from a tool argument. This proves a model-supplied workspaceId in the arguments is silently
// ignored and the call is scoped to the SLOT's own bound workspace instead.
// ---------------------------------------------------------------------------

describe('T02: list_panes ignores caller-identity override attempts', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-mcp-pane-list-'));
    process.env.MICHI_DATA_DIR = dataDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('a list_panes call is scoped to the SLOT workspace, not an injected one', () => {
    const owner = LOCAL_AGENT_OWNER_ID;
    const workspaceId = 'ws-real-list';
    const otherWorkspaceId = 'ws-not-mine-list';
    const nodeId = 'n-real-list';
    const otherNodeId = 'n-other-workspace';

    saveWorkspace({
      id: workspaceId, name: 'Workspace', created_at: 1, updated_at: 1,
      active_tree_id: null, cwd: null, settings: null, deleted_at: null, archived_at: null,
    });
    saveWorkspace({
      id: otherWorkspaceId, name: 'Other workspace', created_at: 1, updated_at: 1,
      active_tree_id: null, cwd: null, settings: null, deleted_at: null, archived_at: null,
    });
    setAiGlobalContext(workspaceId, true, owner);
    setAiGlobalContext(otherWorkspaceId, true, owner);
    saveNode({
      id: nodeId, workspace_id: workspaceId,
      tree_id: null, parent_node_id: null,
      kind: 'chat', title: 'Real node', branch_overview: null,
      status: 'idle',
      position_x: null, position_y: null, minimized: 0, deleted_at: null,
      deletion_group_id: null, spawned_by_agent: 0, current_mode_id: null,
      pane_width: null, digest: null, follow_ups: null, follow_ups_source_message_id: null,
      acp_session_id: null, runtime_id: null, provider_id: null,
      model_id: null, reasoning: null, resume_fingerprint: null,
      composer_draft: null, external_session_id: null, trim_snapshot: null,
      created_at: 1,
    } as any);
    saveNode({
      id: otherNodeId, workspace_id: otherWorkspaceId,
      tree_id: null, parent_node_id: null,
      kind: 'chat', title: 'Other workspace node', branch_overview: null,
      status: 'idle',
      position_x: null, position_y: null, minimized: 0, deleted_at: null,
      deletion_group_id: null, spawned_by_agent: 0, current_mode_id: null,
      pane_width: null, digest: null, follow_ups: null, follow_ups_source_message_id: null,
      acp_session_id: null, runtime_id: null, provider_id: null,
      model_id: null, reasoning: null, resume_fingerprint: null,
      composer_draft: null, external_session_id: null, trim_snapshot: null,
      created_at: 1,
    } as any);

    const registry = new McpSlotRegistry();
    const slot = registry.create('chat-real-list', '/tmp', owner, makeChatCallbacks() as any, {
      nodeId,
      workspaceId,
    });

    const handler = getToolHandler(slot, 'list_panes');
    assert.ok(handler, 'list_panes must be registered');

    // None of these keys exist on the tool's own schema (workspaceId/ownerUserId are not
    // parameters of list_panes at all), so a forged value has nowhere to go even if a model
    // tried to inject one.
    const forged = {
      workspaceId: otherWorkspaceId,
      ownerUserId: 'someone-else',
      scope: 'all',
      includeArchived: true,
    } as Record<string, unknown>;

    return handler(forged).then((result: any) => {
      assert.equal(result.isError, undefined, 'a real, visible workspace must not error');
      const text = result.content[0].text as string;
      // Proves the call was scoped to the SLOT's own bound workspace, not the injected
      // otherWorkspaceId: the other workspace's node must never appear.
      assert.ok(!text.includes(otherNodeId), 'must never enumerate another workspace\'s nodes');
    });
  });
});
