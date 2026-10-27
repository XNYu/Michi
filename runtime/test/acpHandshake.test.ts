/**
 * The ACP core driven by a profile alone, against a real child process
 * (fixtures/fakeAcpStdio.js). Ported from the public repository's
 * acpHandshake.test.ts: its Cursor and Grok cases become inline profiles
 * (vendor profiles are not ported), and Kiro's profile run through the core
 * must say exactly what Kiro's client says.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcpClient as AcpCoreClient } from "../src/adapters/acp/client";
import type { AcpProfile } from "../src/adapters/acp/types";
import { AcpClient as KiroAcpClient } from "../src/adapters/kiro/acpClient";
import { KiroAcpProfile } from "../src/adapters/kiro/kiroAcpProfile";

const FAKE = path.join(__dirname, "fixtures", "fakeAcpStdio.js");
const SWITCHES = ["FAKE_ACP_LOG", "FAKE_ACP_ARGV", "FAKE_ACP_PROFILE", "FAKE_ACP_EMIT", "FAKE_ACP_AGENT_CAPS",
    "FAKE_ACP_PROTOCOL", "FAKE_GROK_AUTH_METHODS"];
// Kiro's profile runs the fixture through its shebang.
const posixOnly = { skip: process.platform === "win32" };

function received(logFile: string): Array<Record<string, any>> {
    return JSON.parse(fs.readFileSync(logFile, "utf8"));
}

describe("ACP core handshake driven by a profile", () => {
    let tmp: string;
    let logFile: string;
    let argvFile: string;
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acp-core-handshake-")));
        logFile = path.join(tmp, "received.json");
        argvFile = path.join(tmp, "argv.json");
        for (const key of SWITCHES) saved[key] = process.env[key];
        for (const key of SWITCHES) delete process.env[key];
        process.env.FAKE_ACP_LOG = logFile;
        process.env.FAKE_ACP_ARGV = argvFile;
    });

    afterEach(() => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    /** A minimal agent profile: node runs the fixture, so it needs no shebang. */
    function profile(overrides: Partial<AcpProfile> = {}): AcpProfile {
        return {
            runtimeId: "probe-agent",
            logLabel: "probe",
            binaryPath: process.execPath,
            cwd: tmp,
            spawnArgs: [FAKE, "acp"],
            protocolVersion: 1,
            clientInfo: { name: "michi", version: "1.0.0" },
            clientCapabilities: {},
            ...overrides,
        };
    }

    async function initialized<T>(client: AcpCoreClient, check: (result: unknown) => T | Promise<T>): Promise<T> {
        try {
            client.start();
            return await check(await client.initialize());
        } finally {
            await client.shutdown();
        }
    }

    test("session/new sends cwd and MCP servers as given, and nothing else without sessionParams", async () => {
        const client = new AcpCoreClient(profile());
        const server = { name: "michi", type: "http" as const, url: "http://127.0.0.1:3000/api/mcp/slot", headers: [] };
        try {
            client.start();
            await client.initialize();
            const session = await client.newSession([server], { modelId: "ignored", metadata: { chatId: "c" } });
            assert.equal(session.sessionId, "sess-1");
            assert.deepEqual(client.getSessionInfo("sess-1"), { sessionId: "sess-1", modes: { availableModes: [], currentModeId: "agent" }, models: { availableModels: [] } });
            assert.equal(client.hasSession("sess-1"), true);
        } finally {
            await client.shutdown();
        }
        assert.deepEqual(received(logFile)[1].params, { cwd: tmp, mcpServers: [server] });
    });

    test("sessionParams and normalizeSessionInfo shape session/new and what is kept", async () => {
        const client = new AcpCoreClient(profile({
            sessionParams: (kind, options) => ({ _meta: { kind, modelId: options.modelId } }),
            normalizeSessionInfo: (info) => ({ ...info, models: { currentModelId: "normalized" } }),
        }));
        try {
            client.start();
            await client.initialize();
            await client.newSession([], { modelId: "m" });
            assert.deepEqual(client.getSessionInfo("sess-1")?.models, { currentModelId: "normalized" });
        } finally {
            await client.shutdown();
        }
        assert.deepEqual(received(logFile)[1].params, { cwd: tmp, mcpServers: [], _meta: { kind: "new", modelId: "m" } });
    });

    test("authenticate follows initialize with what buildAuthenticate returns", async () => {
        process.env.FAKE_ACP_PROFILE = "cursor";
        const seen: unknown[] = [];
        await initialized(new AcpCoreClient(profile({
            buildAuthenticate: (init) => { seen.push(init); return { methodId: "cursor_login" }; },
        })), () => undefined);
        assert.deepEqual(JSON.parse(fs.readFileSync(argvFile, "utf8")), ["acp"]);
        const messages = received(logFile);
        assert.deepEqual(messages.map((m) => m.method), ["initialize", "authenticate"]);
        assert.equal(messages[0].params.protocolVersion, 1);
        assert.deepEqual(messages[1].params, { methodId: "cursor_login" });
        assert.deepEqual(seen, [{ protocolVersion: 1, authMethods: [{ id: "cursor_login" }] }]);
    });

    test("client capabilities pass through; authenticate params are sent as returned", async () => {
        process.env.FAKE_ACP_PROFILE = "grok";
        const clientCapabilities = { fs: { readTextFile: false, writeTextFile: false }, terminal: false };
        await initialized(new AcpCoreClient(profile({
            clientCapabilities,
            buildAuthenticate: (init) => ({ methodId: (init.authMethods ?? []).at(-1)?.id, _meta: { headless: true } }),
        })), () => undefined);
        const [init, auth] = received(logFile);
        assert.deepEqual(init.params.clientCapabilities, clientCapabilities);
        assert.deepEqual(auth.params, { methodId: "cached_token", _meta: { headless: true } });
    });

    test("no authenticate when buildAuthenticate returns null", async () => {
        process.env.FAKE_ACP_PROFILE = "grok";
        process.env.FAKE_GROK_AUTH_METHODS = JSON.stringify([{ id: "grok.com" }]);
        await initialized(new AcpCoreClient(profile({ buildAuthenticate: () => null })), () => undefined);
        assert.deepEqual(received(logFile).map((m) => m.method), ["initialize"]);
    });

    test("initialize returns and keeps the agent's reply", async () => {
        process.env.FAKE_ACP_PROFILE = "grok";
        process.env.FAKE_ACP_AGENT_CAPS = JSON.stringify({ loadSession: true, mcpCapabilities: { http: true }, promptCapabilities: { image: false } });
        const client = new AcpCoreClient(profile());
        await initialized(client, (result) => {
            assert.deepEqual(result, {
                protocolVersion: 1,
                authMethods: [{ id: "xai.api_key" }, { id: "cached_token" }],
                agentCapabilities: { loadSession: true, mcpCapabilities: { http: true }, promptCapabilities: { image: false } },
            });
            assert.deepEqual(client.getInitializeResult(), result);
            assert.deepEqual(client.capabilities, (result as { agentCapabilities: unknown }).agentCapabilities);
        });
    });

    test("another protocol version is accepted unless the profile requires its own", async () => {
        process.env.FAKE_ACP_PROTOCOL = JSON.stringify("2025-01-01");
        await initialized(new AcpCoreClient(profile()), (result) =>
            assert.equal((result as { protocolVersion: unknown }).protocolVersion, "2025-01-01"));
        const strict = new AcpCoreClient(profile({ requireProtocolVersion: true }));
        await initialized(strict, () => undefined).then(
            () => assert.fail("expected a refusal"),
            (error: Error) => assert.equal(error.message, "Unsupported ACP protocol version"));
        assert.equal(strict.getInitializeResult(), null);
    });

    test("spawnEnv is merged onto the host's environment", async () => {
        const client = new AcpCoreClient(profile({ spawnEnv: { FAKE_ACP_PROFILE: "cursor" } }), { spawnEnv: () => process.env });
        await initialized(client, (result) =>
            assert.deepEqual((result as { authMethods: unknown }).authMethods, [{ id: "cursor_login" }]));
        assert.throws(() => new AcpCoreClient(profile({ spawnEnv: { A: "1" } })), /needs the host's base environment/);
    });

    test("preflight runs before the spawn and can refuse it", () => {
        const client = new AcpCoreClient(profile({ preflight: () => { throw new Error("probe-agent is not signed in"); } }));
        assert.throws(() => client.start(), /not signed in/);
        assert.equal(client.isAlive(), false);
        assert.equal(fs.existsSync(argvFile), false, "nothing was spawned");
    });

    for (const engine of ["v2", "v3"] as const) {
        test(`Kiro's profile through the core says what Kiro's client says (${engine})`, posixOnly, async () => {
            const sent = async (client: AcpCoreClient) => {
                try {
                    client.start();
                    await client.initialize();
                    await client.newSession([], { metadata: { chatId: "c1" } });
                } finally {
                    await client.shutdown();
                }
                return { argv: JSON.parse(fs.readFileSync(argvFile, "utf8")), messages: received(logFile) };
            };
            const kiro = await sent(new KiroAcpClient(FAKE, tmp, "claude-sonnet", engine));
            const core = await sent(new AcpCoreClient(new KiroAcpProfile({ binaryPath: FAKE, cwd: tmp, model: "claude-sonnet", engine })));
            assert.deepEqual(core, kiro);
            assert.deepEqual(kiro.messages.map((m) => m.method), ["initialize", "session/new"]);
        });
    }
});
