import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { runCrewAcpServer, type CrewAcpServerOptions } from '../src/agents/crew/acp/acpServer';
import { sanitizeErrorMessage } from '../src/agents/crew/acp/crewFrames';
import { classifyAcpError } from '../src/agents/kiro/acpErrors';
import { CrewMcpBindings } from '../src/agents/crew/crewMcpBinding';
import type {
    CreateSlotInput,
    CrewChatEvent,
    CrewChatFrame,
    CrewGateway,
    CrewModel,
    CrewSlotInfo,
    CrewSlotDetail,
    CrewAgent,
    CrewEvent,
} from '../src/agents/crew/acp/gatewayTypes';

type Call = { method: string; args: unknown[] };
type StreamScript = (slot: string, message: string, signal: AbortSignal, turnId?: string) => AsyncIterable<CrewChatEvent>;

const BANNED = ['timed out', 'response stream', 'connection reset', 'econnreset'];

function frame(type: string, content?: unknown, extra: Partial<CrewChatFrame> = {}): CrewChatEvent {
    return { kind: 'frame', frame: { type, content, ...extra } };
}

function scripted(events: CrewChatEvent[]): StreamScript {
    return async function* () {
        for (const event of events) yield event;
    };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

class FakeGateway implements CrewGateway {
    approvalsAvailable?: CrewGateway['approvalsAvailable'];
    prepareApprovals?: CrewGateway['prepareApprovals'];
    pendingApprovals?: CrewGateway['pendingApprovals'];
    approve?: CrewGateway['approve'];
    getSlot?: (slot: string, limit?: number, before?: number) => Promise<CrewSlotDetail>;
    listSlots?: () => Promise<CrewSlotInfo[]>;
    listAgents?: (slot?: string) => Promise<CrewAgent[]>;
    setAgent?: (slot: string, agent: string) => Promise<void>;
    forkSlot?: (slot: string, messageId: string) => Promise<CrewSlotInfo>;
    watchSlot?: (slot: string, receive: (event: CrewEvent) => void) => Promise<() => void>;
    readonly calls: Call[] = [];
    readonly existing = new Set<string>();
    models: CrewModel[] | Error = [{ modelId: 'claude-test', name: 'Claude Test' }];
    streams: StreamScript[] = [];
    createSlotError?: Error;
    slotExistsError?: Error;
    stopImpl: (slot: string) => Promise<void> = async () => undefined;
    waitUntilIdleImpl: (slot: string, signal: AbortSignal) => Promise<void> = async () => undefined;

    private record(method: string, ...args: unknown[]): void {
        this.calls.push({ method, args });
    }

    callsTo(method: string): unknown[][] {
        return this.calls.filter((c) => c.method === method).map((c) => c.args);
    }

    async createSlot(input: CreateSlotInput): Promise<CrewSlotInfo> {
        this.record('createSlot', input);
        if (this.createSlotError) throw this.createSlotError;
        this.existing.add(input.name);
        return { key: input.name };
    }

    async slotExists(slot: string): Promise<boolean> {
        this.record('slotExists', slot);
        if (this.slotExistsError) throw this.slotExistsError;
        return this.existing.has(slot);
    }

    async setProject(slot: string, project: string): Promise<void> {
        this.record('setProject', slot, project);
    }

    async setModel(slot: string, model: string): Promise<void> {
        this.record('setModel', slot, model);
    }

    async setReasoningEffort(slot: string, effort: string): Promise<void> {
        this.record('setReasoningEffort', slot, effort);
    }

    stop(slot: string): Promise<void> {
        this.record('stop', slot);
        return this.stopImpl(slot);
    }

    waitUntilIdle(slot: string, signal: AbortSignal): Promise<void> {
        this.record('waitUntilIdle', slot, signal);
        return this.waitUntilIdleImpl(slot, signal);
    }

    async deleteSlot(slot: string): Promise<void> {
        this.record('deleteSlot', slot);
    }

    async listModels(): Promise<CrewModel[]> {
        this.record('listModels');
        if (this.models instanceof Error) throw this.models;
        return this.models;
    }

    streamChat(slot: string, message: string, signal: AbortSignal, turnId?: string): AsyncIterable<CrewChatEvent> {
        this.record('streamChat', slot, message);
        const script = this.streams.shift();
        if (!script) throw new Error('no scripted stream left');
        return script(slot, message, signal, turnId);
    }
}

type Msg = Record<string, any>;

function startServer(gateway: CrewGateway, opts: Partial<CrewAcpServerOptions> = {}) {
    const input = new PassThrough();
    const output = new PassThrough();
    const logs: string[] = [];
    const messages: Msg[] = [];
    const badLines: string[] = [];
    let waiters: Array<() => void> = [];
    let seq = 0;
    const server = runCrewAcpServer({
        gateway,
        input,
        output,
        log: (msg) => logs.push(msg),
        newSessionId: () => `michi-${(++seq).toString(16).padStart(12, '0')}`,
        cancelGraceMs: 50,
        ...opts,
    });

    let buffer = '';
    output.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let idx: number;
        while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            try {
                const msg = JSON.parse(line);
                assert.equal(msg.jsonrpc, '2.0');
                messages.push(msg);
            } catch {
                badLines.push(line);
            }
        }
        const pending = waiters;
        waiters = [];
        for (const wake of pending) wake();
    });

    function waitFor(pred: (m: Msg) => boolean, timeoutMs = 2000): Promise<Msg> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('waitFor: no matching message')), timeoutMs);
            const check = (): void => {
                const hit = messages.find(pred);
                if (hit) {
                    clearTimeout(timer);
                    resolve(hit);
                } else {
                    waiters.push(check);
                }
            };
            check();
        });
    }

    let nextId = 0;
    function request(method: string, params?: unknown): Promise<Msg> {
        const id = nextId++;
        input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        return waitFor((m) => m.id === id && !('method' in m));
    }

    function notify(method: string, params?: unknown): void {
        input.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    }

    function updates(sessionId: string): Msg[] {
        return messages
            .filter((m) => m.method === 'session/update' && m.params?.sessionId === sessionId)
            .map((m) => m.params.update);
    }

    async function newSession(cwd = '/work/project', mcpServers: unknown[] = []): Promise<string> {
        const reply = await request('session/new', { cwd, mcpServers });
        assert.ok(reply.result, `session/new failed: ${JSON.stringify(reply.error)}`);
        return reply.result.sessionId;
    }

    function prompt(sessionId: string, text: string): Promise<Msg> {
        return request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
    }

    async function close(): Promise<void> {
        input.end();
        await server.closed;
        assert.deepEqual(badLines, [], 'output must carry only JSON-RPC lines');
    }

    return { input, logs, messages, waitFor, request, notify, updates, newSession, prompt, close, shutdown: server.shutdown };
}

