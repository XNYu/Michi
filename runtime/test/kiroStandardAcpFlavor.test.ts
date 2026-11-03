/**
 * KiroRuntime and KiroSession for a standard ACP agent (AcpLaunch.standardAcp,
 * Antigravity's `agy acp`) and the KiroFlavor fields it reads: reasoning
 * through the `thought_level` config option, no probe for modes it lacks, no
 * warm sessions, its own "session gone" errors, resource_link images, its own
 * tool titles and names, token usage, failed cards for declined approvals and
 * elicitation answers routed to its client. Each case also pins the default:
 * without those options Kiro and Kiro Crew behave as before.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createDefaultHost } from '../src/core/defaultHost';
import { KiroRuntime } from '../src/adapters/kiro/KiroRuntime';
import { KiroSession } from '../src/adapters/kiro/KiroSession';
import { KIRO_FLAVOR, type KiroFlavor } from '../src/adapters/kiro/kiroFlavor';
import { NativeResumeUnavailableError } from '../src/contract/errors';
import { KiroSessionSnapshots } from '../src/adapters/kiro/sessionSnapshots';
import {
    acpPermissionToolName, canonicalKiroToolName, kiroBrokerToolName, KiroToolCallNames,
} from '../src/adapters/kiro/kiroToolNames';
import type { AcpLaunch } from '../src/adapters/kiro/kiroAcpProfile';
import type { RuntimePermissionBroker } from '../src/contract/types';
import { headless, interactive } from './owners';

const tempDirs: string[] = [];
afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-standard-acp-'));
    tempDirs.push(dir);
    return dir;
}

const STANDARD_LAUNCH: AcpLaunch = { bin: '/bin/false', args: () => ['acp'], standardAcp: true };

const THOUGHT_LEVEL = {
    id: 'thought_level', name: 'Thinking Level', category: 'thought_level', type: 'select', currentValue: 'medium',
    options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }],
};
const MODEL_OPTION = {
    id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gemini-4-argon',
    options: [{ value: 'gemini-4-argon', name: 'Gemini 4 Argon' }, { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }],
};
const AGY_MODELS = {
    currentModelId: 'gemini-4-argon',
    availableModels: [
        { value: 'gemini-4-argon', name: 'Gemini 4 Argon', modelId: 'gemini-4-argon' },
        { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', modelId: 'gemini-3.8-flash' },
    ],
};

/** What an agy-like preset sets on the flavor (the real one lives in adapters/antigravity). */
const STANDARD_FLAVOR: KiroFlavor = {
    ...KIRO_FLAVOR,
    nativeSessions: { replaceable: true, isUnavailable: (error) => /no such session here/.test(String(error)) },
    promptImages: 'resourceLink',
    warmSessions: false,
    tools: {
        title: (update) => typeof update.name === 'string' && update.name.startsWith('mcp_michi_')
            ? update.name.slice('mcp_michi_'.length) : undefined,
        name: (toolCall) => typeof toolCall?.name === 'string' ? toolCall.name : undefined,
    },
    signIn: { matches: () => false, message: 'Sign in to the agent.' },
};

function runtime(options: { standard?: boolean; flavor?: KiroFlavor; modes?: boolean; launch?: AcpLaunch } = {}): KiroRuntime {
    const standard = options.standard ?? true;
    return new KiroRuntime({
        host: createDefaultHost({ logLevel: 'silent' }),
        bridge: {},
        engine: 'v2',
        defaultCwd: '/tmp',
        ...(standard ? { launch: options.launch ?? STANDARD_LAUNCH, flavor: options.flavor ?? STANDARD_FLAVOR } : {}),
        ...(!standard && options.flavor ? { flavor: options.flavor } : {}),
        ...(options.modes === undefined ? {} : { capabilitiesOverride: { modes: options.modes } }),
    });
}

