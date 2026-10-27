/**
 * Tests for michiGrantKey — the key chat always-allow grants are stored
 * under, which Michi's permission port gives adapters as grantKey. Chat policy itself is
 * covered by chatPermissionRuntimes and chatApprovalState; the names each
 * adapter sends by permissionToolNames.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { michiGrantKey } from '../src/agents/permissionPolicy';
import { michiPermissionPolicy } from '../src/agents/chatApprovalState';

for (const [label, grantKey] of [['michiGrantKey', michiGrantKey], ['michiPermissionPolicy.grantKey', michiPermissionPolicy.grantKey!]] as const) {
    describe(label, () => {
        // Regression guard: a grant for Claude's PascalCase write/exec tools must
        // share the key of the canonical tool, or "Trust this tool" never matches.
        test('Claude PascalCase write/exec tools share the canonical grant key', () => {
            const expected: Record<string, string> = { Bash: 'bash', Edit: 'edit', Write: 'write', MultiEdit: 'edit', NotebookEdit: 'edit' };
            for (const [tool, key] of Object.entries(expected)) assert.equal(grantKey(tool), key, tool);
        });

        test('every other name is its own key, including read-only Claude tools', () => {
            for (const tool of ['bash', 'edit', 'write', 'read', 'Read', 'Glob', 'Grep', 'fs_write', 'execute_bash',
                'mcp__probe__echo_tool', 'mcp____michi_internal____read_node', '@michi/send_to_thread']) {
                assert.equal(grantKey(tool), tool, tool);
            }
        });
    });
}
