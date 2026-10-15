import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

function setupFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-setup-test-'));
    const backend = path.join(root, '.michi/backend');
    fs.mkdirSync(path.join(backend, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '../scripts/crew-setup.cjs'), path.join(backend, 'scripts/crew-setup.cjs'));
    fs.cpSync(path.join(__dirname, '../../crew-app'), path.join(root, '.michi/crew-app'), { recursive: true });
    fs.mkdirSync(path.join(backend, 'dist'));
    fs.writeFileSync(path.join(backend, 'dist/crewMcp.js'), '// fixture: never executed\n');
    fs.writeFileSync(path.join(backend, 'dist/crewMcpHost.js'), '// fixture: never executed\n');
    return { root, backend, script: path.join(backend, 'scripts/crew-setup.cjs') };
}

test('default App preparation includes Michi MCP and approvals with the concise template', () => {
    const fixture = setupFixture();
    let dir: string | undefined;
    try {
        const result = execFileSync(process.execPath, [fixture.script], { encoding: 'utf8' });
        dir = result.match(/^Prepared App: (.+)$/m)?.[1];
        assert.ok(dir);
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
        const agent = JSON.parse(fs.readFileSync(path.join(dir, manifest.agents[0]), 'utf8'));
        assert.equal(agent.name, MICHI_CREW_AGENT_TEMPLATE);
        assert.equal(agent.model, 'auto');
        assert.ok(agent.prompt.length < 2500);
        assert.match(agent.prompt, /Incognito reads without learning/);
        assert.match(agent.prompt, /Do not discover or call tools solely/);
        assert.ok(agent.tools.includes('@kirocrew-core'));
        assert.ok(agent.tools.includes('@michi-crew-runtime:michi'));
        assert.equal(manifest.permissions.sessionApproval, true);
        assert.equal(manifest.mcpServers.michi.command, 'python');
        assert.match(manifest.mcpServers.michi.args.at(-1), /launch.py/);
        assert.equal(manifest.mcpServers.michi.env.MICHI_CREW_INSTALL_DIR, path.dirname(fs.realpathSync(fixture.backend)));
        assert.ok(fs.existsSync(path.join(dir, 'launch.py')));
        assert.match(result, /complete sessionApproval consent/);
        assert.match(result, /enable Stub\/Routed/);
        assert.match(result, /use Michi for chats, Ask\/Trust and approval cards/);
    } finally {
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('legacy setup flags also prepare both required capabilities', () => {
    const fixture = setupFixture();
    try {
        for (const args of [['--mcp'], ['--approvals'], ['--mcp', '--approvals']]) {
            const result = execFileSync(process.execPath, [fixture.script, ...args], { encoding: 'utf8' });
            const dir = result.match(/^Prepared App: (.+)$/m)?.[1];
            assert.ok(dir);
            try {
                const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
                assert.equal(manifest.permissions.sessionApproval, true);
                assert.ok(manifest.mcpServers.michi);
            } finally { fs.rmSync(dir, { recursive: true, force: true }); }
        }
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('missing MCP build fails instead of preparing a partial App', () => {
    const fixture = setupFixture();
    fs.rmSync(path.join(fixture.backend, 'dist/crewMcp.js'));
    try {
        assert.throws(() => execFileSync(process.execPath, [fixture.script], { encoding: 'utf8', stdio: 'pipe' }),
            /Michi Crew MCP build is missing/);
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});
