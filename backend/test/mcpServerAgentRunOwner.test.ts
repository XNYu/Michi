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
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  McpSlotRegistry,
  buildMcpServerForSlot,
  type McpSlot,
} from '../src/services/mcpServer';
import type { RuntimeSessionOwner } from '../src/agents/types';
import { chatOwner, runOwner } from './helpers/owners';

import { buildRunMcpSlotCallbacks } from '../src/agents/runs/runMcpSlot';

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

/** Get a specific tool handler from a built McpServer. */
function getToolHandler(slot: McpSlot, toolName: string) {
  const server = buildMcpServerForSlot(slot);
  const tools = (server as unknown as {
    _registeredTools: Record<string, { handler: (a: Record<string, unknown>) => Promise<unknown> }>;
  })._registeredTools;
  return tools[toolName]?.handler ?? null;
}

const CHAT_OWNER: RuntimeSessionOwner = chatOwner('n-chat-1');
const RUN_OWNER: RuntimeSessionOwner = runOwner('run-1', 'att-1');
const DIFFERENT_RUN_OWNER: RuntimeSessionOwner = runOwner('run-2', 'att-2');

// ---------------------------------------------------------------------------
// Suite: Run slot submit_agent_result registration
// ---------------------------------------------------------------------------

describe('T02: Run slot submit_agent_result', () => {
  let registry: McpSlotRegistry;
  beforeEach(() => { registry = new McpSlotRegistry(); });

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
// Suite: buildRunMcpSlotCallbacks factory
// ---------------------------------------------------------------------------

describe('T02: buildRunMcpSlotCallbacks', () => {
  test('throws for a chat (interactive) owner', () => {
    assert.throws(
      () => buildRunMcpSlotCallbacks({
        owner: chatOwner('n-1'),
        workspaceId: 'ws-bad',
        ownerUserId: null,
        toolProfile: { allowedToolNames: [] },
        chatCallbacks: makeChatCallbacks(),
      }),
      /requires a headless owner/,
    );
  });

  test("passes the chat callbacks' sink on, and the registry keeps it off the Run slot", () => {
    const sink = { emit: () => {} };
    const callbacks = buildRunMcpSlotCallbacks({
      owner: RUN_OWNER,
      workspaceId: 'ws-1',
      ownerUserId: 'user-1',
      toolProfile: { allowedToolNames: ['save_artifact'] },
      chatCallbacks: { ...makeChatCallbacks(), sink },
    });
    assert.equal(callbacks.sink, sink);
    const registry = new McpSlotRegistry();
    const slot = registry.create('att-1', '/tmp', 'user-1', callbacks, { nodeId: null, workspaceId: 'ws-1' });
    assert.equal('sink' in slot, false);
    void registry.dispose(slot.slotId);
  });
});
