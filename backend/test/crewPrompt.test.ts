import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { crewTurnFormat, MICHI_CREW_AGENT_TEMPLATE } from '../src/agents/crew/crewPrompt';
import { buildFirstTurnPrefix, buildPreamble } from '../src/agents/preamble';

test('Crew sends variable context without repeating the stable Michi instructions', () => {
    const input = {
        cwd: '/tmp', enableFollowUps: true, toolCapabilities: 'crew' as const,
        workspaceInstructions: 'Use our style guide.',
        contextManifest: [{ name: 'notes', filePath: 'notes.md' }],
        mergeContexts: ['A previous exploration.'],
    };
    const prefix = buildFirstTurnPrefix(input);
    assert.match(prefix, /Use our style guide\./);
    assert.match(prefix, /notes.md/);
    assert.match(prefix, /A previous exploration\./);
    assert.doesNotMatch(prefix, /michi_list_tools|Required final answer metadata/);
    assert.equal(buildFirstTurnPrefix({ cwd: '/tmp' }), '');
    const compact = prefix + 'Test1' + crewTurnFormat(true);
    const previous = buildPreamble(input) + 'Test1';
    assert.ok(compact.length < previous.length / 4);
    assert.match(crewTurnFormat(false), /Follow-ups are disabled/);
    assert.doesNotMatch(crewTurnFormat(false), /FOLLOW-UP 1\/3/);
});

test('official App preparation copies the concise template without requesting additional access', () => {
    const result = execFileSync(process.execPath, [path.join(__dirname, '../scripts/crew-setup.cjs')], { encoding: 'utf8' });
    const dir = result.match(/^Prepared App: (.+)$/m)?.[1];
    assert.ok(dir);
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
        const agent = JSON.parse(fs.readFileSync(path.join(dir, manifest.agents[0]), 'utf8'));
        assert.equal(agent.name, MICHI_CREW_AGENT_TEMPLATE);
        assert.equal(agent.model, 'auto');
        assert.ok(agent.prompt.length < 2500);
        assert.match(agent.prompt, /Incognito reads without learning/);
        assert.match(agent.prompt, /Do not discover or call tools solely/);
        assert.ok(agent.tools.includes('@kirocrew-core'));
        assert.equal(agent.tools.includes('@michi-crew-runtime:michi'), false);
        assert.equal(manifest.permissions.sessionApproval, undefined);
        assert.equal(manifest.mcpServers, undefined);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
