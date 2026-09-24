import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { AgentSession } from '../src/agents/types';
import type { KiroRuntime } from '../src/agents/kiro/KiroRuntime';

// Explicit opt-in only: real authenticated CLI, provider credits, isolated DB.
const enabled = (process.env.MICHI_KIRO_SMOKE ?? '').split(',');
for (const engine of ['v2', 'v3'] as const) {
    test(`real Kiro ${engine}: rewind, independent MCP routing, native resume, steer, cancel`, {
        skip: !enabled.includes(engine), timeout: 420_000,
    }, async (t) => {
        const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `michi-kiro-${engine}-`)));
        const previous = { ...process.env };
        Object.assign(process.env, { MICHI_DATA_DIR: directory, MICHI_TITLE_MODEL_KIRO: 'off' });
        delete process.env.MICHI_CLOUD;
        const { closeDb, getDb, initDb } = require('../src/services/db') as typeof import('../src/services/db');
        const repo = require('../src/services/dbRepository') as typeof import('../src/services/dbRepository');
        const { configureRuntimeDeps, __resetRuntimeDeps } = require('../src/agents/runtimeDeps') as typeof import('../src/agents/runtimeDeps');
        const { clearAllSessions } = require('../src/agents/sessionRegistry') as typeof import('../src/agents/sessionRegistry');
        const config = require('../src/services/agentConfig') as typeof import('../src/services/agentConfig');
        const { McpSlotRegistry, mountMcp } = require('../src/services/mcpServer') as typeof import('../src/services/mcpServer');
        const { tryForkChatSession } = require('../src/services/nativeFork') as typeof import('../src/services/nativeFork');
        closeDb(); initDb();
        configureRuntimeDeps({ historyStore: { getNode: repo.getNode, listMessages: repo.listMessages,
            getWorkspace: repo.getWorkspace, getWorkspaceInstructions: repo.getWorkspaceInstructions,
            hasGrant: repo.hasGrant, grantPermission: repo.grantPermission }, dataDir: directory,
            providerKeys: { getProviderApiKey: () => null },
            agentConfig: { getAgentConfig: config.getAgentConfig, resolveModel: config.resolveModel, resolveReasoning: config.resolveReasoning } });
        const registry = new McpSlotRegistry();
        const app = express(); app.use(express.json());
        const mcpRequests: unknown[] = [];
        app.use((req, _res, next) => { mcpRequests.push({ method: req.method, url: req.path, rpc: req.body?.method }); next(); });
        const router = express.Router(); mountMcp(router, registry); app.use('/api', router);
        const server = app.listen(0, '127.0.0.1');
        await new Promise<void>((resolve) => server.once('listening', resolve));
        let runtime: KiroRuntime | undefined;
        const watchdog = setTimeout(() => { void runtime?.shutdown(); }, 400_000);
        const parentId = randomUUID(); const childId = randomUUID();
        const token = `QuartzHarbor${Date.now()}`;
        const laterToken = `SilverMeadow${Date.now()}`;
        const options = { cwd: directory, workspaceId: 'kiro-smoke', enableFollowUps: false,
            reasoning: process.env.MICHI_KIRO_SMOKE_REASONING === 'off' ? undefined : 'low' as const,
            model: process.env.MICHI_KIRO_SMOKE_MODEL ?? 'claude-opus-4.7' };
        let sequence = 0;
        const records: Array<Record<string, unknown>> = [];
        const bind = (session: AgentSession) => repo.updateNodeResumeBinding(session.id, {
            acp_session_id: session.nativeSessionId!, runtime_id: 'kiro', runtime_engine: engine,
            model_id: session.currentModelId ?? null,
        });
        async function answer(session: AgentSession, prompt: string, onEvent?: (event: any) => Promise<void>) {
            let text = ''; const kinds: string[] = []; const details: unknown[] = []; const assistantId = randomUUID(); const userId = randomUUID();
            const record = { nodeId: session.id, nativeId: session.nativeSessionId, kinds, text, details };
            records.push(record);
            getDb().prepare('INSERT INTO messages (id,node_id,role,content,seq,created_at) VALUES (?,?,\'user\',?,?,1)').run(userId, session.id, prompt, ++sequence);
            for await (const event of session.send(prompt, { assistantMessageId: assistantId, userMessageId: userId })) {
                kinds.push(event.kind);
                if (['mcp_server_error', 'permission_request', 'tool_call', 'tool_call_update'].includes(event.kind)) details.push(event);
                if (event.kind === 'chunk') { text += event.text; record.text = text; }
                if (['tool_call', 'permission_request', 'user_input_request'].includes(event.kind)) console.info(`${engine} ${event.kind}: ${JSON.stringify(event).slice(0,1000)}`);
                if (event.kind === 'user_input_request') session.skipUserInput?.(event.requestId);
                if (event.kind === 'permission_request') {
                    // Permit only Michi metadata and our explicitly requested disposable sleep.
                    const allowed = /michi|branch.overview|sleep 4|echo MICHI_SMOKE/i.test(event.title);
                    const option = event.options.find((o) => o.kind === 'allow_once');
                    if (allowed && option) session.respondToPermission?.(event.requestId, option.optionId);
                    else session.cancelPermission?.(event.requestId);
                }
                if (event.kind === 'runtime_error') throw new Error(event.error);
                await onEvent?.(event);
            }
            getDb().prepare('INSERT INTO messages (id,node_id,role,content,seq,created_at) VALUES (?,?,\'assistant\',?,?,1)').run(assistantId, session.id, text, ++sequence);
            console.info(`${engine} turn ${records.length} completed (${kinds.includes('branch_overview') ? 'MCP delivered' : 'no MCP overview'})`);
            return { text, kinds, assistantId };
        }
        try {
            getDb().prepare('INSERT INTO workspaces (id,name,cwd,created_at,updated_at) VALUES (?,?,?,1,1)').run('kiro-smoke', 'Disposable Kiro smoke', directory);
            for (const [id, parent] of [[parentId, null], [childId, parentId]]) {
                getDb().prepare("INSERT INTO nodes (id,workspace_id,parent_node_id,kind,status,created_at) VALUES (?,'kiro-smoke',?,'chat','idle',1)").run(id, parent);
            }
            runtime = new (require('../src/agents/kiro/KiroRuntime').KiroRuntime)(
                { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
                registry, (server.address() as AddressInfo).port, directory, undefined, { engine });
            const parent = await runtime!.newSession({ ...options, sessionId: parentId }); bind(parent);
            console.info(`${engine} native mode ${parent.currentModeId}`);
            assert.equal(parent.currentModelId, options.model);
            const early = await answer(parent, `We are discussing a fictional public project named ${token}. Your task is to record this name by calling the available MCP tool @michi/set_branch_overview with an overview mentioning the name, then acknowledge it briefly. The actual tool call is required; printing a branch-overview sentinel is not a substitute. This is a made-up project name, not a secret or credential. Do not call any other tools.`);
            assert.ok(early.kinds.includes('branch_overview'), 'parent MCP metadata callback must route into parent stream');
            assert.ok(getDb().prepare('SELECT 1 FROM kiro_fork_anchors WHERE assistant_message_id=?').get(early.assistantId), 'persist native historical anchor');
            await answer(parent, `We renamed our fictional public project to ${laterToken}. Acknowledge the new project name and record branch overview. No external tools.`);
            getDb().prepare("INSERT INTO edges (id,workspace_id,source_node_id,target_node_id,kind,anchor_message_id,created_at) VALUES (?,'kiro-smoke',?,?,'branch',?,1)").run(randomUUID(), parentId, childId, early.assistantId);
            const sourceId = parent.nativeSessionId;
            const child = await tryForkChatSession(runtime!, { ...options, sessionId: childId, parentChatId: parentId });
            assert.ok(child, 'historical branch must use native fork'); bind(child);
            assert.notEqual(child.nativeSessionId, sourceId);
            const inherited = await answer(child, 'What is the name of the fictional public project we discussed? State the name, then record branch overview. No external tools.');
            assert.ok(inherited.text.includes(token), `historical fork lost early token: ${inherited.text}`);
            assert.ok(!inherited.text.includes(laterToken), 'historical fork must not inherit later turns');
            assert.ok(inherited.kinds.includes('branch_overview'), 'child MCP callback must be rebound to child');
            const unchanged = await answer(parent, 'What is the current name of the fictional public project? State the name, then record branch overview. No external tools.');
            assert.ok(unchanged.text.includes(laterToken), 'rewind must not mutate parent history');
            assert.equal(parent.nativeSessionId, sourceId);
            const childNativeId = child.nativeSessionId;
            await runtime!.releaseSession(child.id);
            const resumed = await runtime!.loadSession({ ...options, sessionId: childId, nodeId: childId, nativeEngine: engine });
            assert.equal(resumed.nativeSessionId, childNativeId);
            assert.equal(resumed.nativeEngine, engine);
            const recalled = await answer(resumed, 'What was the fictional public project name in our conversation? State the name and record branch overview. No external tools.');
            assert.ok(recalled.text.includes(token), 'resume preserves fork history');
            let steered = false;
            const steerToken = 'cobalt';
            const steeredTurn = await answer(resumed, 'We are choosing a UI color for the fictional project. Compare blue, red and green with a short paragraph for each, then recommend one and record branch overview.', async (event) => {
                if (!steered && event.kind === 'tool_call') {
                    steered = true;
                    assert.equal((await resumed.steer?.(`A new design constraint: please choose ${steerToken} and explain why this color is suitable.`))?.accepted, true);
                }
            });
            assert.ok(steered, 'exercise active native steering');
            assert.ok(steeredTurn.text.includes(steerToken), `model did not consume native steering: ${steeredTurn.text}`);
            let cancelled = false;
            await answer(resumed, 'Write a detailed project implementation plan with six phases and record branch overview.', async (event) => {
                if (!cancelled && event.kind === 'chunk') {
                    cancelled = true;
                    await resumed.steer?.('Add an appendix about STALE_CANCELLED_STEER.');
                    await resumed.cancel();
                }
            });
            assert.ok(cancelled);
            const afterCancel = await answer(resumed, 'New question, independent of the cancelled plan: what is 21 plus 21? Reply briefly and record branch overview. No external tools.');
            assert.ok(afterCancel.text.includes('42'));
            assert.ok(!afterCancel.text.includes('STALE_CANCELLED_STEER'));
            assert.equal((await resumed.compact?.())?.started, true, 'native compact command succeeds');
            t.diagnostic(`${engine}: model=${parent.currentModelId}, historical fork/MCP/resume/steer/cancel passed; ${records.length} real turns`);
        } finally {
            clearTimeout(watchdog);
            if (process.env.MICHI_KIRO_SMOKE_OUTPUT) {
                fs.writeFileSync(path.join(process.env.MICHI_KIRO_SMOKE_OUTPUT, `${engine}-runtime-smoke.json`), JSON.stringify(records, null, 2));
                fs.writeFileSync(path.join(process.env.MICHI_KIRO_SMOKE_OUTPUT, `${engine}-mcp-smoke.json`), JSON.stringify({ requests: mcpRequests,
                    status: await runtime?.executeCommand(runtime.getBinding(parentId)?.nativeSessionId ?? '', 'mcp').catch(String) }, null, 2));
            }
            await runtime?.shutdown();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            clearAllSessions(); __resetRuntimeDeps(); closeDb(); process.env = previous;
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
}
