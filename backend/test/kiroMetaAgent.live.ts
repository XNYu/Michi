import { michiTestHost } from './helpers/michiTestHost';
import { fakeMcpRegistry } from './helpers/fakeMcpRegistry';
import { michiKiroRestrictedAgent } from '../src/agents/kiro/kiroMetaAgent';
/** Real CLI check: the Meta agent's Kiro sessions expose only their toolset, on both engines.
 * Run from backend with MICHI_KIRO_META_LIVE=1 node --require ts-node/register
 * test/kiroMetaAgent.live.ts. Opens sessions and reads catalogs only: no prompt
 * is sent, so no model quota is used. MICHI_KIRO_META_LIVE_DIR picks the parent
 * of the throwaway data directory (default: the OS temp directory).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { RuntimeToolProfile } from '../src/agents/types';

if (process.env.MICHI_KIRO_META_LIVE !== '1') throw new Error('Set MICHI_KIRO_META_LIVE=1 to use real Kiro');
const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(process.env.MICHI_KIRO_META_LIVE_DIR ?? os.tmpdir(), 'michi-meta-live-')));
process.env.MICHI_DATA_DIR = dataDir;
delete process.env.MICHI_CLOUD;

/* eslint-disable @typescript-eslint/no-require-imports */
const { initDb, closeDb } = require('../src/services/db') as typeof import('../src/services/db');
const { ensureAssistant } = require('../src/assistant/store') as typeof import('../src/assistant/store');
const { assistantToolProfile } = require('../src/assistant/policy') as typeof import('../src/assistant/policy');
const { maintenanceToolProfile } = require('../src/agents/maintenancePolicy') as typeof import('../src/agents/maintenancePolicy');
const { McpSlotRegistry, mountMcp } = require('../src/services/mcpServer') as typeof import('../src/services/mcpServer');
const { KiroRuntime } = require('michi-runtime/internal/adapters/kiro/KiroRuntime') as typeof import('michi-runtime/internal/adapters/kiro/KiroRuntime');
const { kiroV2MetaAgentCatalog, kiroV3MetaAgentCatalog, kiroMetaAgentDir } = require('../src/agents/kiro/kiroMetaAgent') as typeof import('../src/agents/kiro/kiroMetaAgent');
const { MetaAgentGuardError } = require('../src/agents/metaAgentGuard') as typeof import('../src/agents/metaAgentGuard');
const { saveWorkspace } = require('../src/services/dbRepository') as typeof import('../src/services/dbRepository');
/* eslint-enable @typescript-eslint/no-require-imports */

/** A real assistant tool the narrowed profile leaves out, so its slot exposes one tool too many. */
const EXTRA_TOOL = 'search_messages';

const bridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null } as any;

async function observedCatalog(runtime: any, id: string, engine: 'v2' | 'v3'): Promise<string[]> {
    const worker = runtime.sessionWorkers.get(id);
    const binding = worker.getBinding(id);
    const client = worker.pool.get(binding.cwd);
    return engine === 'v3'
        ? kiroV3MetaAgentCatalog(client.toolCatalog(binding.nativeSessionId)?.tags ?? [])
        : kiroV2MetaAgentCatalog(await client.executeCommand(binding.nativeSessionId, 'tools', {}, 30_000));
}

async function main() {
    initDb();
    const assistant = ensureAssistant();
    saveWorkspace({ id: 'ws-live', name: 'Live', created_at: 1, updated_at: 1, settings: null });
    const registry = new McpSlotRegistry();
    const app = express();
    app.use(express.json({ limit: '4mb' }));
    const router = express.Router();
    mountMcp(router, registry);
    app.use('/api', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const results: unknown[] = [];
    try {
        for (const engine of ['v2', 'v3'] as const) {
            for (const toolset of ['chat', 'maintenance'] as const) {
                const runtime = new KiroRuntime({ host: michiTestHost(), bridge: bridge, mcpSlots: fakeMcpRegistry(registry, { mcpPort: port }), defaultCwd: dataDir, modelCache: undefined, restrictedAgent: michiKiroRestrictedAgent, ...({ engine, sidecarTitles: false }) });
                const id = toolset === 'chat' ? assistant.nodeId : `n-maint-${engine}`;
                const profile: RuntimeToolProfile = toolset === 'chat' ? assistantToolProfile() : maintenanceToolProfile();
                const started = Date.now();
                try {
                    await runtime.newSession({
                        sessionId: id, cwd: dataDir, workspaceId: toolset === 'chat' ? assistant.workspaceId : 'ws-live',
                        ownerUserId: null, toolProfile: profile,
                    });
                    const catalog = await observedCatalog(runtime, id, engine);
                    const record = { engine, toolset, ok: true, ms: Date.now() - started, catalog: [...catalog].sort() };
                    results.push(record);
                    console.info(JSON.stringify(record));
                    assert.ok(catalog.length > 0, 'Michi tools are on the catalog');
                    for (const name of catalog) assert.ok(profile.allowedToolNames!.includes(name), `${engine}/${toolset}: ${name} is in the toolset`);
                    assert.deepEqual(catalog.filter((name) => name.startsWith('desk_')), [], `${engine}/${toolset}: no Agent Desk tool`);
                    assert.equal((runtime as any).sessionWorkers.get(id).defaultCwd, kiroMetaAgentDir(dataDir, toolset));
                } finally {
                    await runtime.shutdown();
                }
            }

            // A Michi slot that wrongly exposes one more tool than the profile allows must stop the session.
            const runtime = new KiroRuntime({ host: michiTestHost(), bridge: bridge, mcpSlots: fakeMcpRegistry(registry, { mcpPort: port }), defaultCwd: dataDir, modelCache: undefined, restrictedAgent: michiKiroRestrictedAgent, ...({ engine, sidecarTitles: false }) });
            const narrowed: RuntimeToolProfile = {
                ...assistantToolProfile(), allowedToolNames: assistantToolProfile().allowedToolNames!.filter((name) => name !== EXTRA_TOOL),
            };
            const create = registry.create.bind(registry);
            registry.create = ((...args: Parameters<typeof registry.create>) => {
                const slot = create(...args);
                slot.exposedToolNames = new Set([...(slot.exposedToolNames ?? []), EXTRA_TOOL]);
                return slot;
            }) as typeof registry.create;
            try {
                await assert.rejects(runtime.newSession({
                    sessionId: assistant.nodeId, cwd: dataDir, workspaceId: assistant.workspaceId, ownerUserId: null, toolProfile: narrowed,
                }), (error: unknown) => {
                    const record = { engine, toolset: 'chat', extraTool: EXTRA_TOOL, ok: false, error: (error as Error).message };
                    results.push(record);
                    console.info(JSON.stringify(record));
                    return error instanceof MetaAgentGuardError && error.violation.unexpectedTools.join() === EXTRA_TOOL;
                });
            } finally {
                registry.create = create;
                await runtime.shutdown();
            }
        }
        console.info('LIVE KIRO META AGENT CHECKS PASSED');
    } finally {
        server.close();
        closeDb();
        fs.writeFileSync(path.join(dataDir, 'results.json'), JSON.stringify(results, null, 2));
        console.info(`results: ${path.join(dataDir, 'results.json')}`);
    }
}

void main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
