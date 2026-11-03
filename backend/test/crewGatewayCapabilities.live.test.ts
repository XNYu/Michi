import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSession } from '../src/agents/types';
import type { AcpAgentRuntime } from 'michi-runtime/internal/adapters/kiro/AcpAgentRuntime';

/**
 * Opt-in live check of the Michi Crew runtime (createCrewRuntime: AcpAgentRuntime
 * with the Crew flavor and the bundled ACP adapter) against a real official
 * Kiro Crew Gateway, for the capabilities probed on 0.11.0.1: subagent roster,
 * per-turn credits, the Gateway-confirmed cancel and manual compaction.
 *
 * It consumes model calls and creates/deletes one temporary-memory App slot.
 * Point it at a disposable Gateway whose michi-crew-runtime App is installed
 * and consented (VALIDATION.md, "App-caller capability probes"):
 *
 *   MICHI_CREW_LIVE_GATEWAY=1 CREW_GATEWAY_URL=http://127.0.0.1:<port> KIROCREW_HOME=<home> \
 *     node --require ts-node/register --require ./test/helpers/isolateUserDirs.cjs \
 *     --test --test-timeout=600000 test/crewGatewayCapabilities.live.test.ts
 *
 * The default Gateway port 5476 is refused unless MICHI_CREW_LIVE_ALLOW_DEFAULT_PORT=1.
 * Crew asks for every sub-agent spawn on a dashboard user's tab, which an App
 * cannot answer. MICHI_CREW_LIVE_OWNER_TOKEN (a disposable Gateway's
 * `--json-ready` token, never the person's) stands in for that tab; without it
 * the roster check is skipped.
 */
const enabled = process.env.MICHI_CREW_LIVE_GATEWAY === '1';
const MODEL = process.env.MICHI_CREW_LIVE_MODEL || 'claude-sonnet-4.6';
const TEMPLATE = process.env.MICHI_CREW_LIVE_AGENT || 'kirocrew';

function gatewayOrigin(): URL {
    const url = new URL(process.env.CREW_GATEWAY_URL ?? '');
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'CREW_GATEWAY_URL must be loopback');
    assert.ok(url.port !== '5476' || process.env.MICHI_CREW_LIVE_ALLOW_DEFAULT_PORT === '1', 'refusing the default Gateway port 5476');
    assert.ok(process.env.KIROCREW_HOME, 'KIROCREW_HOME must name the Gateway home explicitly');
    return url;
}

/** A dashboard user's tab: an owner socket, and the person answering spawn approvals there. */
async function dashboardTab(origin: URL, slot: string, token: string) {
    const WebSocket = require('ws') as typeof import('ws');
    const cookie = `mc_token_${origin.port}=${token}`;
    const socket = new WebSocket(`ws://${origin.host}/api/ws`, { headers: { Cookie: cookie, Origin: origin.origin } });
    await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject); });
    socket.on('message', () => {});
    let stopped = false;
    const answered: string[] = [];
    const loop = (async () => {
        while (!stopped) {
            try {
                const rows = await (await fetch(`${origin.origin}/api/chat/slots`, { headers: { Cookie: cookie } })).json() as any[];
                const info = rows.find((row) => row.key === slot)?.pending_approval_info;
                if (info?.origin === 'coordinator' && typeof info.request_id === 'string' && !answered.includes(info.request_id)) {
                    answered.push(info.request_id);
                    await fetch(`${origin.origin}/api/chat/slots/${encodeURIComponent(slot)}/approve`, {
                        method: 'POST', headers: { Cookie: cookie, Origin: origin.origin, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ request_id: info.request_id, action: 'approved' }),
                    });
                }
            } catch { /* the next poll retries */ }
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    })();
    return { answered, close: async () => { stopped = true; await loop; socket.close(); } };
}

