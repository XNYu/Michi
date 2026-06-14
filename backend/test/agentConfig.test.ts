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