describe('Crew ACP server: core turn', () => {
    test('initialize, new, prompt streams chunks, thinking and tools, and creates the slot lazily', async () => {
        const gw = new FakeGateway();
        gw.streams.push(
            scripted([
                frame('user', 'look'),
                frame('chunk', 'Hello '),
                frame('chunk', 'pondering', { cls: 'msg thinking' }),
                frame('tool', 'Read file src/a.ts\nline two'),
                frame('chunk', 'world'),
                frame('assistant', 'Hello world'),
                frame('system', 'internal'),
                frame('done'),
            ]),
        );
        const s = startServer(gw, { agent: 'crew-agent' });

        const init = await s.request('initialize', {
            protocolVersion: 1,
            clientInfo: { name: 'michi', version: '1.0.0' },
            clientCapabilities: {},
        });
        assert.deepEqual(init.result, {
            protocolVersion: 1,
            agentCapabilities: {
                loadSession: true,
                promptCapabilities: { image: false, audio: false, embeddedContext: false },
            },
            agentInfo: { name: 'kirocrew-acp', version: '0.3.0' },
            authMethods: [],
        });

        const created = await s.request('session/new', { cwd: '/work/project', mcpServers: [] });
        const sessionId = created.result.sessionId;
        assert.match(sessionId, /^michi-[0-9a-f]{12}$/);
        assert.deepEqual(created.result.models, {
            currentModelId: 'default',
            availableModels: [
                { modelId: 'default', name: 'Crew default' },
                { modelId: 'claude-test', name: 'Claude Test' },
            ],
        });
        assert.deepEqual(gw.callsTo('createSlot'), [], 'session/new must not create a slot');

        const reply = await s.request('session/prompt', {
            sessionId,
            prompt: [
                { type: 'text', text: 'look' },
                { type: 'image', mimeType: 'image/png', data: 'AAAA' },
            ],
        });
        assert.deepEqual(reply.result, { stopReason: 'end_turn' });

        assert.deepEqual(gw.callsTo('createSlot'), [[{ name: sessionId, agent: 'crew-agent', memory_mode: 'persistent' }]]);
        assert.deepEqual(gw.callsTo('setProject'), [[sessionId, '/work/project']]);
        assert.deepEqual(gw.callsTo('setReasoningEffort'), []);
        assert.deepEqual(gw.callsTo('streamChat'), [[sessionId, 'look\n[image attachment omitted]']]);
        const order = gw.calls.map((c) => c.method).filter((m) => m !== 'listModels');
        assert.deepEqual(order, ['createSlot', 'setProject', 'streamChat']);

        assert.deepEqual(s.updates(sessionId), [
            { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } },
            { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'pondering' } },
            {
                sessionUpdate: 'tool_call',
                toolCallId: 'crew-row-2',
                title: 'Read file src/a.ts',
                kind: 'other',
                status: 'in_progress',
                rawOutput: 'Read file src/a.ts\nline two',
            },
            { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } },
            { sessionUpdate: 'tool_call_update', toolCallId: 'crew-row-2', title: 'Read file src/a.ts', kind: 'other', status: 'completed', rawOutput: 'Read file src/a.ts\nline two' },
        ]);

        gw.streams.push(scripted([frame('chunk', 'again')]));
        const second = await s.prompt(sessionId, 'more');
        assert.deepEqual(second.result, { stopReason: 'end_turn' });
        assert.equal(gw.callsTo('createSlot').length, 1, 'the slot is created once');
        assert.equal(gw.callsTo('listModels').length, 1, 'models are fetched once');
        assert.equal(
            s.messages.some((m) => m.method === 'session/request_permission'),
            false,
        );
        await s.close();
    });
});

