import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { DEFAULT_CREW_APP, parseCrewAcpConfig } from '../src/agents/crew/acp/main';

test('defaults match a local Kiro Crew install', () => {
    const config = parseCrewAcpConfig(['acp', '--agent-engine', 'v2'], {});
    assert.deepEqual(config, {
        gateway: {
            baseUrl: 'http://127.0.0.1:5476',
            appName: DEFAULT_CREW_APP,
            kirocrewHome: path.join(os.homedir(), '.kiro', 'crew'),
        },
    });
});

test('kiro-cli style --model becomes the default model', () => {
    assert.equal(parseCrewAcpConfig(['acp', '--agent-engine', 'v2', '--model', 'claude-x'], {}).defaultModel, 'claude-x');
    assert.equal(parseCrewAcpConfig(['acp', '--model=claude-y'], {}).defaultModel, 'claude-y');
    assert.equal(parseCrewAcpConfig(['acp', '--model'], {}).defaultModel, undefined);
});

test('the engine value is not mistaken for a model', () => {
    assert.equal(parseCrewAcpConfig(['acp', '--agent-engine', '--model'], {}).defaultModel, undefined);
});

test('memory mode is explicit, validated, and never silently falls back on a typo', () => {
    for (const mode of ['persistent', 'incognito', 'temporary']) {
        assert.equal(parseCrewAcpConfig([], { MICHI_CREW_MEMORY_MODE: ` ${mode} ` }).memoryMode, mode);
    }
    assert.throws(() => parseCrewAcpConfig([], { MICHI_CREW_MEMORY_MODE: 'private' }), /must be persistent, incognito, or temporary/);
});

test('environment overrides gateway, home, app and agent', () => {
    const config = parseCrewAcpConfig(['acp'], {
        KIROCREW_PORT: '6000',
        KIROCREW_HOME: '/tmp/crew-home',
        MICHI_CREW_APP: 'other-app',
        MICHI_CREW_AGENT: 'reviewer',
    });
    assert.deepEqual(config.gateway, {
        baseUrl: 'http://127.0.0.1:6000',
        appName: 'other-app',
        kirocrewHome: '/tmp/crew-home',
        agent: 'reviewer',
    });
    assert.equal(
        parseCrewAcpConfig(['acp'], { CREW_GATEWAY_URL: 'http://localhost:7000', KIROCREW_PORT: '6000' }).gateway.baseUrl,
        'http://localhost:7000',
    );
});
