/**
 * Tests for Step 3 of Claude Code Runtime:
 *   - McpSlotRegistry (extended with transport ownership)
 *   - approve MCP tool handler
 *
 * Uses node:test (Node 22+) + ts-node.
 * Run: cd backend && npm test -- --test-name-pattern mcpServerStep3
 *
 * Strategy: direct handler invocation via McpServer._registeredTools[name].handler
 * to avoid spinning up a real HTTP server for unit-level approve tool tests.
 * McpSlotRegistry is tested by exercising its public API directly.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    McpSlotRegistry,
    buildMcpServerForSlot,
    validateCodexStopHookForSlot,
} from '../src/services/mcpServer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal no-op callbacks that satisfy McpSlotCallbacks. */
function makeCallbacks() {
    return {
        onSpawnBranches: async () => [],
        onSaveArtifact: () => null,
        onUpdateArtifact: () => null,
        onShowImage: () => ({ error: 'unsupported in test' }),
        onApprove: undefined as McpSlotRegistry extends infer _ ? undefined : never,
    };
}

/**
 * Build the production McpServer for a slot via the exported
 * buildMcpServerForSlot and return its `approve` tool handler, pulled directly
 * from the registered tools. No transport / HTTP round-trip is needed — this
 * exercises the real production wiring (same slot reference, same callbacks).
 */