describe('Crew ACP server: sessions', () => {
    test('session/new retains MCP configuration without eagerly creating a slot', async () => {
        const gw = new FakeGateway();
        const s = startServer(gw);
        const michiMcp = [{ name: 'michi', type: 'http', url: 'http://127.0.0.1:1/api/mcp/x', headers: [] }];
        const a = await s.newSession('/work/a', michiMcp);
        const b = await s.newSession('/work/b', michiMcp);
        assert.notEqual(a, b);
        assert.deepEqual(gw.callsTo('createSlot'), []);
        assert.deepEqual(gw.callsTo('setProject'), []);
        assert.equal(s.logs.filter((l) => l.includes('MCP servers')).length, 0);
        await s.close();
    });

    test('session/new requires a cwd', async () => {
        const s = startServer(new FakeGateway());
        const reply = await s.request('session/new', { mcpServers: [] });
        assert.equal(reply.error.code, -32602);
        await s.close();
    });

    test('session/load of an existing slot prompts without creating it', async () => {
        const gw = new FakeGateway();
        gw.existing.add('michi-aaaaaaaaaaaa');
        gw.streams.push(scripted([frame('chunk', 'resumed')]));
        const s = startServer(gw);
        const loaded = await s.request('session/load', { sessionId: 'michi-aaaaaaaaaaaa', cwd: '/work', mcpServers: [] });
        assert.equal(loaded.result.models.currentModelId, 'default');
        assert.equal(loaded.result.models.availableModels[0].modelId, 'default');
        const reply = await s.prompt('michi-aaaaaaaaaaaa', 'hi');
        assert.deepEqual(reply.result, { stopReason: 'end_turn' });
        assert.deepEqual(gw.callsTo('createSlot'), []);
        assert.deepEqual(gw.callsTo('setProject'), []);
        await s.close();
    });

    test('session/load of a missing slot refuses without recreating lost history', async () => {
        const gw = new FakeGateway();
        gw.streams.push(scripted([frame('chunk', 'fresh')]));
        const s = startServer(gw);
        const loaded = await s.request('session/load', { sessionId: 'michi-bbbbbbbbbbbb', cwd: '/work', mcpServers: [] });
        assert.equal(loaded.error.code, -32602);
        assert.deepEqual(loaded.error.data, { code: 'crew_session_unavailable' });
        assert.equal((await s.prompt('michi-bbbbbbbbbbbb', 'hi')).error.code, -32602);
        assert.deepEqual(gw.callsTo('createSlot'), []);
        await s.close();
    });

    test('session/load preserves an existence-check error without creating a slot', async () => {
        const gw = new FakeGateway();
        gw.slotExistsError = new Error('gateway down');
        gw.streams.push(scripted([]));
        const s = startServer(gw);
        const loaded = await s.request('session/load', { sessionId: 'michi-cccccccccccc', cwd: '/work', mcpServers: [] });
        assert.match(loaded.error.message, /gateway down/);
        assert.equal((await s.prompt('michi-cccccccccccc', 'hi')).error.code, -32602);
        assert.equal(gw.callsTo('createSlot').length, 0);
        await s.close();
    });

    test('a failed model listing logs once and advertises only the Crew default', async () => {
        const gw = new FakeGateway();
        gw.models = new Error('models unavailable');
        const s = startServer(gw);
        const first = await s.request('session/new', { cwd: '/w', mcpServers: [] });
        await s.request('session/new', { cwd: '/w', mcpServers: [] });
        assert.deepEqual(first.result.models.availableModels, [{ modelId: 'default', name: 'Crew default' }]);
        assert.equal(gw.callsTo('listModels').length, 1);
        assert.equal(s.logs.filter((l) => l.includes('models unavailable')).length, 1);
        await s.close();
    });

    test('a failed model listing is retried after the cooldown', async () => {
        const gw = new FakeGateway();
        gw.models = new Error('gateway restarting');
        const s = startServer(gw, { modelRetryMs: 0 });
        const first = await s.request('session/new', { cwd: '/w', mcpServers: [] });
        assert.deepEqual(first.result.models.availableModels, [{ modelId: 'default', name: 'Crew default' }]);
        gw.models = [{ modelId: 'claude-x', name: 'Claude X' }];
        const second = await s.request('session/new', { cwd: '/w', mcpServers: [] });
        assert.deepEqual(second.result.models.availableModels.map((m: Msg) => m.modelId), ['default', 'claude-x']);
        await s.request('session/new', { cwd: '/w', mcpServers: [] });
        assert.equal(gw.callsTo('listModels').length, 2, 'a successful list is cached');
        await s.close();
    });

    test('closed resolves when input ends', async () => {
        const s = startServer(new FakeGateway());
        await s.close();
    });
});

describe('Crew ACP server: cancel', () => {
    test('cancel answers cancelled within the grace even when stop never resolves', async () => {
        const gw = new FakeGateway();
        const firstChunkSent = deferred();
        gw.streams.push(async function* () {
            yield frame('chunk', 'working');
            firstChunkSent.resolve();
            await new Promise(() => undefined); // ignores the abort signal on purpose
        });
        gw.stopImpl = () => new Promise(() => undefined);
        const s = startServer(gw, { cancelGraceMs: 80 });
        const sessionId = await s.newSession();
        const pending = s.prompt(sessionId, 'long task');
        await firstChunkSent.promise;
        await s.waitFor((m) => m.method === 'session/update');

        const started = Date.now();
        s.notify('session/cancel', { sessionId });
        const reply = await pending;
        const elapsed = Date.now() - started;
        assert.deepEqual(reply.result, { stopReason: 'cancelled' });
        assert.ok(elapsed < 1000, `cancel took ${elapsed} ms`);
        assert.deepEqual(gw.callsTo('stop'), [[sessionId]]);

        gw.streams.push(scripted([frame('chunk', 'next')]));
        const next = await s.prompt(sessionId, 'next task');
        assert.deepEqual(next.result, { stopReason: 'end_turn' }, 'the session is not busy after cancel');
        await s.close();
    });

    test('cancel answers as soon as stop resolves when the stream honors the abort', async () => {
        const gw = new FakeGateway();
        const streaming = deferred();
        gw.streams.push(async function* (_slot, _message, signal) {
            streaming.resolve();
            await new Promise<void>((res) => signal.addEventListener('abort', () => res()));
        });
        const s = startServer(gw, { cancelGraceMs: 5000 });
        const sessionId = await s.newSession();
        const pending = s.prompt(sessionId, 'task');
        await streaming.promise;
        const started = Date.now();
        s.notify('session/cancel', { sessionId });
        const reply = await pending;
        assert.deepEqual(reply.result, { stopReason: 'cancelled' });
        assert.ok(Date.now() - started < 1000);
        await s.close();
    });

    test('cancel keeps the session busy until the Gateway reports the slot idle', async () => {
        const gw = new FakeGateway();
        const streaming = deferred();
        const idle = deferred();
        gw.streams.push(async function* (_slot, _message, signal) {
            streaming.resolve();
            await new Promise<void>((res) => signal.addEventListener('abort', () => res()));
        });
        gw.waitUntilIdleImpl = async () => idle.promise;
        const s = startServer(gw, { cancelGraceMs: 1000 });
        const sessionId = await s.newSession();
        const pending = s.prompt(sessionId, 'task');
        await streaming.promise;

        s.notify('session/cancel', { sessionId });
        let cancelSettled = false;
        void pending.then(() => { cancelSettled = true; });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(cancelSettled, false, 'the ACP prompt must stay open while the Gateway slot is still running');

        const early = await s.prompt(sessionId, 'too early');
        assert.equal(early.error?.code, -32000, 'a follow-up is rejected until the cancelled slot is idle');
        idle.resolve();
        assert.deepEqual((await pending).result, { stopReason: 'cancelled' });
        assert.deepEqual(gw.callsTo('waitUntilIdle').map(([slot]) => [slot]), [[sessionId]]);

        gw.streams.push(scripted([frame('chunk', 'ready')]));
        assert.deepEqual((await s.prompt(sessionId, 'after idle')).result, { stopReason: 'end_turn' });
        await s.close();
    });

    test('cancel with no active prompt is a no-op', async () => {
        const gw = new FakeGateway();
        const s = startServer(gw);
        const sessionId = await s.newSession();
        const before = s.messages.length;
        s.notify('session/cancel', { sessionId });
        s.notify('session/cancel', { sessionId: 'michi-unknown00000' });
        const ping = await s.request('_session/steer', { sessionId, message: 'x' });
        assert.deepEqual(ping.result, { queued: false });
        assert.equal(s.messages.length, before + 1, 'cancel wrote nothing');
        assert.deepEqual(gw.callsTo('stop'), []);
        await s.close();
    });
});

