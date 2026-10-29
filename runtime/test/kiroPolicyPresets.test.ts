/**
 * Kiro V3 seeds policy presets (Approve for me) only at session/new and
 * session/load, and loading a live session keeps its policy (kiro-cli 2.35.1,
 * probed without prompts). AcpClient records what each session was opened
 * with and reopens an idle session with session/close + session/load.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as processTree from "../src/core/processTree";
import { AcpClient } from "../src/adapters/kiro/acpClient";
import { KIRO_APPROVE_FOR_ME_PRESET } from "../src/adapters/kiro/kiroProtocol";

type Frame = Record<string, any>;

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function settle(rounds = 10): Promise<void> {
    for (let i = 0; i < rounds; i++) await tick();
}

const EFFORT = (value: string) => ({ id: 'effortLevel', type: 'select', category: 'thought_level', currentValue: value,
    options: [{ value: 'low' }, { value: 'high' }] });

/** A fake kiro-cli v3. `fail` makes the named method answer with an error. */
function fakeAgent(t: TestContext, options: { close?: boolean; fail?: string } = {}) {
    const sent: Frame[] = [];
    const held = new Map<string, Frame[]>();
    let proc: any;
    const reply = (msg: Frame, result: unknown) => setImmediate(() =>
        proc.stdout.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n")));
    const error = (msg: Frame) => setImmediate(() =>
        proc.stdout.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: 'Internal error' } }) + "\n")));
    t.mock.method(processTree, "spawnAgentProcess", () => {
        proc = Object.assign(new EventEmitter(), {
            pid: 4243, exitCode: null, signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter(),
            stdin: {
                destroyed: false,
                write: (line: string, cb?: (error?: Error | null) => void) => {
                    cb?.(null);
                    const msg = JSON.parse(line);
                    sent.push(msg);
                    if (msg.method === options.fail) return error(msg), true;
                    if (msg.method === "initialize") {
                        reply(msg, { protocolVersion: 1, agentCapabilities: { loadSession: true,
                            sessionCapabilities: { list: {}, fork: {}, ...(options.close === false ? {} : { close: {} }) } } });
                    } else if (msg.method === "session/new") reply(msg, { sessionId: "S1", configOptions: [EFFORT('low')] });
                    // A reload resets config options to the agent's defaults.
                    else if (msg.method === "session/load") reply(msg, { configOptions: [EFFORT('low')] });
                    else if (msg.method === "session/close") reply(msg, {});
                    else if (msg.method === "session/set_config_option") reply(msg, { configOptions: [EFFORT(msg.params.value)] });
                    else if (msg.id !== undefined && msg.method) held.set(msg.method, [...(held.get(msg.method) ?? []), msg]);
                    return true;
                },
            },
        });
        return proc;
    });
    t.mock.method(processTree, "killProcessTree", () => setImmediate(() => {
        proc.signalCode = "SIGTERM";
        proc.emit("exit", null, "SIGTERM");
    }));
    const methods = () => sent.map((msg) => msg.method).filter(Boolean);
    return { sent, held, methods, answer: (method: string, result: unknown) => reply(held.get(method)!.shift()!, result) };
}

async function client(t: TestContext, options?: Parameters<typeof fakeAgent>[1]) {
    const agent = fakeAgent(t, options);
    const c = new AcpClient("/fake/kiro-cli", "/work", undefined, 'v3');
    t.after(() => c.shutdown());
    c.start();
    await c.initialize();
    return { agent, c };
}

test('session/new seeds the presets it is opened with and records them', async (t) => {
    const { agent, c } = await client(t);
    await c.newSession([], { policyPresets: [KIRO_APPROVE_FOR_ME_PRESET] });
    const opened = agent.sent.find((msg) => msg.method === 'session/new')!;
    assert.deepEqual(opened.params._meta.kiro.policyPreset, ['approve-for-me']);
    assert.deepEqual(c.policyPresets('S1'), ['approve-for-me']);
    assert.equal(c.policyPresets('unknown'), undefined, 'a session this process never opened');
});

test('reopening closes then loads the idle session with the new presets and keeps its settings', async (t) => {
    const { agent, c } = await client(t);
    const mcp = [{ name: 'michi', type: 'http' as const, url: 'http://127.0.0.1/mcp', headers: [] }];
    await c.newSession(mcp, { workflowsEnabled: true });
    await c.setConfigOption('S1', 'effortLevel', 'high');
    assert.deepEqual(c.policyPresets('S1'), []);
    await c.reopenWithPolicyPresets('S1', [KIRO_APPROVE_FOR_ME_PRESET]);
    const tail = agent.methods().slice(-3);
    assert.deepEqual(tail, ['session/close', 'session/load', 'session/set_config_option']);
    const load = agent.sent.find((msg) => msg.method === 'session/load')!;
    assert.deepEqual(load.params.mcpServers, mcp, 'the same MCP servers');
    assert.deepEqual(load.params._meta.kiro.policyPreset, ['approve-for-me']);
    assert.deepEqual(load.params._meta.kiro.settings, { workflows: { enabled: true } }, 'other options are kept');
    // A reopened session that never prompted is not in Kiro's catalog: no session/list check.
    assert.ok(!agent.methods().includes('session/list'));
    assert.equal(c.getSessionInfo('S1')?.configOptions?.find((o) => o.id === 'effortLevel')?.currentValue, 'high');
    assert.deepEqual(c.policyPresets('S1'), ['approve-for-me']);

    await c.reopenWithPolicyPresets('S1', []);
    const unload = agent.sent.filter((msg) => msg.method === 'session/load').at(-1)!;
    assert.equal(unload.params._meta.kiro.policyPreset, undefined, 'turning it off sends no preset');
    assert.deepEqual(c.policyPresets('S1'), []);
});

test('a session cannot be reopened while a prompt runs, and a failed load quarantines it', async (t) => {
    const { agent, c } = await client(t, { fail: 'session/load' });
    await c.newSession([], {});
    const consumer = (async () => { for await (const _ of c.prompt('S1', 'work')) { /* drain */ } })();
    await settle();
    await assert.rejects(c.reopenWithPolicyPresets('S1', [KIRO_APPROVE_FOR_ME_PRESET]), /active Kiro session/);
    agent.answer('session/prompt', { stopReason: 'end_turn' });
    await consumer;
    await assert.rejects(c.reopenWithPolicyPresets('S1', [KIRO_APPROVE_FOR_ME_PRESET]));
    assert.equal(c.needsSessionRecovery('S1'), true, 'closed and not loaded: recovery reloads it');
    assert.equal(c.policyPresets('S1'), undefined);
});

test('reopening needs session/close and Kiro v3', async (t) => {
    const { c } = await client(t, { close: false });
    await c.newSession([], {});
    await assert.rejects(c.reopenWithPolicyPresets('S1', []), /session\/close/);
    const v2 = new AcpClient("/fake/kiro-cli", "/work", undefined, 'v2');
    await assert.rejects(v2.reopenWithPolicyPresets('S1', []), /require Kiro v3/);
});