/** An ACP client stand-in whose prompt yields what the test pushes and what the session injects. */
function fakeClient() {
    const queue: Record<string, any>[] = [];
    let wake: (() => void) | null = null;
    const push = (update: Record<string, any>) => { queue.push(update); wake?.(); wake = null; };
    const client = {
        prompts: [] as Array<{ text: string; blocks: unknown[] }>,
        responses: [] as Array<[number, string]>,
        cancels: [] as number[],
        injected: [] as Record<string, any>[],
        push,
        async *prompt(_sid: string, text: string, blocks: unknown[] = []) {
            client.prompts.push({ text, blocks });
            for (;;) {
                while (queue.length) {
                    const update = queue.shift()!;
                    yield update;
                    if (update.sessionUpdate === 'turn_end') return;
                }
                await new Promise<void>((resolve) => { wake = resolve; });
            }
        },
        injectUpdate(_sid: string, update: Record<string, any>) { client.injected.push(update); push(update); return true; },
        respondToPermission(requestId: number, optionId: string) { client.responses.push([requestId, optionId]); },
        respondToPermissionKind(requestId: number, kind: string) { client.responses.push([requestId, kind]); },
        cancelPermission(requestId: number) { client.cancels.push(requestId); },
    };
    return client;
}

type FakeClient = ReturnType<typeof fakeClient>;

/** The KiroRuntime surface a KiroSession reads, over one fake client. */
function standIn(client: FakeClient, options: { standard?: boolean; flavor?: KiroFlavor } = {}): KiroRuntime {
    return {
        host: createDefaultHost({ logLevel: 'silent' }),
        engine: 'v2',
        flavor: options.flavor ?? (options.standard === false ? KIRO_FLAVOR : STANDARD_FLAVOR),
        standardAcp: options.standard !== false,
        ensureClient: async () => client,
        getClient: () => client,
        getCurrentMode: () => null,
        getCurrentModel: () => null,
        respondToPermission: (_sid: string, requestId: number, optionId: string) => client.respondToPermission(requestId, optionId),
        cancelPermission: (_sid: string, requestId: number) => client.cancelPermission(requestId),
    } as unknown as KiroRuntime;
}

/** A turn read in the background: its events so far, and a wait for one. */
function startTurn(session: KiroSession, input?: Parameters<KiroSession['send']>[1]) {
    const events: any[] = [];
    const done = (async () => { for await (const event of session.send('go', input)) events.push(event); })();
    const until = async (predicate: (event: any) => boolean) => {
        for (let i = 0; i < 200; i++) {
            const found = events.find(predicate);
            if (found) return found;
            await delay(1);
        }
        throw new Error('event not seen');
    };
    return { events, done, until };
}

const WRITE_FILE = {
    sessionUpdate: 'tool_call', toolCallId: 'call_1', name: 'write_file', kind: 'edit', title: 'File hello.txt',
    status: 'pending', rawInput: { Path: '/w/hello.txt', Content: 'hi' },
};
const AGY_OPTIONS = [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }];

function permissionRequest(requestId: number, toolCall: Record<string, any> = WRITE_FILE) {
    return { sessionUpdate: 'permission_request', requestId, toolCall, options: AGY_OPTIONS };
}

