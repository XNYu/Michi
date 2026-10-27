import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { DEFAULT_CREW_APP, parseCrewAcpConfig } from '../src/adapters/crew/acp/main';

test('kiro-cli style --model becomes the default model', () => {
    assert.equal(parseCrewAcpConfig(['acp', '--agent-engine', 'v2', '--model', 'claude-x'], {}).defaultModel, 'claude-x');
    assert.equal(parseCrewAcpConfig(['acp', '--model=claude-y'], {}).defaultModel, 'claude-y');
    assert.equal(parseCrewAcpConfig(['acp', '--model'], {}).defaultModel, undefined);
});

test('memory mode is explicit, validated, and never silently falls back on a typo', () => {
    for (const mode of ['persistent', 'incognito', 'temporary']) {
        assert.equal(parseCrewAcpConfig([], { MICHI_CREW_MEMORY_MODE: ` ${mode} ` }).memoryMode, mode);
    }
    assert.throws(() => parseCrewAcpConfig([], { MICHI_CREW_MEMORY_MODE: 'private' }), /must be persistent, incognito, or temporary/);
});
