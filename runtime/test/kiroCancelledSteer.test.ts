/**
 * A steer still in flight when its prompt ends is judged against that
 * prompt: when the prompt was cancelled, the steer reads as not queued even
 * if its reply arrives after the prompt's result. The prompt's end therefore
 * waits for the steer before it forgets the cancel. The golden scenario S16
 * answers its steer before the prompt result, so it cannot see this order.
 */
import { describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as processTree from "../src/core/processTree";
import { AcpClient } from "../src/adapters/kiro/acpClient";
import type { KiroEngine } from "../src/adapters/kiro/kiroProtocol";

type Frame = Record<string, any>;

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function settle(rounds = 10): Promise<void> {
    for (let i = 0; i < rounds; i++) await tick();
}

/** A fake kiro-cli that answers the handshake and clear, and holds every other request until answered. */
function fakeAgent(t: TestContext) {
    const held = new Map<string, Frame[]>();
    let proc: any;
    const reply = (msg: Frame, result: unknown) => setImmediate(() =>
        proc.stdout.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n")));
    t.mock.method(processTree, "spawnAgentProcess", () => {
        proc = Object.assign(new EventEmitter(), {
            pid: 4242, exitCode: null, signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter(),
            stdin: {
                destroyed: false,
                write: (line: string, cb?: (error?: Error | null) => void) => {
                    cb?.(null);
                    const msg = JSON.parse(line);
                    if (msg.method === "initialize") {
                        reply(msg, { protocolVersion: 1, agentCapabilities: {
                            loadSession: true, _meta: { kiro: { extensionMethods: ["_session/steer", "_session/steer/clear"] } },
                        } });
                    } else if (msg.method === "session/new") reply(msg, { sessionId: "S1", configOptions: [] });
                    else if (msg.method === "_session/steer/clear") reply(msg, { cleared: true });
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
    const answer = (method: string, result: unknown) => {
        const msg = held.get(method)?.shift();
        assert.ok(msg, `${method} was sent`);
        reply(msg, result);
    };
    return { held, answer };
}

/** A prompt in flight on S1 with a steer sent; the steer's reply comes after the prompt's result. */
async function steerAnsweredAfterResult(t: TestContext, engine: KiroEngine, cancel: boolean) {
    const agent = fakeAgent(t);
    const client = new AcpClient("/fake/kiro-cli", "/work", undefined, engine);
    client.start();
    await client.initialize();
    await client.newSession([]);
    let promptEnded = false;
    const consumer = (async () => {
        for await (const _update of client.prompt("S1", "work")) { /* read to the end */ }
        promptEnded = true;
    })();
    await settle();
    assert.equal(agent.held.get("session/prompt")?.length, 1);
    const steer = client.steer("S1", "late");
    await settle();
    assert.equal(agent.held.get("_session/steer")?.length, 1);
    if (cancel) await client.cancel("S1");
    agent.answer("session/prompt", { stopReason: cancel ? "cancelled" : "end_turn" });
    await settle();
    assert.equal(promptEnded, false, "the prompt's end waits for its steer");
    agent.answer("_session/steer", { queued: true, messageId: "m2" });
    const result = await steer;
    await consumer;
    await client.shutdown();
    return result;
}

describe("a steer answered after its prompt's result", () => {
    for (const engine of ["v2", "v3"] as const) {
        test(`${engine}: is not queued when the prompt was cancelled`, async (t) => {
            assert.deepEqual(await steerAnsweredAfterResult(t, engine, true), { queued: false, messageId: "m2" });
        });

        test(`${engine}: is queued when the prompt was not cancelled`, async (t) => {
            assert.deepEqual(await steerAnsweredAfterResult(t, engine, false), { queued: true, messageId: "m2" });
        });
    }
});