const FAILED = (toolCallId: string) => ({ sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' });

describe('KiroRuntime reasoning for a standard ACP agent', () => {
    function configClient(configOptions?: unknown[]) {
        const calls: unknown[][] = [];
        return {
            calls,
            getSessionInfo: () => (configOptions ? { configOptions } : {}),
            setConfigOption: async (...args: unknown[]) => { calls.push(['setConfigOption', ...args]); return []; },
            executeCommand: async (...args: unknown[]) => { calls.push(['executeCommand', ...args]); return { success: true }; },
        };
    }

    it('sets the thought_level config option on v2, with no Kiro command', async () => {
        const client = configClient([MODEL_OPTION, THOUGHT_LEVEL]);
        await (runtime() as any).applyReasoning(client, 'sid', 'high');
        assert.deepEqual(client.calls, [['setConfigOption', 'sid', 'thought_level', 'high']]);
    });

    it('keeps the session as it is when it has no such option, or not that level', async () => {
        const none = configClient([MODEL_OPTION]);
        await (runtime() as any).applyReasoning(none, 'sid', 'high');
        const unoffered = configClient([THOUGHT_LEVEL]);
        await (runtime() as any).applyReasoning(unoffered, 'sid', 'max');
        assert.deepEqual([...none.calls, ...unoffered.calls], []);
    });

    it('Kiro v2 keeps its /effort command', async () => {
        const client = configClient([THOUGHT_LEVEL]);
        await (runtime({ standard: false }) as any).applyReasoning(client, 'sid', 'high');
        assert.deepEqual(client.calls, [['executeCommand', 'sid', 'effort', { value: 'high' }]]);
    });
});

describe('KiroRuntime model catalog for a standard ACP agent', () => {
    it('marks every model with the thought_level levels', async () => {
        const rt = runtime();
        (rt as any).absorbModels('sid', AGY_MODELS, [MODEL_OPTION, THOUGHT_LEVEL]);
        assert.deepEqual(await rt.listModels(), [
            { id: 'gemini-4-argon', label: 'Gemini 4 Argon', description: undefined, supportsReasoning: true, supportedReasoningLevels: ['low', 'medium', 'high'] },
            { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', description: undefined, supportsReasoning: true, supportedReasoningLevels: ['low', 'medium', 'high'] },
        ]);
        assert.equal(rt.getCurrentModel('sid'), 'gemini-4-argon');
    });

    it('says nothing about reasoning without a thought_level option, and Kiro v2 is unchanged', async () => {
        const standard = runtime();
        (standard as any).absorbModels('sid', AGY_MODELS, [MODEL_OPTION]);
        assert.equal((await standard.listModels()).some((model) => 'supportsReasoning' in model), false);
        const kiro = runtime({ standard: false });
        (kiro as any).absorbModels('sid', { availableModels: [{ modelId: 'claude', name: 'Claude' }, { modelId: 'auto' }] }, [THOUGHT_LEVEL]);
        assert.deepEqual(await kiro.listModels(), [
            { id: 'claude', label: 'Claude', description: undefined },
            { id: 'auto', label: undefined, description: undefined, supportsReasoning: false, supportedReasoningLevels: [] },
        ]);
    });
});

describe('KiroRuntime probes and warm sessions', () => {
    function probeClient(result: Record<string, any>) {
        const calls: string[] = [];
        return {
            calls,
            newSession: async () => { calls.push('newSession'); return { sessionId: 'probe', ...result }; },
            destroySession: (sid: string) => { calls.push(`destroy:${sid}`); },
            cancel: async () => false,
            shutdown: async () => {},
        };
    }

    it('opens no probe session for modes an agent does not have, but still probes once for models', async () => {
        const rt = runtime({ modes: false });
        const client = probeClient({ models: AGY_MODELS, configOptions: [MODEL_OPTION, THOUGHT_LEVEL] });
        let starts = 0;
        (rt as any).ensureClient = async () => { starts++; return client; };
        assert.deepEqual(await rt.getAvailableModes(), []);
        assert.deepEqual(await rt.listModes('sid'), []);
        assert.equal(starts, 0, 'no client for modes');
        const models = await rt.refreshModels();
        assert.deepEqual(models.map((model) => [model.id, model.supportsReasoning]), [['gemini-4-argon', true], ['gemini-3.8-flash', true]]);
        assert.deepEqual(client.calls, ['newSession', 'destroy:probe']);
        await rt.refreshModels();
        assert.deepEqual(client.calls, ['newSession', 'destroy:probe'], 'the catalog is kept');
    });

    it('Kiro still probes modes with a session of its own', async () => {
        const rt = runtime({ standard: false });
        const client = probeClient({ modes: { currentModeId: 'kiro_default', availableModes: [{ id: 'kiro_default' }] } });
        (rt as any).ensureClient = async () => client;
        assert.deepEqual(await rt.getAvailableModes(), [{ id: 'kiro_default' }]);
        assert.deepEqual(client.calls, ['newSession', 'destroy:probe']);
    });

    it('warm() starts the client and pre-opens nothing when the flavor has no warm sessions', async () => {
        const rt = runtime();
        const client = probeClient({});
        const starts: string[] = [];
        (rt as any).ensureClient = async (cwd: string) => { starts.push(cwd); return client; };
        await rt.warm('/w');
        rt.warmNextSession('/w');
        await delay(5);
        assert.deepEqual(starts, ['/w']);
        assert.deepEqual(client.calls, []);
        assert.deepEqual(rt.listWarmedSessions(), []);
        assert.equal(rt.consumeWarmedSession('/w'), undefined);
    });

    it('Kiro still warms a session', async () => {
        const rt = runtime({ standard: false });
        const client = probeClient({ modes: { currentModeId: 'kiro_default', availableModes: [{ id: 'kiro_default' }] } });
        (rt as any).ensureClient = async () => client;
        (rt as any).pool.set('/w', client);
        await rt.warm('/w');
        assert.ok(client.calls.includes('newSession'));
        assert.ok(rt.listWarmedSessions().length >= 1);
        await rt.shutdown();
    });
});

describe('KiroRuntime native sessions the agent no longer has', () => {
    const failing = (error: Error) => ({ loadSession: async () => { throw error; }, setModel: async () => {} });

    it("treats the flavor's own error as unavailable, so the host rebuilds the chat", async () => {
        await assert.rejects(runtime().loadAcpSession({ sessionId: 'gone', cwd: '/w', client: failing(new Error('no such session here')) as any }),
            NativeResumeUnavailableError);
    });

    it('leaves any other error, and Kiro keeps its own checks', async () => {
        const other = new Error('model quota exceeded');
        await assert.rejects(runtime().loadAcpSession({ sessionId: 'x', cwd: '/w', client: failing(other) as any }), (error) => error === other);
        const kiroError = new Error('no such session here');
        await assert.rejects(runtime({ standard: false }).loadAcpSession({ sessionId: 'x', cwd: '/w', client: failing(kiroError) as any }),
            (error) => error === kiroError);
    });
});

describe('KiroRuntime user input asked through an ACP client', () => {
    it("answers or skips a client's question that is not ask_user's own", () => {
        const rt = runtime();
        const calls: unknown[][] = [];
        const own = 1_000_000_001;
        (rt as any).pool.set('/w', {
            respondToUserInput: (id: number, answers: unknown) => { calls.push(['answer', id, answers]); return id === own; },
            skipUserInput: (id: number) => { calls.push(['skip', id]); return id === own; },
        });
        const answers = [{ question: 'Color?', answer: 'Red' }];
        rt.respondToUserInput(own, answers);
        rt.skipUserInput(own);
        assert.deepEqual(calls, [['answer', own, answers], ['skip', own]]);
        (rt as any).pool.clear();
    });

    it("an ask_user question of its own never reaches a client", () => {
        const rt = runtime({ standard: false });
        const calls: unknown[] = [];
        (rt as any).pool.set('/w', { respondToUserInput: () => { calls.push('client'); return true; }, skipUserInput: () => true });
        let resolved: unknown;
        (rt as any).pendingUserInputs.set(7, { resolve: (value: unknown) => { resolved = value; }, timer: setTimeout(() => {}, 1_000) });
        rt.respondToUserInput(7, [{ question: 'q', answer: 'a' }]);
        assert.deepEqual(resolved, [{ question: 'q', answer: 'a' }]);
        assert.deepEqual(calls, []);
        (rt as any).pool.clear();
    });
});

describe('KiroRuntime ACP client options', () => {
    it("passes the flavor's sign-in check and the agent's name to a standard ACP launch only", () => {
        const options = (runtime({ flavor: STANDARD_FLAVOR }) as any).acpClientOptions();
        assert.equal(options.signIn, STANDARD_FLAVOR.signIn);
        assert.equal(options.displayName, 'Kiro', 'the runtime label');
        const kiro = (runtime({ standard: false }) as any).acpClientOptions();
        assert.equal('signIn' in kiro, false);
        assert.equal('displayName' in kiro, false);
    });
});

describe('KiroSession images', () => {
    function image(): { name: string; absPath: string } {
        const absPath = path.join(tempDir(), 'red pixel.png');
        fs.writeFileSync(absPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        return { name: 'red pixel.png', absPath };
    }

    it('links each image to its file and names it in the text for a resourceLink flavor', async () => {
        const client = fakeClient();
        const session = new KiroSession('node', 'sid', standIn(client), '/w', { owner: interactive('node') });
        const attachment = image();
        client.push({ sessionUpdate: 'turn_end', stopReason: 'end_turn' });
        await startTurn(session, { attachments: [attachment] }).done;
        const [{ text, blocks }] = client.prompts;
        assert.deepEqual(blocks, [{ type: 'resource_link', uri: pathToFileURL(attachment.absPath).href, name: 'red pixel.png', mimeType: 'image/png' }]);
        assert.match(text, /\[Attached images\]/);
        assert.ok(text.includes(`- red pixel.png → ${attachment.absPath}`));
        assert.deepEqual(session.getHistory()[0], { role: 'user', content: 'go' }, 'the note stays out of history');
    });

    it('Kiro still sends base64 image blocks and no note', async () => {
        const client = fakeClient();
        const session = new KiroSession('node', 'sid', standIn(client, { standard: false }), '/w', { owner: interactive('node') });
        client.push({ sessionUpdate: 'turn_end', stopReason: 'end_turn' });
        await startTurn(session, { attachments: [image()] }).done;
        const [{ text, blocks }] = client.prompts;
        assert.deepEqual(blocks, [{ type: 'image', mimeType: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') }]);
        assert.doesNotMatch(text, /Attached images/);
    });
});

describe('KiroSession tool calls of a standard ACP agent', () => {
    async function toolEvents(updates: Record<string, any>[], standard = true) {
        const client = fakeClient();
        const session = new KiroSession('node', 'sid', standIn(client, { standard }), '/w', { owner: interactive('node') });
        const turn = startTurn(session);
        for (const update of updates) client.push(update);
        client.push({ sessionUpdate: 'turn_end', stopReason: 'end_turn' });
        await turn.done;
        return turn.events.filter((event) => event.kind === 'tool_call' || event.kind === 'tool_call_update');
    }

    it("titles calls with the flavor's title, on tool_call and tool_call_update", async () => {
        const events = await toolEvents([
            { sessionUpdate: 'tool_call', toolCallId: 'm', name: 'mcp_michi_set_follow_ups', title: 'Run mcp_michi_set_follow_ups', status: 'in_progress' },
            { sessionUpdate: 'tool_call_update', toolCallId: 'm', name: 'mcp_michi_set_follow_ups', title: 'Run mcp_michi_set_follow_ups', status: 'completed' },
            { sessionUpdate: 'tool_call', toolCallId: 'w', name: 'write_file', title: 'File hello.txt', status: 'in_progress' },
        ]);
        assert.deepEqual(events.map((event) => event.title), ['set_follow_ups', 'set_follow_ups', 'File hello.txt']);
    });

    it('shows the content of a call whose rawOutput is {}, and the text of a string output', async () => {
        const diff = { type: 'diff', path: '/w/hello.txt', newText: 'hi\n' };
        const events = await toolEvents([
            { ...WRITE_FILE, sessionUpdate: 'tool_call_update', status: 'completed', rawOutput: {}, content: [diff] },
            { sessionUpdate: 'tool_call_update', toolCallId: 'c', name: 'run_command', status: 'completed', rawOutput: { output: 'a.txt\n', exit_code: 0 } },
            { sessionUpdate: 'tool_call_update', toolCallId: 'd', status: 'completed', rawOutput: { exit_code: 1 } },
        ]);
        assert.deepEqual(events.map((event) => event.output), [JSON.stringify(diff), 'a.txt\n', '{"exit_code":1}']);
    });

    it('Kiro keeps its titles and quotes its rawOutput as before', async () => {
        const events = await toolEvents([
            { sessionUpdate: 'tool_call', toolCallId: 'm', name: 'mcp_michi_set_follow_ups', title: 'Run mcp_michi_set_follow_ups', status: 'in_progress' },
            { ...WRITE_FILE, sessionUpdate: 'tool_call_update', status: 'completed', rawOutput: {}, content: [{ type: 'diff', newText: 'hi' }] },
            { sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'completed', rawOutput: { output: 'a.txt\n' } },
        ], false);
        assert.deepEqual(events.map((event) => event.title), ['Run mcp_michi_set_follow_ups', 'File hello.txt', '']);
        assert.deepEqual(events.slice(1).map((event) => event.output), ['{}', '{"output":"a.txt\\n"}']);
    });
});

describe('KiroSession usage of a standard ACP agent', () => {
    async function usage(update: Record<string, any>) {
        const client = fakeClient();
        const session = new KiroSession('node', 'sid', standIn(client), '/w', { owner: interactive('node') });
        const turn = startTurn(session);
        client.push(update);
        client.push({ sessionUpdate: 'turn_end', stopReason: 'end_turn' });
        await turn.done;
        return turn.events.find((event) => event.kind === 'usage_summary');
    }

    it('forwards token counts as native usage only: no credits, charge or context share', async () => {
        assert.deepEqual(await usage({
            sessionUpdate: 'usage_summary', source: 'acp',
            inputTokens: 21375, outputTokens: 384, cachedInputTokens: 9833, reasoningOutputTokens: 83, totalTokens: 21842, bogus: Number.NaN,
        }), {
            kind: 'usage_summary', source: 'native',
            totalTokens: 21842, inputTokens: 21375, cachedInputTokens: 9833, outputTokens: 384, reasoningOutputTokens: 83,
        });
        assert.deepEqual(await usage({ sessionUpdate: 'usage_summary', source: 'acp', inputTokens: Number.NaN }), { kind: 'usage_summary', source: 'unverifiable' });
    });

    it("Kiro's native metering is unchanged", async () => {
        assert.deepEqual(await usage({ sessionUpdate: 'usage_summary', contextUsagePercentage: 12, meteringUsage: [{ value: 0.5 }], turnDurationMs: 30 }), {
            kind: 'usage_summary', contextUsagePercentage: 12, totalCredits: 0.5,
            charge: { amount: 0.5, unit: 'credits', provenance: 'native_metering' }, source: 'native', turnDurationMs: 30,
        });
    });
});

describe('KiroSession approvals of a standard ACP agent', () => {
    it("names the tool by the agent's name, so it can be trusted, and a trusted tool asks no more", async () => {
        const client = fakeClient();
        const session = new KiroSession('node', 'sid', standIn(client), '/w', { owner: interactive('node') });
        const turn = startTurn(session);
        client.push(WRITE_FILE);
        client.push(permissionRequest(1));
        const shown = await turn.until((event) => event.kind === 'permission_request');
        assert.equal(shown.title, 'Approve write_file?');
        const trust = shown.options.find((option: any) => option.optionId === 'michi:allow_always');
        assert.equal(trust.disabled, undefined, 'Trust this tool is offered');
        session.respondToPermission(1, 'michi:allow_always');
        client.push(permissionRequest(2, { ...WRITE_FILE, toolCallId: 'call_2' }));
        client.push({ sessionUpdate: 'turn_end', stopReason: 'end_turn' });
        await turn.done;
        assert.deepEqual(client.responses, [[1, 'allow'], [2, 'allow']]);
        assert.equal(turn.events.filter((event) => event.kind === 'permission_request').length, 1);
        assert.deepEqual(client.injected, [], 'an allowed call is left to the agent');
    });

    it('Kiro without a name keeps the prose title and no grant', async () => {
        const client = fakeClient();
        const session = new KiroSession('node', 'sid', standIn(client, { standard: false }), '/w', { owner: interactive('node') });
        const turn = startTurn(session);
        client.push(permissionRequest(1));
        const shown = await turn.until((event) => event.kind === 'permission_request');
        assert.equal(shown.title, 'File hello.txt');
        assert.equal(shown.options.find((option: any) => option.optionId === 'michi:allow_always').disabled, true);
        session.respondToPermission(1, 'deny');
        client.push({ sessionUpdate: 'turn_end', stopReason: 'end_turn' });
        await turn.done;
        assert.deepEqual(client.injected, [], 'no synthetic update for Kiro');
    });

    for (const how of ['deny', 'cancel'] as const) {
        it(`settles a call whose approval is ${how === 'deny' ? 'denied' : 'cancelled'} as failed`, async () => {
            const client = fakeClient();
            const session = new KiroSession('node', 'sid', standIn(client), '/w', { owner: interactive('node') });
            const turn = startTurn(session);
            client.push(WRITE_FILE);
            client.push(permissionRequest(1));
            await turn.until((event) => event.kind === 'permission_request');
            if (how === 'deny') session.respondToPermission(1, 'deny');
            else session.cancelPermission(1);
            const failed = await turn.until((event) => event.kind === 'tool_call_update' && event.status === 'failed');
            assert.equal(failed.toolCallId, 'call_1');
            // agy 1.4.12 still reports the declined call as in_progress afterwards.
            client.push({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'in_progress' });
            client.push({ sessionUpdate: 'turn_end', stopReason: 'end_turn' });
            await turn.done;
            const updates = turn.events.filter((event: any) => event.kind === 'tool_call_update' && event.toolCallId === 'call_1');
            assert.equal((updates.at(-1) as any).status, 'failed');
            assert.deepEqual(client.injected, [FAILED('call_1')]);
            assert.deepEqual(how === 'deny' ? client.responses : client.cancels, how === 'deny' ? [[1, 'deny']] : [1]);
        });
    }

    it('names the tool canonically to the Run broker, and settles a call the broker denies', async () => {
        const client = fakeClient();
        const asked: string[] = [];
        const broker: RuntimePermissionBroker = {
            requestPermission: async (request) => { asked.push(request.toolName); return request.toolName === 'bash' ? 'allow_once' : 'deny'; },
        } as RuntimePermissionBroker;
        const session = new KiroSession('attempt', 'sid', standIn(client), '/w', { owner: headless('attempt'), permissionBroker: broker });
        const turn = startTurn(session);
        client.push(permissionRequest(1, { toolCallId: 'cmd', name: 'run_command', title: 'ls -la' }));
        client.push(permissionRequest(2));
        await turn.until((event) => event.kind === 'tool_call_update' && event.toolCallId === 'call_1');
        client.push({ sessionUpdate: 'turn_end', stopReason: 'end_turn' });
        await turn.done;
        assert.deepEqual(asked, ['bash', 'write']);
        assert.deepEqual(client.responses, [[1, 'allow']]);
        assert.deepEqual(client.cancels, [2]);
        assert.deepEqual(client.injected, [FAILED('call_1')]);
    });

    it('Kiro without a name sends the broker "unknown" and adds no update', async () => {
        const client = fakeClient();
        const asked: string[] = [];
        const broker = { requestPermission: async (request: { toolName: string }) => { asked.push(request.toolName); return 'deny'; } } as RuntimePermissionBroker;
        const session = new KiroSession('attempt', 'sid', standIn(client, { standard: false }), '/w', { owner: headless('attempt'), permissionBroker: broker });
        const turn = startTurn(session);
        client.push(permissionRequest(1));
        await delay(5);
        client.push({ sessionUpdate: 'turn_end', stopReason: 'end_turn' });
        await turn.done;
        assert.deepEqual(asked, ['unknown']);
        assert.deepEqual(client.cancels, [1]);
        assert.deepEqual(client.injected, []);
    });
});

describe('Kiro tool names', () => {
    const name = (toolCall: Record<string, any> | undefined) => toolCall?.name;

    it("reads the agent's own name first, for chat grants and the broker", () => {
        const toolCall = { name: 'write_file', title: 'write', _meta: { toolName: 'fs_write' } };
        assert.equal(acpPermissionToolName(toolCall, undefined, name), 'write_file');
        assert.equal(kiroBrokerToolName(toolCall, undefined, undefined, name), 'write');
        assert.equal(acpPermissionToolName(toolCall), 'fs_write', 'without a resolver, Kiro metadata as before');
        assert.equal(kiroBrokerToolName({ title: 'ls -la' }, undefined, undefined, () => '  '), 'unknown');
    });

    it("maps Antigravity's tools to Michi's names and leaves Kiro's mappings", () => {
        assert.deepEqual(['write_file', 'replace_file_content', 'multi_replace_file_content', 'read_file', 'view_file',
            'run_command', 'list_dir', 'find_by_name', 'grep_search', 'invoke_subagent', 'mcp_michi_ask_user'].map(canonicalKiroToolName),
        ['write', 'edit', 'edit', 'read', 'read', 'bash', 'ls', 'find', 'grep', 'invoke_subagent', 'mcp_michi_ask_user']);
        assert.deepEqual(['fs_read', 'fs_write', 'execute_bash', 'shell', 'Edit', 'MultiEdit', 'Write', 'use_aws'].map(canonicalKiroToolName),
            ['read', 'write', 'bash', 'bash', 'edit', 'edit', 'write', 'use_aws']);
    });

    it("remembers a call by the agent's name, else by Kiro's _meta name", () => {
        const agy = new KiroToolCallNames(undefined, name);
        agy.remember({ toolCallId: 'a', name: 'run_command', _meta: { kiro: { toolName: 'shell' } } });
        assert.equal(agy.get('a'), 'run_command');
        const kiro = new KiroToolCallNames();
        kiro.remember({ toolCallId: 'a', name: 'run_command', _meta: { kiro: { toolName: 'shell' } } });
        kiro.remember({ toolCallId: 'b', name: 'run_command' });
        assert.equal(kiro.get('a'), 'shell');
        assert.equal(kiro.get('b'), undefined);
    });
});

describe('Session state reasoning', () => {
    it('reads the thought_level config option, after Kiro v3 effortLevel', () => {
        const snapshots = new KiroSessionSnapshots('antigravity');
        assert.equal(snapshots.state('s', { configOptions: [MODEL_OPTION, { ...THOUGHT_LEVEL, currentValue: 'high' }] } as any).reasoning, 'high');
        const effort = { id: 'effortLevel', type: 'select', currentValue: 'low' };
        assert.equal(snapshots.state('s', { configOptions: [{ ...THOUGHT_LEVEL, id: 'other' }, effort] } as any).reasoning, 'low');
    });
});