describe('Crew ACP server: frames', () => {
    async function runFrames(events: CrewChatEvent[]): Promise<Msg[]> {
        const gw = new FakeGateway();
        gw.streams.push(scripted(events));
        const s = startServer(gw);
        const sessionId = await s.newSession();
        const reply = await s.prompt(sessionId, 'go');
        assert.deepEqual(reply.result, { stopReason: 'end_turn' });
        assert.equal(s.messages.some((m) => m.method === 'session/request_permission'), false);
        await s.close();
        return s.updates(sessionId);
    }

    const textOf = (u: Msg): string => u.content.text;

    test('a busy-slot receipt becomes a queued notice', async () => {
        const updates = await runFrames([{ kind: 'receipt', receipt: { ok: true, queued: true, queue_id: 'q1' } }]);
        assert.equal(updates.length, 1);
        assert.equal(updates[0].sessionUpdate, 'agent_message_chunk');
        assert.match(textOf(updates[0]), /still running an earlier message/);
        assert.match(textOf(updates[0]), /queued/);
        assert.match(textOf(updates[0]), /Kiro Crew dashboard/);
    });

    test('a permission frame becomes a dashboard notice naming the tool', async () => {
        const updates = await runFrames([
            frame('permission', 'ignored body', { meta: { tool_title: 'Run shell: rm build', request_id: 'r1' } }),
            frame('permission', 'Write file a.txt\nmore detail'),
        ]);
        assert.equal(updates.length, 2);
        for (const u of updates) {
            assert.equal(u.sessionUpdate, 'agent_message_chunk');
            assert.match(textOf(u), /Kiro Crew dashboard/);
            assert.match(textOf(u), /about 3 minutes/);
        }
        assert.match(textOf(updates[0]), /Run shell: rm build/);
        assert.match(textOf(updates[1]), /Write file a\.txt/);
        assert.doesNotMatch(textOf(updates[1]), /more detail/);
    });

    test('an error frame becomes a Crew error chunk', async () => {
        const updates = await runFrames([frame('error', 'model refused')]);
        assert.deepEqual(updates, [
            { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n\n**Crew error:** model refused\n' } },
        ]);
    });

    test('compacting, notice and non-string content map as specified', async () => {
        const long = `${'x'.repeat(200)}\n${'y'.repeat(20_000)}`;
        const updates = await runFrames([
            frame('compacting', ''),
            frame('notice', 'Context trimmed'),
            frame('chunk', { rich: true }),
            frame('tool', ''),
            frame('tool', long),
            frame('mystery', 'x'),
        ]);
        assert.deepEqual(updates[0], {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'Compacting conversation…' },
        });
        assert.deepEqual(updates[1], { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Context trimmed' } });
        assert.deepEqual(updates[2], { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"rich":true}' } });
        assert.equal(updates[3].title, 'Tool');
        assert.equal(updates[4].title.length, 120);
        assert.equal(updates[4].rawOutput.length, 16_000);
        assert.notEqual(updates[3].toolCallId, updates[4].toolCallId);
        assert.equal(updates.length, 7);
    });
});

describe('Crew ACP server: errors', () => {
    test('a stream that throws answers -32603 without connection-class words', async () => {
        const gw = new FakeGateway();
        gw.streams.push(async function* () {
            yield frame('chunk', 'partial');
            throw new Error('request timed out: ECONNRESET in the Response Stream after connection reset');
        });
        const s = startServer(gw);
        const sessionId = await s.newSession();
        const reply = await s.prompt(sessionId, 'go');
        assert.equal(reply.error.code, -32603);
        assert.ok(reply.error.message.startsWith('Crew: '), reply.error.message);
        const lower = reply.error.message.toLowerCase();
        for (const word of BANNED) assert.ok(!lower.includes(word), `error contains "${word}": ${reply.error.message}`);
        assert.equal('data' in reply.error, false);

        gw.streams.push(scripted([]));
        const next = await s.prompt(sessionId, 'again');
        assert.deepEqual(next.result, { stopReason: 'end_turn' }, 'a failed turn releases the session');
        await s.close();
    });

    test('a createSlot failure is an RPC error and leaves the session usable', async () => {
        const gw = new FakeGateway();
        gw.createSlotError = new Error('slot limit reached');
        const s = startServer(gw);
        const sessionId = await s.newSession();
        const reply = await s.prompt(sessionId, 'go');
        assert.ok(reply.error);
        assert.match(reply.error.message, /slot limit reached/);
        assert.deepEqual(gw.callsTo('streamChat'), []);

        gw.createSlotError = undefined;
        gw.streams.push(scripted([]));
        const retry = await s.prompt(sessionId, 'go');
        assert.deepEqual(retry.result, { stopReason: 'end_turn' });
        assert.equal(gw.callsTo('createSlot').length, 2);
        await s.close();
    });

    test('a second prompt on an active session is busy', async () => {
        const gw = new FakeGateway();
        const gate = deferred();
        const streaming = deferred();
        gw.streams.push(async function* () {
            streaming.resolve();
            await gate.promise;
            yield frame('chunk', 'done');
        });
        const s = startServer(gw);
        const sessionId = await s.newSession();
        const first = s.prompt(sessionId, 'one');
        await streaming.promise;
        const second = await s.prompt(sessionId, 'two');
        assert.deepEqual(second.error, { code: -32000, message: 'Crew session is busy' });
        gate.resolve();
        assert.deepEqual((await first).result, { stopReason: 'end_turn' });
        await s.close();
    });

    test('a prompt for an unknown session is invalid params', async () => {
        const s = startServer(new FakeGateway());
        const reply = await s.prompt('michi-000000000999', 'hi');
        assert.equal(reply.error.code, -32602);
        await s.close();
    });
});

describe('Crew ACP server: settings and Kiro commands', () => {
    test('set_model before the slot is stored; after the slot it applies changes including reset to default', async () => {
        const gw = new FakeGateway();
        gw.streams.push(scripted([]));
        const s = startServer(gw);
        const sessionId = await s.newSession();
        assert.deepEqual((await s.request('session/set_model', { sessionId, modelId: 'claude-test' })).result, {});
        assert.deepEqual(gw.callsTo('setModel'), []);
        await s.prompt(sessionId, 'go');
        assert.deepEqual(gw.callsTo('createSlot'), [[{ name: sessionId, model: 'claude-test', memory_mode: 'persistent' }]]);

        assert.deepEqual((await s.request('session/set_model', { sessionId, modelId: 'claude-next' })).result, {});
        assert.deepEqual((await s.request('session/set_model', { sessionId, modelId: 'default' })).result, {});
        assert.deepEqual(gw.callsTo('setModel'), [[sessionId, 'claude-next'], [sessionId, '']]);
        assert.equal((await s.request('session/set_model', { sessionId: 'nope', modelId: 'x' })).error.code, -32602);
        await s.close();
    });

    test('defaultModel sets the advertised current model and the slot model', async () => {
        const gw = new FakeGateway();
        gw.streams.push(scripted([]));
        const s = startServer(gw, { defaultModel: 'claude-test' });
        const created = await s.request('session/new', { cwd: '/w', mcpServers: [] });
        assert.equal(created.result.models.currentModelId, 'claude-test');
        await s.prompt(created.result.sessionId, 'go');
        assert.deepEqual(gw.callsTo('createSlot'), [[{ name: created.result.sessionId, model: 'claude-test', memory_mode: 'persistent' }]]);
        await s.close();
    });

    test('a failed setModel reports an error and retains the old model', async () => {
        const gw = new FakeGateway();
        gw.setModel = async () => {
            throw new Error('model rejected');
        };
        gw.existing.add('michi-dddddddddddd');
        const s = startServer(gw);
        await s.request('session/load', { sessionId: 'michi-dddddddddddd', cwd: '/w', mcpServers: [] });
        const reply = await s.request('session/set_model', { sessionId: 'michi-dddddddddddd', modelId: 'claude-test' });
        assert.match(reply.error.message, /model rejected/);
        const loaded = await s.request('session/load', { sessionId: 'michi-dddddddddddd' });
        assert.equal(loaded.result.models.currentModelId, 'default');
        await s.close();
    });

    test('effort is stored, applied on slot creation and after; other commands are unsupported', async () => {
        const gw = new FakeGateway();
        gw.streams.push(scripted([]));
        const s = startServer(gw);
        const sessionId = await s.newSession();
        const exec = (command: string, args: unknown = {}) =>
            s.request('_kiro.dev/commands/execute', { sessionId, command: { command, args } });

        assert.deepEqual((await exec('effort', { value: 'high' })).result, { success: true });
        assert.deepEqual(gw.callsTo('setReasoningEffort'), []);
        await s.prompt(sessionId, 'go');
        assert.deepEqual(gw.callsTo('setReasoningEffort'), [[sessionId, 'high']]);
        const order = gw.calls.map((c) => c.method).filter((m) => m !== 'listModels');
        assert.deepEqual(order.slice(0, 4), ['createSlot', 'setProject', 'setReasoningEffort', 'streamChat']);

        assert.deepEqual((await exec('effort', { value: 'low' })).result, { success: true });
        assert.deepEqual(gw.callsTo('setReasoningEffort')[1], [sessionId, 'low']);

        assert.deepEqual((await exec('compact', { instructions: 'short' })).result, {
            success: false,
            message: 'compact is not supported by Kiro Crew',
        });
        assert.deepEqual((await exec('rewind')).result, { success: false, message: 'rewind is not supported by Kiro Crew' });
        assert.equal((await exec('anything')).result.success, false);
        await s.close();
    });

    test('steer and steer/clear answer gracefully', async () => {
        const s = startServer(new FakeGateway());
        const sessionId = await s.newSession();
        assert.deepEqual((await s.request('_session/steer', { sessionId, message: 'faster' })).result, { queued: false });
        assert.deepEqual((await s.request('_session/steer/clear', { sessionId })).result, {
            cleared: true,
            messageIds: [],
        });
        await s.close();
    });
});

describe('Crew ACP server: transport', () => {
    test('unknown methods get -32601; unknown notifications and responses are ignored', async () => {
        const s = startServer(new FakeGateway());
        for (const method of ['authenticate', '_kiro/session/list']) {
            const reply = await s.request(method, {});
            assert.equal(reply.error.code, -32601, method);
        }
        const before = s.messages.length;
        s.notify('_kiro.dev/whatever', {});
        s.input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 77, result: {} })}\n`);
        await s.request('_session/steer/clear', {});
        assert.equal(s.messages.length, before + 1);
        await s.close();
    });

    test('blank and garbage input lines are ignored and logged', async () => {
        const s = startServer(new FakeGateway());
        s.input.write('\n   \nnot json at all\n[1,2]\n{"broken":\n');
        const reply = await s.request('initialize', { protocolVersion: 1 });
        assert.equal(reply.result.protocolVersion, 1);
        assert.equal(s.messages.length, 1, 'garbage produced no output');
        assert.ok(s.logs.length >= 2);
        await s.close();
    });

    test('a request split across chunks and multi-byte text decode correctly', async () => {
        const gw = new FakeGateway();
        gw.streams.push(scripted([]));
        const s = startServer(gw);
        const sessionId = await s.newSession();
        const line = Buffer.from(
            `${JSON.stringify({ jsonrpc: '2.0', id: 'p1', method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: '你好' }] } })}\n`,
        );
        const cut = line.indexOf(Buffer.from('你')) + 1;
        s.input.write(line.subarray(0, cut));
        s.input.write(line.subarray(cut));
        const reply = await s.waitFor((m) => m.id === 'p1');
        assert.deepEqual(reply.result, { stopReason: 'end_turn' });
        assert.deepEqual(gw.callsTo('streamChat'), [[sessionId, '你好']]);
        await s.close();
    });
});

describe('Crew ACP server: shutdown', () => {
    test('input ending stops the owned native turn before releasing the adapter', async () => {
        const gw = new FakeGateway();
        const aborted = deferred();
        const streaming = deferred();
        gw.streams.push(async function* (_slot, _message, signal) {
            signal.addEventListener('abort', () => aborted.resolve());
            streaming.resolve();
            await aborted.promise;
        });
        const s = startServer(gw);
        const sessionId = await s.newSession();
        void s.prompt(sessionId, 'long').catch(() => undefined);
        await streaming.promise;
        await s.close();
        await aborted.promise;
        assert.deepEqual(gw.callsTo('stop'), [[sessionId]]);
        assert.equal(gw.callsTo('waitUntilIdle').length, 1);
    });

    test('explicit shutdown waits for active cleanup, stays idempotent and leaves idle slots alone', async () => {
        const gw = new FakeGateway();
        const streaming = deferred(), aborted = deferred(), stopped = deferred(), releaseStop = deferred();
        gw.streams.push(async function* (_slot, _message, signal) {
            signal.addEventListener('abort', () => aborted.resolve());
            streaming.resolve();
            await aborted.promise;
        });
        gw.stopImpl = async () => { stopped.resolve(); await releaseStop.promise; };
        const s = startServer(gw, { cancelGraceMs: 1000 });
        const active = await s.newSession();
        await s.newSession();
        const prompt = s.prompt(active, 'long');
        await streaming.promise;
        let closed = false;
        const first = s.shutdown().then(() => { closed = true; });
        const second = s.shutdown();
        await stopped.promise;
        assert.equal(closed, false);
        assert.deepEqual(gw.callsTo('stop'), [[active]]);
        releaseStop.resolve();
        await Promise.all([first, second]);
        assert.equal((await prompt).result.stopReason, 'cancelled');
        await s.close();
    });

    test('a surviving native turn refuses retry without changing approvals, sending or queueing', async () => {
        const gw = new FakeGateway();
        gw.getSlot = async slot => ({ key: slot, running: true, messages: [] });
        gw.prepareApprovals = async () => { throw new Error('must not change the previous turn'); };
        const s = startServer(gw);
        const sessionId = await s.newSession();
        const reply = await s.prompt(sessionId, 'retry');
        assert.match(reply.error.message, /Finish or stop it in Kiro Crew/);
        assert.deepEqual(gw.callsTo('streamChat'), []);
        assert.deepEqual(gw.callsTo('stop'), []);
        await s.close();
    });

    test('shutdown during preflight does not stop a task this adapter never submitted', async () => {
        const gw = new FakeGateway();
        const checking = deferred(), release = deferred();
        gw.getSlot = async slot => { checking.resolve(); await release.promise; return { key: slot, running: true, messages: [] }; };
        const s = startServer(gw);
        const sessionId = await s.newSession();
        const prompt = s.prompt(sessionId, 'retry');
        await checking.promise;
        await s.shutdown();
        assert.equal((await prompt).result.stopReason, 'cancelled');
        assert.deepEqual(gw.callsTo('stop'), []);
        release.resolve();
        await s.close();
    });
});

describe('Crew ACP server: error text', () => {
    test('sanitized messages never classify as connection errors in Michi', () => {
        const samples = [
            'Dispatch failure', 'DispatchFailure', 'Encountered an error in the response stream', 'request timed out',
            'The request has timed out', 'TimeoutError', 'ProviderTimedOut', 'StalledStream', 'connection reset by peer',
            'host unreachable', 'ResponseError', 'read ECONNRESET',
        ];
        for (const sample of samples) {
            const message = sanitizeErrorMessage(`Crew: ${sample}`);
            assert.notEqual(classifyAcpError(new Error(message)), 'connection', `${sample} -> ${message}`);
            for (const word of BANNED) assert.ok(!message.toLowerCase().includes(word), message);
        }
        assert.equal(classifyAcpError(new Error(sanitizeErrorMessage('Crew: throttled'))), 'transient');
    });
});

describe('Crew ACP server: Gateway capabilities', () => {
    test('new chats prefer the installed Michi template and explicit choices keep precedence', async () => {
        const gw = new FakeGateway();
        gw.listAgents = async () => [
            { id: 'michi-crew', name: 'Michi' }, { id: 'reviewer', name: 'Reviewer' },
        ];
        gw.setAgent = async () => {};
        gw.streams.push(scripted([]), scripted([]));
        const s = startServer(gw);
        const info = await s.request('session/new', { cwd: '/w' });
        const sessionId = info.result.sessionId;
        assert.equal(info.result.modes.currentModeId, 'template:michi-crew');
        await s.prompt(sessionId, 'hello');
        assert.deepEqual(gw.callsTo('createSlot')[0], [{ name: sessionId,
            agent: 'michi-crew', agent_kind: 'template', memory_mode: 'persistent' }]);
        const custom = await s.newSession();
        assert.deepEqual((await s.request('session/set_mode', { sessionId: custom, modeId: 'template:reviewer' })).result, {});
        await s.prompt(custom, 'review');
        assert.equal((gw.callsTo('createSlot')[1][0] as CreateSlotInput).agent, 'reviewer');
        await s.close();
        const explicit = startServer(gw, { agent: 'reviewer' });
        assert.equal((await explicit.request('session/new', { cwd: '/w' })).result.modes.currentModeId, 'template:reviewer');
        await explicit.close();
    });
    test('a pending load blocks a second load and never replaces an active session', async () => {
        const gw = new FakeGateway();
        gw.existing.add('parent');
        const loading = deferred(), release = deferred();
        gw.listSlots = async () => { loading.resolve(); await release.promise; return [{ key: 'parent' }]; };
        const s = startServer(gw);
        const pending = s.request('session/load', { sessionId: 'parent' });
        await loading.promise;
        assert.equal((await s.request('session/load', { sessionId: 'parent' })).error.code, -32000);
        assert.equal((await s.prompt('parent', 'early')).error.code, -32000);
        release.resolve();
        assert.ok((await pending).result);
        await s.close();
    });

    test('cancel during slot creation shares setup with the next prompt', async () => {
        const gw = new FakeGateway();
        const creating = deferred(), release = deferred();
        let creates = 0;
        gw.createSlot = async (input) => { creates++; creating.resolve(); await release.promise; return { key: input.name }; };
        const s = startServer(gw);
        const sessionId = await s.newSession();
        const first = s.prompt(sessionId, 'cancel me');
        await creating.promise;
        s.notify('session/cancel', { sessionId });
        assert.equal((await first).result.stopReason, 'cancelled');
        gw.streams.push(scripted([frame('chunk', 'second only')]));
        const second = s.prompt(sessionId, 'next');
        release.resolve();
        assert.equal((await second).result.stopReason, 'end_turn');
        assert.equal(creates, 1);
        assert.deepEqual(gw.callsTo('streamChat'), [[sessionId, 'next']]);
        await s.close();
    });
    test('new-session memory configuration never changes a resumed or forked identity', async () => {
        const gw = new FakeGateway();
        gw.streams.push(scripted([]), scripted([]), scripted([]));
        gw.existing.add('existing');
        gw.listSlots = async () => [{ key: 'existing', memory_mode: 'incognito', agent: 'bound-member', agent_kind: 'member' }];
        gw.getSlot = async () => ({ key: 'existing', messages: [{ role: 'assistant', type: 'assistant', meta: { mid: 'm1' } }] });
        gw.forkSlot = async () => ({ key: 'child', memory_mode: 'incognito' });
        const s = startServer(gw, { memoryMode: 'temporary' });
        const fresh = await s.newSession();
        await s.prompt(fresh, 'new');
        await s.request('session/load', { sessionId: 'existing', cwd: '/w' });
        await s.prompt('existing', 'resume');
        assert.equal((await s.request('session/fork', { sessionId: 'existing' })).result.sessionId, 'child');
        await s.prompt('child', 'fork');
        assert.deepEqual(gw.callsTo('createSlot'), [[{ name: fresh, memory_mode: 'temporary' }]]);
        assert.equal(gw.callsTo('setProject').length, 1, 'only a fresh slot receives birth settings');
        await s.close();
    });

    test('template choice uses its namespace, survives load and changes only after acceptance', async () => {
        const gw = new FakeGateway();
        gw.listAgents = async () => [{ id: 'code', name: 'Code' }];
        let refused = false;
        const changes: string[] = [];
        gw.setAgent = async (_slot, agent) => { changes.push(agent); if (refused) throw new Error('member is pinned'); };
        gw.streams.push(scripted([]));
        const s = startServer(gw);
        const sessionId = await s.newSession();
        const info = await s.request('session/new', { cwd: '/w' });
        assert.deepEqual(info.result.modes.availableModes.map((m: any) => m.id), ['template:code'], 'current identity is not a reset command in the cached picker');
        assert.deepEqual((await s.request('session/set_mode', { sessionId, modeId: 'template:code' })).result, {});
        assert.equal(changes.length, 0, 'lazy session has no Gateway slot yet');
        await s.prompt(sessionId, 'go');
        assert.deepEqual(gw.callsTo('createSlot'), [[{ name: sessionId, agent: 'code', agent_kind: 'template', memory_mode: 'persistent' }]]);
        gw.listSlots = async () => [{ key: sessionId, model: 'claude-test', reasoning_effort: 'high', agent: 'code', agent_kind: 'template' }];
        const loaded = await s.request('session/load', { sessionId });
        assert.equal(loaded.result.models.currentModelId, 'claude-test');
        assert.equal(loaded.result.modes.currentModeId, 'template:code');
        assert.equal(loaded.result.modes.availableModes[0].name, 'Template: Code');
        refused = true;
        const count = s.updates(sessionId).length;
        assert.match((await s.request('session/set_mode', { sessionId, modeId: 'template:code' })).error.message, /member is pinned/);
        assert.equal(s.updates(sessionId).length, count, 'a rejected switch emits no mode update');
        assert.equal((await s.request('session/set_mode', { sessionId, modeId: 'member:private' })).error.code, -32602);
        await s.close();
    });

    test('settings and prompts serialize while a Gateway setting is in flight', async () => {
        const gw = new FakeGateway();
        gw.existing.add('parent');
        const changing = deferred(), release = deferred();
        gw.setModel = async () => { changing.resolve(); await release.promise; };
        const s = startServer(gw);
        await s.request('session/load', { sessionId: 'parent', cwd: '/w' });
        const pending = s.request('session/set_model', { sessionId: 'parent', modelId: 'model' });
        await changing.promise;
        assert.equal((await s.prompt('parent', 'too soon')).error.code, -32000);
        assert.equal((await s.request('session/load', { sessionId: 'parent' })).error.code, -32000);
        assert.equal((await s.request('_kiro.dev/commands/execute', { sessionId: 'parent', command: { command: 'effort', args: { value: 'high' } } })).error.code, -32000);
        release.resolve();
        assert.deepEqual((await pending).result, {});
        await s.close();
    });

    test('failed settings hydration never registers a usable session', async () => {
        const gw = new FakeGateway();
        gw.existing.add('parent');
        gw.listSlots = async () => { throw new Error('offline'); };
        const s = startServer(gw);
        assert.match((await s.request('session/load', { sessionId: 'parent' })).error.message, /offline/);
        assert.equal((await s.prompt('parent', 'go')).error.code, -32602);
        assert.equal(gw.callsTo('createSlot').length, 0);
        await s.close();
    });

    test('partially created slot retries configuration without duplicating the slot', async () => {
        const gw = new FakeGateway();
        let failed = true;
        gw.setProject = async () => { if (failed) throw new Error('project unavailable'); };
        const s = startServer(gw);
        const sessionId = await s.newSession();
        assert.match((await s.prompt(sessionId, 'go')).error.message, /project unavailable/);
        await s.request('session/set_model', { sessionId, modelId: 'updated' });
        assert.deepEqual(gw.callsTo('setModel'), [[sessionId, 'updated']]);
        failed = false;
        gw.streams.push(scripted([]));
        assert.deepEqual((await s.prompt(sessionId, 'go')).result, { stopReason: 'end_turn' });
        assert.equal(gw.callsTo('createSlot').length, 1);
        await s.close();
    });

    test('fork uses stable assistant message ids and keeps both parent and child usable', async () => {
        const gw = new FakeGateway();
        gw.existing.add('parent');
        gw.getSlot = async () => ({ key: 'parent', total: 601, next_before: 599, messages: [
            { role: 'assistant', type: 'assistant', meta: { mid: 'old-stable-id' } },
            { role: 'assistant', type: 'assistant', meta: { mid: 'new-stable-id' } },
        ] });
        const forks: string[][] = [];
        gw.forkSlot = async (slot, mid) => { forks.push([slot, mid]); return { key: 'child' }; };
        const s = startServer(gw);
        assert.deepEqual((await s.request('initialize')).result.agentCapabilities.sessionCapabilities, { fork: {} });
        await s.request('session/load', { sessionId: 'parent', cwd: '/w' });
        const catalog = await s.request('_kiro.dev/commands/execute', { sessionId: 'parent', command: { command: 'rewind' } });
        assert.equal(catalog.result.data.turns[0].messageId, 'new-stable-id');
        assert.equal(catalog.result.data.turns[0].logIndex, 600);
        const child = await s.request('session/fork', { sessionId: 'parent', _meta: { kiro: { messageId: 'old-stable-id' } } });
        assert.deepEqual(child.result, { sessionId: 'child' });
        assert.deepEqual(forks, [['parent', 'old-stable-id']]);
        gw.streams.push(scripted([]), scripted([]));
        assert.ok((await s.prompt('child', 'continue child')).result);
        assert.ok((await s.prompt('parent', 'continue parent')).result);
        assert.equal(gw.callsTo('createSlot').length, 0);
        await s.close();
    });

    test('fork refuses empty/running parents and propagates Gateway ownership errors', async () => {
        const gw = new FakeGateway();
        gw.existing.add('parent');
        const detail: CrewSlotDetail = { key: 'parent', messages: [] };
        gw.getSlot = async () => detail;
        gw.forkSlot = async () => { throw new Error('slot not found'); };
        const s = startServer(gw);
        await s.request('session/load', { sessionId: 'parent' });
        assert.match((await s.request('session/fork', { sessionId: 'parent' })).error.message, /No completed/);
        detail.running = true;
        assert.equal((await s.request('session/fork', { sessionId: 'parent' })).error.code, -32000);
        detail.running = false;
        detail.messages = [{ role: 'assistant', type: 'assistant', meta: { mid: 'a' } }];
        assert.match((await s.request('session/fork', { sessionId: 'parent' })).error.message, /slot not found/);
        await s.close();
    });

    test('approval fallback links to its own slot without token credentials', async () => {
        const gw = new FakeGateway();
        gw.streams.push(scripted([frame('permission', 'Read file')]));
        const s = startServer(gw, { dashboardBaseUrl: 'http://127.0.0.1:5476' });
        const sessionId = await s.newSession();
        await s.prompt(sessionId, 'go');
        assert.match(s.updates(sessionId)[0].content.text, new RegExp(`/chat/${sessionId}\\?sid=${sessionId}`));
        assert.doesNotMatch(s.updates(sessionId)[0].content.text, /token=/);
        assert.equal(s.messages.some((m) => m.method === 'session/request_permission'), false);
        await s.close();
    });
});

describe('Official Crew approvals', () => {
    test('cancel drains an unfinished MCP publication before admitting a successor', async (t) => {
        const publishing = deferred(), release = deferred();
        let binds = 0, cleaned = 0;
        t.mock.method(CrewMcpBindings.prototype, 'bind', async () => {
            if (++binds === 1) { publishing.resolve(); await release.promise; }
            return async () => { cleaned++; };
        });
        const gw = new FakeGateway();
        const s = startServer(gw, { cancelGraceMs: 10 });
        const sessionId = await s.newSession();
        const prompt = s.prompt(sessionId, 'cancel while binding');
        await publishing.promise;
        s.notify('session/cancel', { sessionId });
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal((await s.prompt(sessionId, 'too early')).error?.code, -32000);
        assert.equal(binds, 1);
        release.resolve();
        assert.equal((await prompt).result.stopReason, 'cancelled');
        assert.ok(cleaned > 0);
        gw.streams.push(scripted([]));
        assert.equal((await s.prompt(sessionId, 'next')).result.stopReason, 'end_turn');
        assert.deepEqual(gw.callsTo('streamChat'), [[sessionId, 'next']]);
        await s.close();
    });

    test('cancel fences the next turn until an in-flight approval settles', async () => {
        const gw = new FakeGateway();
        const posting = deferred(), release = deferred();
        gw.approvalsAvailable = async () => true;
        gw.prepareApprovals = async () => {};
        gw.pendingApprovals = async () => [{ request_id: '7', request_mid: 'old-card', tool: 'write', input: '' }];
        gw.approve = async () => { posting.resolve(); await release.promise; };
        gw.streams.push(async function* (_slot, _message, signal) {
            await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        });
        const s = startServer(gw, { cancelGraceMs: 10 });
        const sessionId = await s.newSession();
        const prompt = s.prompt(sessionId, 'write');
        const req = await s.waitFor(m => m.method === 'session/request_permission');
        s.input.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } }) + '\n');
        await posting.promise;
        s.notify('session/cancel', { sessionId });
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal((await s.prompt(sessionId, 'too early')).error?.code, -32000);
        release.resolve();
        assert.equal((await prompt).result.stopReason, 'cancelled');
        gw.pendingApprovals = async () => [];
        gw.streams.push(scripted([]));
        assert.equal((await s.prompt(sessionId, 'next')).result.stopReason, 'end_turn');
        await s.close();
    });

    test('recovers polling and forwards the exact request through ACP', async () => {
        const gw = new FakeGateway();
        const started = deferred();
        const finished = deferred();
        const approved = deferred<unknown[]>();
        const approval = { request_id: '17', request_mid: 'unique-row', tool: 'Writing probe.txt', tool_name: 'write', input: 'probe.txt' };
        let polls = 0;
        gw.approvalsAvailable = async () => true;
        gw.prepareApprovals = async () => {};
        gw.pendingApprovals = async () => {
            if (++polls === 1) throw new Error('HTTP 503');
            await started.promise;
            return [approval];
        };
        gw.approve = async (...args) => { approved.resolve(args); finished.resolve(); };
        gw.streams.push(async function* () {
            started.resolve(); yield frame('permission', 'dashboard permission');
            await finished.promise; yield frame('assistant', 'done');
        });
        const s = startServer(gw);
        const sessionId = await s.newSession();
        const prompt = s.prompt(sessionId, 'write');
        const req = await s.waitFor((m) => m.method === 'session/request_permission', 4000);
        assert.equal(req.params.sessionId, sessionId);
        assert.deepEqual(req.params._meta, { toolName: 'write' }, 'stable provider identity supports Michi tool grants');
        s.input.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } }) + '\n');
        assert.deepEqual((await approved.promise).slice(0, 3), [sessionId, approval, true]);
        assert.equal((await prompt).result.stopReason, 'end_turn');
        await s.close();
    });

    test('a rejected native normal-mode change never starts a prompt', async () => {
        const gw = new FakeGateway();
        gw.approvalsAvailable = async () => true;
        gw.prepareApprovals = async () => { throw new Error('sessionApproval revoked'); };
        const s = startServer(gw);
        const sessionId = await s.newSession();
        assert.match((await s.prompt(sessionId, 'write')).error.message, /revoked/);
        assert.deepEqual(gw.callsTo('streamChat'), []);
        await s.close();
    });
});
