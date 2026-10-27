import { isolatedConfigDir } from './isolatedConfigDir';
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const configPath = path.join(isolatedConfigDir, 'config.json');
beforeEach(() => {
    fs.writeFileSync(configPath, '{}');
    require('../src/services/agentConfig').loadAgentConfig();
});

describe('agentConfig events', () => {

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

describe('desktop native resume preferences', () => {
    test('merges runtime flags and validates persisted boolean values on reload', () => {
        const { loadAgentConfig, getAgentConfig, updateAgentConfig, isNativeResumeEnabled } = require('../src/services/agentConfig');
        try {
            fs.writeFileSync(configPath, JSON.stringify({ agent: { nativeResumeByRuntime: { codex: false, claude: 'false', kiro: null } } }));
            loadAgentConfig();
            assert.deepEqual(getAgentConfig().nativeResumeByRuntime, { codex: false });
            assert.equal(isNativeResumeEnabled('claude'), true);
            updateAgentConfig({ nativeResumeByRuntime: { claude: false } });
            updateAgentConfig({ runtime: 'kiro' });
            assert.deepEqual(getAgentConfig().nativeResumeByRuntime, { codex: false, claude: false });
            updateAgentConfig({ nativeResumeByRuntime: { codex: true } });
            assert.deepEqual(getAgentConfig().nativeResumeByRuntime, { codex: true, claude: false });
        } finally {
            fs.writeFileSync(configPath, '{}');
            loadAgentConfig();
        }
    });
});

describe('desktop native fork preferences', () => {
    test('defaults on, filters malformed values, and merges per-runtime updates', () => {
        const { loadAgentConfig, getAgentConfig, updateAgentConfig, isNativeForkEnabled } = require('../src/services/agentConfig');
        try {
            fs.writeFileSync(configPath, JSON.stringify({ agent: { nativeForkByRuntime: { codex: false, claude: 'false', kiro: null } } }));
            loadAgentConfig();
            assert.deepEqual(getAgentConfig().nativeForkByRuntime, { codex: false });
            assert.equal(isNativeForkEnabled('codex'), false);
            assert.equal(isNativeForkEnabled('claude'), true);
            updateAgentConfig({ nativeForkByRuntime: { kiro: false } });
            updateAgentConfig({ nativeResumeByRuntime: { codex: false } });
            assert.deepEqual(getAgentConfig().nativeForkByRuntime, { codex: false, kiro: false });
            updateAgentConfig({ nativeForkByRuntime: { codex: true } });
            assert.equal(isNativeForkEnabled('codex'), true);
        } finally {
            fs.writeFileSync(configPath, '{}');
            loadAgentConfig();
        }
    });
});

describe('agentConfig claudeConfigDir', () => {
    afterEach(() => {
        // Reset the singleton so other suites see the default (unset) state.
        const { updateAgentConfig } = require('../src/services/agentConfig');
        updateAgentConfig({ claudeConfigDir: undefined });
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

        updateAgentConfig({ claudeConfigDir: '~/.claude-example' });
        assert.equal(
            resolveClaudeConfigDir(),
            path.join(os.homedir(), '.claude-example'),
        );
    });

    test('passes an absolute path through unchanged', () => {
        const { updateAgentConfig, resolveClaudeConfigDir } =
            require('../src/services/agentConfig');

        updateAgentConfig({ claudeConfigDir: '/opt/claude-profile' });
        assert.equal(resolveClaudeConfigDir(), '/opt/claude-profile');
    });

    test('loadAgentConfig reads agent.claudeConfigDir from disk and ignores blanks', () => {
        const { loadAgentConfig, getAgentConfig } = require('../src/services/agentConfig');
        try {
            fs.writeFileSync(configPath, JSON.stringify({ agent: { claudeConfigDir: '  ~/.claude-example  ' } }));
            loadAgentConfig();
            assert.equal(getAgentConfig().claudeConfigDir, '~/.claude-example');

            fs.writeFileSync(configPath, JSON.stringify({ agent: { claudeConfigDir: '   ' } }));
            loadAgentConfig();
            assert.equal(getAgentConfig().claudeConfigDir, undefined);
        } finally {
            fs.writeFileSync(configPath, '{}');
        }
    });
});
