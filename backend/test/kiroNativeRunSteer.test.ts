import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KiroRunAdapter } from '../src/agents/runs/kiroRunAdapter';
import { RuntimeRunExecutor } from '../src/agents/runs/runtimeRunExecutor';
import { RuntimeRunAdapterRegistry } from '../src/agents/runs/runtimeRunAdapterRegistry';
import type { AgentRunSpec } from '../src/agents/runs/ports';
import type { AgentRuntime, AgentSession } from '../src/agents/types';

for (const mode of ['queued', 'immediate'] as const) {
    test(`Kiro Run ${mode} input respects the native active-turn contract and checkpoints engine`, async () => {
        let release!: () => void;
        let entered!: () => void;
        const started = new Promise<void>((resolve) => { entered = resolve; });
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const sent: string[] = []; const steers: string[] = []; const events: any[] = [];
        let cancels = 0; let closed = 0;
        const session: AgentSession = {
            id: 'attempt', runtimeId: 'kiro', nativeSessionId: 'native',
            owner: { kind: 'agent_run', runId: 'run', attemptId: 'attempt' },
            getHistory: () => [], getPendingAssistant: () => undefined,
            getNativeResumeToken: () => ({ engine: 'v3', sessionId: 'native' }),
            async *send(text) {
                sent.push(text);
                try {
                    if (sent.length === 1) { entered(); await gate; }
                    yield { kind: 'chunk', text: 'result' };
                    yield { kind: 'turn_end', stopReason: 'end_turn' };
                } finally { closed++; }
            },
            async steer(text) { assert.equal(cancels, 0); steers.push(text); return { accepted: true }; },
            async cancel() { cancels++; release(); },
        };
        const runtime = { id: 'kiro', capabilities: { nativeResume: true }, warm: async () => {},
            newSession: async () => session, releaseSession: async () => {},
        } as unknown as AgentRuntime;
        const spec = {
            runId: 'run', attemptId: 'attempt', workspaceId: 'workspace', ownerUserId: 'owner', task: 'initial',
            effectiveDefinition: { version: 1, name: 'test', instructions: '', description: '',
                runtimeProfile: { version: 1, runtimeId: 'kiro', modelId: null, providerId: null, reasoning: null },
                fallbackChain: [], capabilitySnapshot: { version: 1, entries: [] },
                permissionPolicy: { version: 1, preset: 'research', categories: {}, maxDelegationDepth: 1, maxConcurrentRuns: 1, maxWallTimeMs: 60000, maxAttempts: 1 },
                contextPolicy: { version: 1, includeWorkspaceInstructions: true, allowMessageContext: true, allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 10000 },
            },
            contextManifest: { version: 1, entries: [], assembledAt: 1, estimatedChars: 0 }, expectedResult: null,
            executionEnvironment: { version: 1, kind: 'shared_workspace', cwd: '/tmp', sourceWorkspaceId: 'workspace', snapshotHash: 'd'.repeat(64), createdAt: 1 }, recoveryEnvelope: null,
        } as AgentRunSpec;
        const executor = new RuntimeRunExecutor({ resolveRuntime: () => runtime, registry: new RuntimeRunAdapterRegistry([new KiroRunAdapter()]) });
        const handle = await executor.start(spec, async (event) => { events.push(event); });
        await started;
        await handle.input('guidance', mode);
        release();
        assert.equal((await handle.completion).status, 'completed');
        assert.equal(cancels, mode === 'immediate' ? 1 : 0);
        assert.deepEqual(steers, mode === 'queued' ? ['guidance'] : []);
        assert.equal(sent.length, mode === 'immediate' ? 2 : 1);
        assert.equal(closed, sent.length, 'all prompt generators must close before release');
        assert.ok(events.some((event) => event.nativeResumeToken?.engine === 'v3'));
    });
}
