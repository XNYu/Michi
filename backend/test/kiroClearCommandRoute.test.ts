import './isolatedConfigDir';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { closeDb, initDb } from '../src/services/db';
import { saveNode, saveWorkspace } from '../src/services/dbRepository';
import { registerSession, clearAllSessions } from '../src/agents/sessionRegistry';
import { registerRuntime } from '../src/agents/registry';
import { chatHub } from '../src/agents/chatHub';
import { setupMichiRoutes } from '../src/routes/michi';
import { RUNTIME_FACTORIES } from '../src/agents/runtimeFactories';
import { KiroRuntime } from 'michi-runtime/internal/adapters/kiro/KiroRuntime';
import type { ChatManager } from '../src/services/chatManager';
import type { AgentRuntime, AgentSession } from '../src/agents/types';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import { michiTestHost } from './helpers/michiTestHost';

// Which /clear the execute-command route runs: a runtime whose /clear
// replaces the native session (Kiro v3) resets the chat's context; every
// other runtime clears its session in place.

const originalDataDir = process.env.MICHI_DATA_DIR;
afterEach(() => {
    clearAllSessions(); closeDb();
    if (originalDataDir == null) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = originalDataDir;
});

const bridge: AgentToolBridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null };

test('/clear resets the context on Kiro v3 and clears in place on Kiro v2 and Crew', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-kiro-clear-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    process.env.MICHI_DATA_DIR = dir;
    closeDb(); initDb();
    saveWorkspace({ id: 'ws', name: 'Kiro clear', cwd: dir, created_at: 1, updated_at: 1 });
    saveNode({ id: 'a', workspace_id: 'ws', kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 });
    t.mock.method(chatHub, 'isActive', () => false);
    t.mock.method(chatHub, 'isOwnerTurnActive', () => false);
    let resets = 0;
    const chatManager = { resolvePrimaryAgentBinding: async () => { resets += 1; throw new Error('context reset'); } };
    const app = express(); app.use(express.json());
    app.use('/api', setupMichiRoutes(chatManager as unknown as ChatManager));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/chats/a/execute-command`;
    const runtimes: AgentRuntime[] = [];
    t.after(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await Promise.all(runtimes.map((runtime) => runtime.shutdown()));
    });

    async function clear(runtime: AgentRuntime, nativeEngine: string): Promise<{ status: number; error?: string; inPlace: string[] }> {
        runtimes.push(runtime);
        registerRuntime(runtime);
        const inPlace: string[] = [];
        const session: AgentSession = {
            id: 'a', runtimeId: runtime.id, nativeSessionId: 'native-a', nativeEngine,
            getHistory: () => [], getPendingAssistant: () => undefined, send: async function* () {}, cancel: () => {},
            executeCommand: async (command) => { inPlace.push(command); return { success: true }; },
        };
        registerSession(session, null);
        const response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: 'clear' }) });
        const body = await response.json() as { error?: string };
        return { status: response.status, error: body.error, inPlace };
    }

    const kiro = (engine: 'v2' | 'v3') => new KiroRuntime({ bridge, defaultCwd: dir, host: michiTestHost(), engine });
    const crew = RUNTIME_FACTORIES.find((factory) => factory.id === 'crew')!.create({ bridge, defaultCwd: dir, host: michiTestHost() });

    assert.deepEqual(await clear(kiro('v3'), 'v3'), { status: 500, error: 'context reset', inPlace: [] });
    assert.equal(resets, 1);
    assert.deepEqual(await clear(kiro('v2'), 'v2'), { status: 200, error: undefined, inPlace: ['clear'] });
    assert.deepEqual(await clear(crew, 'v2'), { status: 200, error: undefined, inPlace: ['clear'] });
    assert.equal(resets, 1);
});
