/**
 * Tests for agentConfig event emitter.
 *
 * Uses node:test (Node 22+). Stubs fs.writeFileSync to keep the user's
 * real ~/.michi/config.json out of the loop.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// agentConfig.persist() calls fs.writeFileSync. Monkey-patch the CJS fs
// module directly (works through ts-node's CommonJS interop) so tests
// don't churn the real ~/.michi/config.json.
let origWriteFileSync: typeof import('node:fs').writeFileSync;
function stubFsWrite(): void {
    const fsCjs = require('fs');
    origWriteFileSync = fsCjs.writeFileSync;
    fsCjs.writeFileSync = () => { /* noop */ };
}
function restoreFsWrite(): void {
    require('fs').writeFileSync = origWriteFileSync;
}

describe('agentConfig events', () => {
    beforeEach(stubFsWrite);
    afterEach(restoreFsWrite);

    test('emits model_changed when updateAgentModelForRuntime changes a model', () => {
        const { agentConfigEvents, updateAgentModelForRuntime } =
            require('../src/services/agentConfig');

        const seen: Array<{ runtime: string; model: string }> = [];
        const handler = (evt: { runtime: string; model: string }) => seen.push(evt);
        agentConfigEvents.on('model_changed', handler);
        try {
            updateAgentModelForRuntime('claude', 'sonnet');
            updateAgentModelForRuntime('claude', 'opus');
            assert.ok(seen.length >= 2, `expected at least 2 events, got ${seen.length}`);
            const claudeEvents = seen.filter((e) => e.runtime === 'claude');
            assert.deepEqual(
                claudeEvents.slice(-2).map((e) => e.model),
                ['sonnet', 'opus'],
            );
        } finally {
            agentConfigEvents.off('model_changed', handler);
        }
    });

    test('does not emit when same model is set again', () => {
        const { agentConfigEvents, updateAgentModelForRuntime } =
            require('../src/services/agentConfig');

        updateAgentModelForRuntime('claude', 'haiku');  // baseline

        const seen: Array<{ runtime: string; model: string }> = [];
        const handler = (evt: { runtime: string; model: string }) => seen.push(evt);
        agentConfigEvents.on('model_changed', handler);
        try {
            updateAgentModelForRuntime('claude', 'haiku');  // same — no event
            assert.equal(seen.length, 0);
        } finally {
            agentConfigEvents.off('model_changed', handler);
        }
    });
});

describe('agentConfig claudeConfigDir', () => {
    beforeEach(stubFsWrite);
    afterEach(() => {
        // Reset the singleton so other suites see the default (unset) state.
        const { updateAgentConfig } = require('../src/services/agentConfig');
        updateAgentConfig({ claudeConfigDir: undefined });
        restoreFsWrite();
    });

    test('unset by default — resolveClaudeConfigDir returns undefined', () => {
        const { resolveClaudeConfigDir } = require('../src/services/agentConfig');
        assert.equal(resolveClaudeConfigDir(), undefined);
    });

    test('expands a leading ~ against the home directory', () => {
        const os = require('node:os');
        const path = require('node:path');
        const { updateAgentConfig, resolveClaudeConfigDir } =
            require('../src/services/agentConfig');

        updateAgentConfig({ claudeConfigDir: '~/.claude-custom' });
        assert.equal(
            resolveClaudeConfigDir(),
            path.join(os.homedir(), '.claude-custom'),
        );
    });

    test('passes an absolute path through unchanged', () => {
        const { updateAgentConfig, resolveClaudeConfigDir } =
            require('../src/services/agentConfig');

        updateAgentConfig({ claudeConfigDir: '/opt/claude-profile' });
        assert.equal(resolveClaudeConfigDir(), '/opt/claude-profile');
    });

    test('loadAgentConfig reads agent.claudeConfigDir from disk and ignores blanks', () => {
        const fsCjs = require('fs');
        const origReadFileSync = fsCjs.readFileSync;
        const { loadAgentConfig, getAgentConfig } = require('../src/services/agentConfig');
        try {
            fsCjs.readFileSync = () =>
                JSON.stringify({ agent: { claudeConfigDir: '  ~/.claude-custom  ' } });
            loadAgentConfig();
            assert.equal(getAgentConfig().claudeConfigDir, '~/.claude-custom');

            fsCjs.readFileSync = () => JSON.stringify({ agent: { claudeConfigDir: '   ' } });
            loadAgentConfig();
            assert.equal(getAgentConfig().claudeConfigDir, undefined);
        } finally {
            fsCjs.readFileSync = origReadFileSync;
        }
    });
});
