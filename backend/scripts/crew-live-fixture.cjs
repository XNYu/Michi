/** Shared fixture for the opt-in Crew live checks (crew-live.cjs, crew-bridge-live.cjs):
 * the MICHI_CREW_LIVE_TEST guard, ACP clients on the bundled Crew adapter, Template
 * sessions, bounded turns, the JSON report and removal of the diagnostic slots.
 * Cleanup stops each slot, waits until it is idle and deletes it; when any step
 * fails, the fixture directory is kept and the run fails.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
process.env.TS_NODE_PROJECT = path.join(root, 'backend/tsconfig.json');
require('ts-node/register');
const { AcpClient } = require('michi-runtime/internal/adapters/kiro/acpClient');
const { CrewGatewayClient } = require('michi-runtime/internal/adapters/crew/acp/gatewayClient');
const { parseCrewAcpConfig } = require('michi-runtime/internal/adapters/crew/acp/main');

const textOf = events => events.filter(e => e.sessionUpdate === 'agent_message_chunk').map(e => e.content?.text || '').join('');

/**
 * @param {{ prefix: string, resultName: string, requestTimeoutMs?: number }} options
 *   prefix: fixture directory name prefix under the OS temp directory;
 *   resultName: report file name there unless MICHI_CREW_LIVE_RESULT is set.
 * @param {{ AcpClient?: Function, gateway?: object, observability?: object, adapter?: string }} deps
 *   Replacements for unit tests of this fixture.
 */
function createCrewLiveFixture({ prefix, resultName, requestTimeoutMs }, deps = {}) {
    if (process.env.MICHI_CREW_LIVE_TEST !== '1') {
        console.error('Set MICHI_CREW_LIVE_TEST=1 to allow real model calls and disposable Gateway test sessions.');
        process.exit(2);
    }
    const adapter = deps.adapter ?? path.join(root, 'backend/dist/crewAcp.js');
    assert.ok(fs.existsSync(adapter), 'Build the adapter first with npm run backend:build');
    const Client = deps.AcpClient ?? AcpClient;
    const observability = deps.observability ?? require('../src/agents/michiRuntimeHost').createMichiRuntimeHost().observability;
    const gateway = deps.gateway ?? new CrewGatewayClient({
        ...parseCrewAcpConfig([], process.env).gateway,
        ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
    });
    const model = process.env.MICHI_CREW_LIVE_MODEL || 'claude-sonnet-4.6';
    const template = process.env.MICHI_CREW_LIVE_AGENT || 'kirocrew';
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const clients = [], slots = [];
    const report = { startedAt: new Date().toISOString(), checks: [] };
    const resultPath = path.resolve(process.env.MICHI_CREW_LIVE_RESULT || path.join(os.tmpdir(), resultName));
    const record = (name, detail = {}) => {
        const row = { name, ...detail };
        report.checks.push(row);
        console.log(JSON.stringify(row));
    };

    /** The adapter reads its memory mode from the environment once, at start. */
    async function client(memoryMode = 'temporary') {
        const previous = process.env.MICHI_CREW_MEMORY_MODE;
        process.env.MICHI_CREW_MEMORY_MODE = memoryMode;
        const c = new Client(undefined, cwd, undefined, 'v2', {
            bin: process.execPath,
            args: () => [adapter, '--model', model],
            standardFork: true,
            cancelTimeoutMs: 15000,
        }, undefined, { observability });
        clients.push(c);
        try { c.start(); }
        finally {
            if (previous === undefined) delete process.env.MICHI_CREW_MEMORY_MODE;
            else process.env.MICHI_CREW_MEMORY_MODE = previous;
        }
        await c.initialize();
        return c;
    }
    async function session(memoryMode = 'temporary', mcp = []) {
        const c = await client(memoryMode);
        const info = await c.newSession(mcp);
        const sid = info.sessionId;
        slots.push(sid);
        assert.ok(info.modes.availableModes.some(m => m.id === `template:${template}`), 'Template catalog unavailable: check App v0.2.0 permissions and MICHI_CREW_LIVE_AGENT');
        await c.setMode(sid, `template:${template}`);
        return { c, sid };
    }
    /** onEvent(event, controller) sees each event; it may abort the turn through controller. */
    async function turn(c, sid, message, { timeoutMs = 120000, onEvent, expectEndTurn = true } = {}) {
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); void c.cancel(sid); }, timeoutMs);
        const events = [];
        try {
            for await (const event of c.prompt(sid, message, [], controller.signal)) {
                events.push(event);
                await onEvent?.(event, controller);
            }
            assert.equal(timedOut, false, `Live check exceeded ${timeoutMs / 1000} seconds`);
            if (expectEndTurn) assert.equal(events.at(-1)?.stopReason, 'end_turn', 'Diagnostic prompt did not finish');
            return events;
        } finally { clearTimeout(timer); }
    }
    /** Returns whether everything was removed; `failed` keeps the directory for an earlier failed cleanup step. */
    async function cleanup({ retainSlot, failed = false } = {}) {
        let clean = !failed;
        for (const c of clients) await c.shutdown().catch(() => {});
        for (const sid of slots) {
            if (sid === retainSlot) {
                record('retained diagnostic slot', { slot: sid });
                continue;
            }
            try {
                await gateway.stop(sid);
                await gateway.waitUntilIdle(sid, AbortSignal.timeout(10000));
                await gateway.deleteSlot(sid);
                record('removed diagnostic slot', { slot: sid });
            } catch (error) {
                clean = false;
                record('slot cleanup requires attention', { slot: sid, error: String(error) });
            }
        }
        gateway.close();
        if (clean) fs.rmSync(cwd, { recursive: true, force: true });
        else { report.retainedFixtureDirectory = cwd; process.exitCode = 1; }
        return clean;
    }
    function writeReport() {
        report.finishedAt = new Date().toISOString();
        fs.writeFileSync(resultPath, JSON.stringify(report, null, 2) + '\n');
        console.log(`Result: ${resultPath}`);
    }
    return { root, adapter, model, template, cwd, gateway, slots, report, record, client, session, turn, cleanup, writeReport };
}

module.exports = { createCrewLiveFixture, textOf };
