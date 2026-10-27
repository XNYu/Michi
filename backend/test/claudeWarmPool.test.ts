/**
 * Unit tests for ClaudeWarmPool.ts
 *
 * Uses node:test (Node 22+) + ts-node.
 * Pure data-structure tests; the spawner is a test double that produces
 * lightweight fake-session shapes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeWarmPool } from 'michi-runtime/internal/adapters/claude/ClaudeWarmPool';
import type { Spawner } from 'michi-runtime/internal/adapters/claude/ClaudeWarmPool';
import type { ClaudeSession } from 'michi-runtime/internal/adapters/claude/ClaudeSession';
import { michiTestHost } from './helpers/michiTestHost';

/** Michi's perf marks, as ClaudeSessionManager passes the host's. */
const perf = michiTestHost().observability.perf;

// Lightweight fake session — only properties ClaudeWarmPool inspects.
function fakeSession(id: string): ClaudeSession {
    return {
        id,
        isAlive: () => true,
        dispose: async () => { /* noop */ },
        warmInit: async () => { /* noop */ },
    } as unknown as ClaudeSession;
}

describe('ClaudeWarmPool — registerWorkspace + replenish', () => {
    test('registerWorkspace on same cwd is idempotent (no extra spawn)', async () => {
        let spawnCount = 0;
        const spawner: Spawner = async (cwd, model) => {
            spawnCount++;
            return fakeSession(`${cwd}/${model}`);
        };
        const pool = new ClaudeWarmPool({ spawner, perf, currentModel: 'sonnet', sessionsPerSlot: 1 });
        await pool.registerWorkspace('/tmp/a');
        await pool.registerWorkspace('/tmp/a');
        assert.equal(spawnCount, 1);
    });

    test('evictOldest removes and disposes the oldest warm entry', async () => {
        const disposed: string[] = [];
        const spawner: Spawner = async (cwd, model) => ({
            id: `${cwd}/${model}`,
            isAlive: () => true,
            dispose: async () => { disposed.push(`${cwd}/${model}`); },
            warmInit: async () => {},
        } as unknown as ClaudeSession);
        const pool = new ClaudeWarmPool({ spawner, perf, currentModel: 'sonnet', sessionsPerSlot: 1 });

        await pool.registerWorkspace('/tmp/a');
        await new Promise((r) => setTimeout(r, 5));
        await pool.registerWorkspace('/tmp/b');

        assert.equal(await pool.evictOldest('test'), true);
        assert.equal(pool.size(), 1);
        assert.deepEqual(disposed, ['/tmp/a/sonnet']);
        assert.equal(pool.take('/tmp/a', 'sonnet'), null);
        assert.ok(pool.take('/tmp/b', 'sonnet'));
        await pool.shutdown();
    });

    test('waitForInflight returns null when matching warm slot fails', async () => {
        let releaseSpawn!: () => void;
        const spawner: Spawner = async () => {
            await new Promise<void>((resolve) => { releaseSpawn = resolve; });
            throw new Error('warm failed');
        };
        const pool = new ClaudeWarmPool({ spawner, perf, currentModel: 'sonnet', sessionsPerSlot: 1 });

        const warm = pool.registerWorkspace('/tmp/a');
        await new Promise((r) => setImmediate(r));
        const wait = pool.waitForInflight('/tmp/a', 'sonnet');
        releaseSpawn();
        await warm;
        const got = await wait;
        assert.equal(got, null);
        assert.equal(pool.take('/tmp/a', 'sonnet'), null);
        await pool.shutdown();
    });

    test('Model change Case 1: switch back to in-grace model cancels grace, old becomes grace', async () => {
        const spawner: Spawner = async (cwd, model) => fakeSession(`${cwd}/${model}`);
        const pool = new ClaudeWarmPool({ spawner, perf, currentModel: 'sonnet', sessionsPerSlot: 1, modelGraceMs: 60_000 });
        await pool.registerWorkspace('/tmp/a');
        await pool.notifyModelChange('opus');     // opus warmed; sonnet → grace
        assert.equal(pool.size(), 2, 'after switching to opus, both models warm for /tmp/a');
        await pool.notifyModelChange('sonnet');   // back to sonnet; opus → grace
        assert.equal(pool.size(), 2, 'no kills on switch-back; both still warm');
        assert.ok(pool.take('/tmp/a', 'sonnet'), 'sonnet hits');
        // After take(sonnet) one entry remains
        assert.equal(pool.size(), 1);
        assert.ok(pool.take('/tmp/a', 'opus'), 'opus still warm (now in grace)');
        await pool.shutdown();
    });

    test('Model change Case 3: third model evicts the in-grace model', async () => {
        const spawner: Spawner = async (cwd, model) => fakeSession(`${cwd}/${model}`);
        const pool = new ClaudeWarmPool({ spawner, perf, currentModel: 'sonnet', sessionsPerSlot: 1, modelGraceMs: 60_000 });
        await pool.registerWorkspace('/tmp/a');
        await pool.notifyModelChange('opus');    // sonnet → grace, opus current
        assert.equal(pool.size(), 2);
        await pool.notifyModelChange('haiku');   // sonnet evicted; opus → grace
        assert.equal(pool.size(), 2, 'always at most 2 models tracked');
        assert.equal(pool.take('/tmp/a', 'sonnet'), null, 'sonnet entries are gone');
        assert.ok(pool.take('/tmp/a', 'opus'), 'opus still in grace');
        await pool.shutdown();
    });

    test('Model grace timer fires → kills all entries of that model', async () => {
        const disposed: string[] = [];
        const spawner: Spawner = async (cwd, model) => ({
            id: `${cwd}/${model}`,
            isAlive: () => true,
            dispose: async () => { disposed.push(`${cwd}/${model}`); },
            warmInit: async () => {},
        } as unknown as ClaudeSession);
        const pool = new ClaudeWarmPool({ spawner, perf, currentModel: 'sonnet', sessionsPerSlot: 1, modelGraceMs: 30 });
        await pool.registerWorkspace('/tmp/a');
        await pool.notifyModelChange('opus');
        assert.equal(pool.size(), 2);
        // Wait past grace
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(pool.size(), 1, 'sonnet entries gone after grace');
        assert.equal(pool.take('/tmp/a', 'sonnet'), null);
        assert.ok(pool.take('/tmp/a', 'opus'));
        assert.deepEqual(disposed, ['/tmp/a/sonnet'], 'evicted sonnet session was disposed');
        await pool.shutdown();
    });

    test('MRU promote does NOT evict (re-registering an existing cwd)', async () => {
        const spawner: Spawner = async (cwd, model) => fakeSession(`${cwd}/${model}`);
        const pool = new ClaudeWarmPool({ spawner, perf, currentModel: 'sonnet', sessionsPerSlot: 1, workspaceCapacity: 3 });
        await pool.registerWorkspace('/tmp/a');
        await pool.registerWorkspace('/tmp/b');
        await pool.registerWorkspace('/tmp/c');
        // Promote /tmp/a back to MRU
        await pool.registerWorkspace('/tmp/a');
        assert.equal(pool.size(), 3, 'still 3 — no eviction on promote');
        // Adding /tmp/d now evicts /tmp/b (oldest after promote)
        await pool.registerWorkspace('/tmp/d');
        assert.equal(pool.take('/tmp/b', 'sonnet'), null, 'b was evicted because promote made a MRU');
        assert.ok(pool.take('/tmp/a', 'sonnet'), 'a survived');
        await pool.shutdown();
    });

    test('sessionsPerSlot: dead entries are skipped and a live one is handed out', async () => {
        let spawnCount = 0;
        const alive = new Map<string, boolean>();
        const spawner: Spawner = async (cwd, model) => {
            spawnCount++;
            const id = `${cwd}/${model}/${spawnCount}`;
            alive.set(id, true);
            return {
                id,
                isAlive: () => alive.get(id) ?? false,
                dispose: async () => {},
                warmInit: async () => {},
            } as unknown as ClaudeSession;
        };
        const pool = new ClaudeWarmPool({ spawner, perf, currentModel: 'sonnet', sessionsPerSlot: 2 });
        await pool.registerWorkspace('/tmp/a');
        assert.equal(pool.size(), 2);

        // Kill the newest entry; take() must skip it and return the older live one
        alive.set('/tmp/a/sonnet/2', false);
        const got = pool.take('/tmp/a', 'sonnet');
        assert.ok(got, 'take should skip the dead entry and hit the live one');
        assert.equal(got!.id, '/tmp/a/sonnet/1');
        await pool.shutdown();
    });

    test('idle TTL fires → entry disposed + removed', async () => {
        const disposed: string[] = [];
        const spawner: Spawner = async (cwd, model) => ({
            id: `${cwd}/${model}`,
            isAlive: () => true,
            dispose: async () => { disposed.push(`${cwd}/${model}`); },
            warmInit: async () => {},
        } as unknown as ClaudeSession);
        const pool = new ClaudeWarmPool({ spawner, perf, currentModel: 'sonnet', sessionsPerSlot: 1, idleTtlMs: 30 });
        await pool.registerWorkspace('/tmp/a');
        assert.equal(pool.size(), 1);

        await new Promise((r) => setTimeout(r, 80));
        assert.equal(pool.size(), 0);
        assert.deepEqual(disposed, ['/tmp/a/sonnet']);
        await pool.shutdown();
    });
});