test('real Crew Gateway: subagent roster, credits, confirmed cancel and compaction through the Michi Crew runtime', {
    skip: !enabled, timeout: 600_000,
}, async (t) => {
    const origin = gatewayOrigin();
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'michi-crew-live-')));
    const previous = { ...process.env };
    // The adapter inherits this environment: temporary memory, explicit template, no MCP relay files outside the run.
    Object.assign(process.env, {
        MICHI_CREW_MEMORY_MODE: 'temporary', MICHI_CREW_AGENT: TEMPLATE,
        MICHI_CREW_MCP_DIR: path.join(directory, 'crew-mcp'),
        TS_NODE_PROJECT: path.resolve(__dirname, '../../runtime/tsconfig.json'), TS_NODE_TRANSPILE_ONLY: '1',
    });
    delete process.env.MICHI_CLOUD;
    const { closeDb, initDb } = require('../src/services/db') as typeof import('../src/services/db');
    const repo = require('../src/services/dbRepository') as typeof import('../src/services/dbRepository');
    const { configureRuntimeDeps, __resetRuntimeDeps } = require('../src/agents/runtimeDeps') as typeof import('../src/agents/runtimeDeps');
    const { clearAllSessions } = require('../src/agents/sessionRegistry') as typeof import('../src/agents/sessionRegistry');
    const config = require('../src/services/agentConfig') as typeof import('../src/services/agentConfig');
    const { RUNTIME_FACTORIES } = require('../src/agents/runtimeFactories') as typeof import('../src/agents/runtimeFactories');
    const { michiTestHost } = require('./helpers/michiTestHost') as typeof import('./helpers/michiTestHost');
    const { CrewGatewayClient } = require('michi-runtime/internal/adapters/crew/acp/gatewayClient') as typeof import('michi-runtime/internal/adapters/crew/acp/gatewayClient');
    const { parseCrewAcpConfig } = require('michi-runtime/internal/adapters/crew/acp/main') as typeof import('michi-runtime/internal/adapters/crew/acp/main');
    closeDb(); initDb();
    configureRuntimeDeps({ historyStore: { getNode: repo.getNode, listMessages: repo.listMessages,
        getWorkspace: repo.getWorkspace, getWorkspaceInstructions: repo.getWorkspaceInstructions }, dataDir: directory,
        providerKeys: { getProviderApiKey: () => null },
        agentConfig: { getAgentConfig: config.getAgentConfig, resolveModel: config.resolveModel, resolveReasoning: config.resolveReasoning } });
    const factory = RUNTIME_FACTORIES.find((entry) => entry.id === 'crew');
    assert.ok(factory);
    const runtime = factory.create({ bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
        mcpPort: 0, defaultCwd: directory, host: michiTestHost() }) as AcpAgentRuntime;
    assert.deepEqual(await runtime.checkAvailability?.(), { available: true });
    const gateway = new CrewGatewayClient({ ...parseCrewAcpConfig([], process.env).gateway, requestTimeoutMs: 10_000 });
    const record: Array<Record<string, unknown>> = [];
    let session: AgentSession | undefined;
    async function turn(prompt: string, onEvent?: (event: any) => Promise<void>) {
        const events: any[] = [];
        let text = '';
        for await (const event of session!.send(prompt)) {
            events.push(event);
            if (event.kind === 'chunk') text += event.text;
            if (event.kind === 'permission_request') {
                // Only the delegation this check asks for.
                const allow = /spawn_sub_agents|Tool Load|tool_load/i.test(event.title) ? event.options.find((o: any) => o.kind === 'allow_once') : undefined;
                if (allow) session!.respondToPermission?.(event.requestId, allow.optionId);
                else session!.cancelPermission?.(event.requestId);
            }
            if (event.kind === 'runtime_error') throw new Error(event.error);
            await onEvent?.(event);
        }
        record.push({ prompt: prompt.slice(0, 80), kinds: [...new Set(events.map((e) => e.kind))], text: text.slice(0, 200) });
        return { events, text };
    }
    try {
        session = await runtime.newSession({ cwd: directory, sessionId: randomUUID(), enableFollowUps: false, model: MODEL });
        const slot = session.nativeSessionId!;
        t.diagnostic(`slot ${slot} on ${origin.origin}`);

        const ownerToken = process.env.MICHI_CREW_LIVE_OWNER_TOKEN;
        const tab = ownerToken ? await dashboardTab(origin, slot, ownerToken) : undefined;
        const first = await turn(ownerToken
            ? 'Call the spawn_sub_agents tool exactly once with one sub-agent whose prompt is: "Reply with exactly the word PONG and nothing else." Wait for it, then reply with only the sub-agent result.'
            : 'Reply with the single word READY.');
        await tab?.close();
        const usage = first.events.filter((e) => e.kind === 'usage_summary');
        assert.equal(usage.length, 1, 'one usage summary per turn');
        assert.ok(usage[0].totalCredits > 0, `credits reported: ${JSON.stringify(usage[0])}`);
        assert.deepEqual(usage[0].charge, { amount: usage[0].totalCredits, unit: 'credits', provenance: 'native_metering' });
        if (tab) {
            assert.ok(tab.answered.some((id) => id.startsWith('spawn:')), 'Crew asked the dashboard tab for the spawn');
            const roster = first.events.filter((e) => e.kind === 'subagent_list_update').flatMap((e) => e.subagents);
            const done = roster.find((entry: any) => entry.status === 'terminated');
            assert.ok(done, `roster: ${JSON.stringify(roster)}`);
            assert.equal(done.outcome, 'completed');
            assert.match(String(done.result), /PONG/);
            assert.equal(done.source, 'crew');
        } else {
            t.diagnostic('roster check skipped: no MICHI_CREW_LIVE_OWNER_TOKEN for a stand-in dashboard tab');
        }

        let ack: any;
        const cancelled = await turn('Write a detailed 1500-word essay about the history of rivers. Do not use any tools.', async (event) => {
            if (!ack && event.kind === 'chunk') ack = await session!.cancel();
        });
        assert.deepEqual(ack, { acknowledged: true, source: 'native', confidence: 'native', nativeMethod: 'Crew stop_event stopped' });
        assert.equal(cancelled.events.at(-1)?.kind, 'turn_end');
        assert.equal(cancelled.events.at(-1)?.stopReason, 'cancelled');

        const compacted = await session.compact!();
        assert.deepEqual(compacted, { started: true, completed: true, detail: 'Compaction completed' });

        const after = await turn('Reply with the single word DONE.');
        assert.match(after.text, /DONE/);
        t.diagnostic(JSON.stringify(record));
    } finally {
        if (process.env.MICHI_CREW_LIVE_RESULT) fs.writeFileSync(process.env.MICHI_CREW_LIVE_RESULT, JSON.stringify(record, null, 2));
        const slot = session?.nativeSessionId;
        await runtime.shutdown();
        if (slot) await gateway.deleteSlot(slot).catch((error: unknown) => t.diagnostic(`could not delete ${slot}: ${String(error)}`));
        gateway.close();
        clearAllSessions(); __resetRuntimeDeps(); closeDb(); process.env = previous;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
