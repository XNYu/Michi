/**
 * Tests for Step 3 of Claude Code Runtime:
 *   - McpSlotRegistry (extended with transport ownership)
 *   - the follow-up and Stop Hook tools; the removed approve tool stays gone
 *
 * Uses node:test (Node 22+) + ts-node.
 * Run: cd backend && npm test -- --test-name-pattern mcpServerStep3
 *
 * Strategy: direct handler invocation via McpServer._registeredTools[name].handler
 * to avoid spinning up a real HTTP server for unit-level tool tests.
 * McpSlotRegistry is tested by exercising its public API directly.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    McpSlotRegistry,
    buildMcpServerForSlot,
    validateCodexStopHookForSlot,
} from '../src/services/mcpServer';
import { runOwner } from './helpers/owners';

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
    };
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

    test('generic Agent tools honor the session capability allow-list', () => {
        const slot = registry.create('attempt-tools', '/tmp', 'owner-a', {
            ...makeCallbacks(),
            agentRuns: { invoke: async () => ({ ok: true }) },
            agentRunToolNames: ['spawn_agent'],
        } as never);
        const tools = (buildMcpServerForSlot(slot) as any)._registeredTools;
        assert.ok(tools['spawn_agent']);
        assert.equal(tools['list_agents'], undefined);
        assert.equal(tools['wait_agent'], undefined);
    });

    test('run-owned slots do not register any tool outside exposedToolNames', () => {
        const slot = registry.create('attempt-strict-tools', '/tmp', 'owner-a', {
            ...makeCallbacks(),
            owner: runOwner('run-a', 'attempt-strict-tools'),
            exposedToolNames: new Set(['submit_agent_result']),
            onSubmitAgentResult: () => ({ version: 1, status: 'completed' }),
            onSetFollowUps: () => {},
            onSetBranchOverview: () => {},
            onValidateFollowUps: () => ({}),
            onAskUser: async () => ({}),
        } as never);
        const tools = (buildMcpServerForSlot(slot) as any)._registeredTools;

        assert.ok(tools['submit_agent_result']);
        for (const denied of [
            'spawn_branches', 'save_artifact', 'update_artifact', 'show_image',
            'set_follow_ups', 'set_branch_overview', 'validate_follow_ups', 'validate_turn_metadata',
            'list_threads', 'search_messages', 'read_node', 'read_node_overview',
            'inspect_pane', 'read_pane_output', 'list_panes', 'wait_pane', 'send_to_thread', 'ask_user',
        ]) {
            assert.equal(tools[denied], undefined, `${denied} must not be registered`);
        }
    });

    test('a chat slot offers spawn_branches, save_artifact and update_artifact only with their callbacks', () => {
        const PRODUCT_TOOLS = { spawn_branches: 'onSpawnBranches', save_artifact: 'onSaveArtifact', update_artifact: 'onUpdateArtifact' } as const;
        const all = (buildMcpServerForSlot(registry.create('chat-all', '/tmp', null, makeCallbacks())) as any)._registeredTools;
        for (const name of Object.keys(PRODUCT_TOOLS)) assert.ok(all[name], `${name} is registered with its callback`);
        for (const [name, callback] of Object.entries(PRODUCT_TOOLS)) {
            const { [callback]: _left, ...rest } = makeCallbacks();
            const tools = (buildMcpServerForSlot(registry.create(`chat-without-${name}`, '/tmp', null, rest)) as any)._registeredTools;
            assert.equal(tools[name], undefined, `${name} is not registered without ${callback}`);
            for (const other of Object.keys(PRODUCT_TOOLS).filter((tool) => tool !== name)) assert.ok(tools[other], `${other} stays`);
        }
        const none = (buildMcpServerForSlot(registry.create('chat-none', '/tmp', null, { onShowImage: makeCallbacks().onShowImage })) as any)._registeredTools;
        for (const name of Object.keys(PRODUCT_TOOLS)) assert.equal(none[name], undefined);
        assert.ok(none['show_image'], 'the other side-effect tools are unaffected');
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
// Suite: removed approve MCP tool
// ---------------------------------------------------------------------------

describe('approve MCP tool', () => {
    test('no slot offers it: Claude gates tools through the Agent SDK canUseTool', () => {
        const registry = new McpSlotRegistry();
        const slot = registry.create('chat-no-approve', '/tmp', null, {
            ...makeCallbacks(),
            onAskUser: async () => ({}),
            onApprove: async () => ({ behavior: 'allow' }),
        } as never);
        const tools = (buildMcpServerForSlot(slot) as any)._registeredTools;
        assert.ok(tools.ask_user);
        assert.equal(tools.approve, undefined);
    });
});

test('save_artifact forwards a file path without requiring a Markdown body', async () => {
    const registry = new McpSlotRegistry();
    let received: unknown[] = [];
    const slot = registry.create('file-chat', '/tmp', null, {
        ...makeCallbacks(),
        onSaveArtifact: (name, body, path) => {
            received = [name, body, path];
            return { name, filePath: path!, size: 5 };
        },
    });
    const handler = getToolHandler(registry, slot.slotId, 'save_artifact');
    await handler({ name: 'shot', path: '.attachments/shot.png' });
    assert.deepEqual(received, ['shot', undefined, '.attachments/shot.png']);
    await assert.rejects(() => handler({ name: 'shot', path: 'shot.png', body: 'text' }), /exactly one/);
});
