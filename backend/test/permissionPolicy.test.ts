/**
 * Tests for resolvePolicy — the permission categorizer shared by the Pi and
 * Claude runtimes.
 *
 * Passing workspaceId=null skips the workspace-grant DB lookup, so these are
 * pure unit tests of categorization + Claude PascalCase normalization with no
 * database dependency.
 *
 * Run: cd backend && npm test -- --test-name-pattern permissionPolicy
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalPermissionToolName, resolvePolicy } from '../src/agents/permissionPolicy';

describe('resolvePolicy', () => {
    // ── Read-only / intentional tools default to allow ────────────────────────

    for (const tool of ['read', 'ls', 'grep', 'find', 'list_threads', 'search_messages', 'read_node', 'spawn_branches', 'save_context', 'update_context']) {
        test(`allows read-only/intentional tool "${tool}"`, () => {
            assert.equal(resolvePolicy(null, tool, {}), 'allow');
        });
    }

    // ── Pi runtime lowercase write/exec default to ask ────────────────────────

    for (const tool of ['write', 'edit', 'bash']) {
        test(`asks for Pi write/exec tool "${tool}"`, () => {
            assert.equal(resolvePolicy(null, tool, {}), 'ask');
        });
    }

    // ── Claude runtime PascalCase write/exec normalize to ask ─────────────────
    // Regression guard: an exact-match set would classify these as "allow",
    // silently disabling the gate for every Claude write/exec call.

    for (const tool of ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
        test(`asks for Claude write/exec tool "${tool}" (casing normalized)`, () => {
            assert.equal(resolvePolicy(null, tool, {}), 'ask');
        });
    }

    test('canonicalizes Claude write/exec aliases for persisted grants', () => {
        assert.equal(canonicalPermissionToolName('Bash'), 'bash');
        assert.equal(canonicalPermissionToolName('Edit'), 'edit');
        assert.equal(canonicalPermissionToolName('Write'), 'write');
        assert.equal(canonicalPermissionToolName('MultiEdit'), 'edit');
        assert.equal(canonicalPermissionToolName('NotebookEdit'), 'edit');
        assert.equal(canonicalPermissionToolName('read'), 'read');
    });

    // ── Unknown / MCP tools fall through to allow ─────────────────────────────

    test('allows unknown tool names', () => {
        assert.equal(resolvePolicy(null, 'mcp__probe__echo_tool', {}), 'allow');
        assert.equal(resolvePolicy(null, 'Read', {}), 'allow');
    });

    test("a workspace grant flips ask→allow via the injected store", () => {
        const { configureRuntimeDeps, __resetRuntimeDeps } = require("../src/agents/runtimeDeps");
        configureRuntimeDeps({
            historyStore: {
                getNode: () => null, listMessages: () => [], getWorkspace: () => null,
                getWorkspaceInstructions: () => null,
                hasGrant: (ws: string, tool: string) => ws === "ws1" && tool === "bash",
                grantPermission: () => {},
            },
            agentConfig: { getAgentConfig: () => ({ runtime: "pi", provider: "x", modelByRuntime: {}, reasoningByRuntime: {} }), resolveModel: () => "", resolveReasoning: () => undefined },
            dataDir: "/tmp/agent-runtime-test",
        });
        assert.equal(resolvePolicy("ws1", "bash", {}), "allow");
        assert.equal(resolvePolicy("ws2", "bash", {}), "ask");
        __resetRuntimeDeps();
    });
});