function getApproveHandler(
    registry: McpSlotRegistry,
    slotId: string,
): (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }> {
    const slot = registry.get(slotId)!;
    const server = buildMcpServerForSlot(slot);
    const registeredTools = (server as unknown as { _registeredTools: Record<string, { handler: (a: Record<string, unknown>) => Promise<unknown> }> })._registeredTools;
    const toolEntry = registeredTools['approve'];
    assert.ok(toolEntry, 'approve tool must be registered on the McpServer');
    return toolEntry.handler as (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

function getToolHandler(
    registry: McpSlotRegistry,
    slotId: string,
    toolName: string,
): (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }> {
    const slot = registry.get(slotId)!;
    const server = buildMcpServerForSlot(slot);
    const registeredTools = (server as unknown as {
        _registeredTools: Record<string, { handler: (a: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const toolEntry = registeredTools[toolName];
    assert.ok(toolEntry, `${toolName} tool must be registered on the McpServer`);
    return toolEntry.handler as (args: Record<string, unknown>) => Promise<{
        content: Array<{ type: string; text: string }>;
    }>;
}

// ---------------------------------------------------------------------------
// Suite: McpSlotRegistry
// ---------------------------------------------------------------------------

describe('McpSlotRegistry', () => {
    let registry: McpSlotRegistry;

    beforeEach(() => {
        registry = new McpSlotRegistry();
    });

    // ── Case 1: create returns a properly shaped slot ──────────────────────────

    test('create returns slot with 16-byte hex slotId, parentChatId, cwd, null nodeId, and null workspaceId', () => {
        const cbs = makeCallbacks();
        const slot = registry.create('parent-123', '/home/user/project', null, cbs as never);

        // slotId must be a 32-char hex string (16 bytes × 2 hex digits each)
        assert.match(slot.slotId, /^[0-9a-f]{32}$/, 'slotId must be a 32-char lowercase hex string');
        assert.equal(slot.nodeId, null);
        assert.equal(slot.parentChatId, 'parent-123');
        assert.equal(slot.cwd, '/home/user/project');
        assert.equal(slot.workspaceId, null);
        assert.equal(typeof slot.onSpawnBranches, 'function');
        assert.equal(typeof slot.onSaveArtifact, 'function');
        assert.equal(typeof slot.onUpdateArtifact, 'function');
    });

    // ── Case 2: get returns the same slot; unknown slotId returns undefined ────

    test('get returns the same slot object that was created', () => {
        const cbs = makeCallbacks();
        const slot = registry.create('parent-abc', '/tmp', null, cbs as never);

        const retrieved = registry.get(slot.slotId);
        assert.ok(retrieved !== undefined, 'get must return the slot');
        assert.equal(retrieved.slotId, slot.slotId);
        assert.equal(retrieved.nodeId, null);
        assert.equal(retrieved.parentChatId, 'parent-abc');
    });

    test('create can bind a slot to a Michi node id and workspace cache', () => {
        const cbs = makeCallbacks();
        const slot = registry.create('runtime-session-1', '/tmp', 'user-1', cbs as never, {
            nodeId: 'node-1',
            workspaceId: 'workspace-1',
        });

        assert.equal(slot.nodeId, 'node-1');
        assert.equal(slot.parentChatId, 'runtime-session-1');
        assert.equal(slot.workspaceId, 'workspace-1');
        assert.equal(slot.ownerUserId, 'user-1');
    });

    test('get returns undefined for an unknown slotId', () => {
        const result = registry.get('00000000000000000000000000000000');
        assert.equal(result, undefined);
    });

    // ── Case 3: dispose removes the slot ──────────────────────────────────────

    test('dispose removes the slot so get returns undefined afterward', async () => {
        const cbs = makeCallbacks();
        const slot = registry.create('chat-dispose', '/tmp', null, cbs as never);

        await registry.dispose(slot.slotId);

        assert.equal(registry.get(slot.slotId), undefined, 'slot must be gone after dispose');
    });

    // ── Case 4: dispose is idempotent ─────────────────────────────────────────

    test('dispose is idempotent — calling it twice does not throw', async () => {
        const cbs = makeCallbacks();
        const slot = registry.create('chat-idempotent', '/tmp', null, cbs as never);

        await registry.dispose(slot.slotId);
        // Second call on the same (now-gone) slotId must not throw
        await assert.doesNotReject(
            () => registry.dispose(slot.slotId),
            'second dispose must not throw',
        );
    });

    // ── Case 5: dispose with no transport does not throw ──────────────────────

    test('dispose of a slot that never had a transport does not throw', async () => {
        const cbs = makeCallbacks();
        const slot = registry.create('chat-no-transport', '/tmp', null, cbs as never);

        await assert.doesNotReject(
            () => registry.dispose(slot.slotId),
            'dispose without prior transport must not throw',
        );
        assert.equal(registry.get(slot.slotId), undefined);
    });

    // ── Case 6: buildMcpServerForSlot wires the production tools for a slot ────

    test('buildMcpServerForSlot registers the approve + side-effect tools for a slot', () => {
        const cbs = makeCallbacks();
        const slot = registry.create('chat-build', '/tmp', null, cbs as never);

        const server = buildMcpServerForSlot(slot);
        const registered = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;

        assert.ok(registered['approve'], 'approve tool must be registered');
        assert.ok(registered['save_artifact'], 'save_artifact tool must be registered');
        assert.ok(registered['spawn_branches'], 'spawn_branches tool must be registered');
        assert.equal(registered['set_follow_ups'], undefined, 'POC tool stays hidden without callback');
        assert.equal(registered['set_branch_overview'], undefined, 'overview tool stays hidden without callback');
        assert.equal(registered['validate_follow_ups'], undefined, 'POC validator stays hidden without callback');
        assert.equal(registered['validate_turn_metadata'], undefined, 'metadata validator stays hidden without callback');
    });

    test('registers metadata POC tools only when callbacks are supplied', () => {
        const slot = registry.create('chat-follow-ups', '/tmp', null, {
            ...makeCallbacks(),
            onSetFollowUps: () => {},
            onSetBranchOverview: () => {},
            onValidateFollowUps: () => ({}),
        } as never);

        const server = buildMcpServerForSlot(slot);
        const registered = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
        assert.ok(registered['set_follow_ups']);
        assert.ok(registered['set_branch_overview']);
        assert.ok(registered['validate_follow_ups']);
        assert.ok(registered['validate_turn_metadata']);
    });
});

describe('Claude follow-up POC MCP tools', () => {
    let registry: McpSlotRegistry;

    beforeEach(() => {
        registry = new McpSlotRegistry();
    });

    test('set_follow_ups trims values and forwards at most three questions', async () => {
        let captured: string[] = [];
        const slot = registry.create('chat-follow-ups-set', '/tmp', null, {
            ...makeCallbacks(),
            onSetFollowUps: (followUps: string[]) => { captured = followUps; },
        } as never);
        const handler = getToolHandler(registry, slot.slotId, 'set_follow_ups');

        const result = await handler({
            follow_ups: [' first? ', '', 'second?', ' third? ', 'fourth?'],
        });

        assert.deepEqual(captured, ['first?', 'second?', 'third?']);
        assert.equal(result.content[0].text, 'Follow-ups set: 3');
    });

    test('set_branch_overview trims and forwards the durable text block', async () => {
        let captured = '';
        const slot = registry.create('chat-overview-set', '/tmp', null, {
            ...makeCallbacks(),
            onSetBranchOverview: (overview: string) => { captured = overview; },
        } as never);
        const handler = getToolHandler(registry, slot.slotId, 'set_branch_overview');

        const result = await handler({ overview: '  Current branch state.  ' });

        assert.equal(captured, 'Current branch state.');
        assert.equal(result.content[0].text, 'Branch overview updated.');
    });

    test('set_branch_overview requests a hidden completion response for Kiro slots', async () => {
        const slot = registry.create('chat-overview-kiro', '/tmp', null, {
            ...makeCallbacks(),
            onSetBranchOverview: () => {},
            metadataDoneSentinel: '[MICHI_METADATA_DONE]',
        } as never);
        const handler = getToolHandler(registry, slot.slotId, 'set_branch_overview');

        const result = await handler({ overview: 'Current branch state.' });

        assert.equal(
            result.content[0].text,
            'Branch overview updated. Respond with exactly [MICHI_METADATA_DONE] and no other text.',
        );
    });

    test('validate_follow_ups returns callback JSON for Claude Stop-hook decision parsing', async () => {
        const decision = {
            decision: 'block',
            reason: 'Call set_follow_ups before stopping.',
        };
        const slot = registry.create('chat-follow-ups-validate', '/tmp', null, {
            ...makeCallbacks(),
            onValidateFollowUps: () => decision,
        } as never);
        const handler = getToolHandler(registry, slot.slotId, 'validate_follow_ups');

        const result = await handler({});

        assert.deepEqual(JSON.parse(result.content[0].text), decision);
    });

    test('validate_turn_metadata uses the same bounded validator callback', async () => {
        const decision = {
            decision: 'block',
            reason: 'Call missing metadata tools before stopping.',
        };
        const slot = registry.create('chat-metadata-validate', '/tmp', null, {
            ...makeCallbacks(),
            onValidateFollowUps: () => decision,
        } as never);
        const handler = getToolHandler(registry, slot.slotId, 'validate_turn_metadata');

        const result = await handler({});

        assert.deepEqual(JSON.parse(result.content[0].text), decision);
    });
});

describe('Codex follow-up POC Stop Hook routing', () => {
    test('random slot capability routes concurrent branches to the correct validator', () => {
        const registry = new McpSlotRegistry();
        let branchACalls = 0;
        let branchBCalls = 0;
        const slotA = registry.create('branch-a', '/tmp', null, {
            ...makeCallbacks(),
            onValidateFollowUps: () => {
                branchACalls += 1;
                return { decision: 'block', reason: 'branch-a' };
            },
        } as never);
        const slotB = registry.create('branch-b', '/tmp', null, {
            ...makeCallbacks(),
            onValidateFollowUps: () => {
                branchBCalls += 1;
                return { decision: 'block', reason: 'branch-b' };
            },
        } as never);

        const result = validateCodexStopHookForSlot(registry, slotB.slotId, {
            hook_event_name: 'Stop',
            session_id: 'codex-thread-b',
        });

        assert.deepEqual(result, { decision: 'block', reason: 'branch-b' });
        assert.equal(branchACalls, 0);
        assert.equal(branchBCalls, 1);
        assert.notEqual(slotA.slotId, slotB.slotId);
    });

    test('unknown slot and non-Stop payload fail open', () => {
        const registry = new McpSlotRegistry();
        const slot = registry.create('branch-a', '/tmp', null, {
            ...makeCallbacks(),
            onValidateFollowUps: () => ({ decision: 'block' }),
        } as never);

        assert.deepEqual(
            validateCodexStopHookForSlot(registry, 'missing-slot', { hook_event_name: 'Stop' }),
            {},
        );
        assert.deepEqual(
            validateCodexStopHookForSlot(registry, slot.slotId, { hook_event_name: 'PostToolUse' }),
            {},
        );
    });
});

// ---------------------------------------------------------------------------
// Suite: approve MCP tool
// ---------------------------------------------------------------------------

describe('approve MCP tool', () => {
    let registry: McpSlotRegistry;

    beforeEach(() => {
        registry = new McpSlotRegistry();
    });

    afterEach(async () => {
        // Nothing persistent to clean up since we do not spin up HTTP
    });

    // ── Case 7: returns deny when slot.onApprove is undefined ─────────────────

    test('returns deny response when slot has no onApprove callback', async () => {
        const cbs = makeCallbacks(); // onApprove is undefined
        const slot = registry.create('chat-no-approve', '/tmp', null, cbs as never);
        const handler = getApproveHandler(registry, slot.slotId);

        const result = await handler({ tool_name: 'bash', input: {}, tool_use_id: 'tid-1' });

        assert.equal(result.content.length, 1);
        const parsed = JSON.parse(result.content[0].text);
        assert.equal(parsed.behavior, 'deny');
        assert.ok(typeof parsed.message === 'string' && parsed.message.length > 0);
    });

    // ── Case 8: calls onApprove with camelCase params ─────────────────────────

    test('calls slot.onApprove with toolName, input, and toolUseId mapped from snake_case args', async () => {
        let capturedParams: unknown = null;
        const slot = registry.create('chat-capture', '/tmp', null, {
            onSpawnBranches: async () => [],
            onSaveArtifact: () => null,
            onUpdateArtifact: () => null,
            onShowImage: () => ({ error: 'unsupported in test' }),
            onApprove: async (params) => {
                capturedParams = params;
                return { behavior: 'allow' as const };
            },
        });
        const handler = getApproveHandler(registry, slot.slotId);

        await handler({ tool_name: 'write_file', input: { path: '/tmp/x' }, tool_use_id: 'tool-use-42' });

        assert.ok(capturedParams !== null, 'onApprove must have been called');
        const p = capturedParams as { toolName: string; input: unknown; toolUseId: string };
        assert.equal(p.toolName, 'write_file');
        assert.deepEqual(p.input, { path: '/tmp/x' });
        assert.equal(p.toolUseId, 'tool-use-42');
    });

    // ── Case 9: stringifies onApprove return value into content[0].text ───────

    test('stringifies the onApprove return value as JSON into content[0].text', async () => {
        const slot = registry.create('chat-stringify', '/tmp', null, {
            onSpawnBranches: async () => [],
            onSaveArtifact: () => null,
            onUpdateArtifact: () => null,
            onShowImage: () => ({ error: 'unsupported in test' }),
            onApprove: async () => ({ behavior: 'allow' as const, updatedInput: { x: 1 } }),
        });
        const handler = getApproveHandler(registry, slot.slotId);

        const result = await handler({ tool_name: 'any', input: null, tool_use_id: 'tid' });

        assert.equal(result.content.length, 1);
        assert.equal(result.content[0].type, 'text');
        // Must be valid JSON
        const parsed = JSON.parse(result.content[0].text);
        assert.equal(parsed.behavior, 'allow');
        assert.deepEqual(parsed.updatedInput, { x: 1 });
    });

    // ── Case 10: behavior:allow with updatedInput round-trips ─────────────────

    test('behavior allow with updatedInput round-trips through the handler response', async () => {
        const updatedInput = { command: 'ls', args: ['-la'] };
        const slot = registry.create('chat-allow', '/tmp', null, {
            onSpawnBranches: async () => [],
            onSaveArtifact: () => null,
            onUpdateArtifact: () => null,
            onShowImage: () => ({ error: 'unsupported in test' }),
            onApprove: async () => ({ behavior: 'allow' as const, updatedInput }),
        });
        const handler = getApproveHandler(registry, slot.slotId);

        const result = await handler({ tool_name: 'bash', input: { command: 'ls' }, tool_use_id: 'tid-allow' });
        const parsed = JSON.parse(result.content[0].text);

        assert.equal(parsed.behavior, 'allow');
        assert.deepEqual(parsed.updatedInput, updatedInput);
    });

    // ── Case 11: behavior:deny with message round-trips ───────────────────────

    test('behavior deny with message round-trips through the handler response', async () => {
        const slot = registry.create('chat-deny', '/tmp', null, {
            onSpawnBranches: async () => [],
            onSaveArtifact: () => null,
            onUpdateArtifact: () => null,
            onShowImage: () => ({ error: 'unsupported in test' }),
            onApprove: async () => ({ behavior: 'deny' as const, message: 'not allowed in production' }),
        });
        const handler = getApproveHandler(registry, slot.slotId);

        const result = await handler({ tool_name: 'rm', input: { path: '/etc' }, tool_use_id: 'tid-deny' });
        const parsed = JSON.parse(result.content[0].text);

        assert.equal(parsed.behavior, 'deny');
        assert.equal(parsed.message, 'not allowed in production');
    });
});
