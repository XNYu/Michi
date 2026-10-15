/** Opt-in real template/format check; only its own disposable App slot is removed. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
if (process.env.MICHI_CREW_LIVE_TEST !== '1') throw new Error('Set MICHI_CREW_LIVE_TEST=1 to allow a disposable real model call');
const root = path.resolve(__dirname, '../..');
process.env.TS_NODE_PROJECT = path.join(root, 'backend/tsconfig.json');
require('ts-node/register');
const { AcpClient } = require('../src/services/acpClient');
const { KiroSession } = require('../src/agents/kiro/KiroSession');
const { createCrewGateway } = require('../src/agents/crew/acp/gatewayClient');
const { parseCrewAcpConfig } = require('../src/agents/crew/acp/main');
const { buildPreamble } = require('../src/agents/preamble');
const { crewTurnFormat } = require('../src/agents/crew/crewPrompt');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-crew-prompt-'));
const model = process.env.MICHI_CREW_LIVE_MODEL || 'claude-opus-5.5';
const effort = process.env.MICHI_CREW_LIVE_EFFORT || 'xhigh';
const gateway = createCrewGateway(parseCrewAcpConfig([], process.env).gateway);
const client = new AcpClient(undefined, cwd, model, 'v2', {
    bin: process.execPath, args: selected => [path.join(root, 'backend/dist/crewAcp.js'), '--model', selected],
    standardFork: true, cancelTimeoutMs: 15000,
});
let sid, timer;
const report = { model, effort, checks: [] };
(async () => {
    try {
        client.start(); await client.initialize();
        const info = await client.newSession([], { metadata: { crew: { memoryMode: 'temporary' } } });
        sid = info.sessionId;
        assert.equal(info.modes.currentModeId, 'template:michi-crew', 'New chats must select the installed Michi template');
        assert.equal((await client.executeCommand(sid, 'effort', { value: effort })).success, true);
        const runtime = { id: 'crew', ensureClient: async () => client,
            getCurrentMode: () => info.modes.currentModeId, getCurrentModel: () => model };
        const session = new KiroSession('disposable-node', sid, runtime, cwd, { runtimeId: 'crew', enableFollowUps: false });
        const started = Date.now();
        let firstOutputMs, text = '', tools = 0;
        timer = setTimeout(() => { void client.cancel(sid); }, 180000);
        for await (const event of session.send('Test1')) {
            if (event.kind === 'chunk') {
                firstOutputMs ??= Date.now() - started;
                text += event.text;
            }
            if (event.kind === 'tool_call') tools++;
            if (event.kind === 'permission_request') client.respondToPermissionKind(event.requestId, 'reject_once');
            if (event.kind === 'turn_end') assert.equal(event.stopReason, 'end_turn');
        }
        const detail = await gateway.getSlot(sid);
        const settings = (await gateway.listSlots()).find(slot => slot.key === sid);
        assert.equal(settings.memory_mode, 'temporary');
        assert.equal(detail.running, false);
        assert.equal(tools, 0, 'A simple greeting must not call tools to create metadata');
        assert.match(text, /\[TITLE:/);
        assert.match(text, /\[BRANCH-OVERVIEW:/);
        assert.doesNotMatch(text, /\[FOLLOW-UP/);
        const payload = detail.messages.find(row => row.role === 'user')?.content;
        assert.equal(payload, 'Test1' + crewTurnFormat(false), 'Gateway must receive the compact user payload');
        report.checks.push({ template: info.modes.currentModeId, nativeAgent: detail.agent,
            firstOutputMs, totalMs: Date.now() - started, tools,
            userPayloadChars: payload.length,
            previousPreambleChars: buildPreamble({ cwd, enableFollowUps: false, toolCapabilities: 'crew' }).length,
            titleAndOverview: true, followUpsDisabled: true });
        report.ok = true;
    } catch (error) { report.ok = false; report.error = String(error); process.exitCode = 1; }
    finally {
        clearTimeout(timer);
        await client.shutdown().catch(() => {});
        if (sid) { await gateway.stop(sid); await gateway.deleteSlot(sid); }
        gateway.close(); fs.rmSync(cwd, { recursive: true, force: true });
        const result = process.env.MICHI_CREW_LIVE_RESULT || path.join(os.tmpdir(), 'michi-crew-prompt-result.json');
        fs.writeFileSync(result, JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify(report)); console.log('Result: ' + result);
    }
})();
