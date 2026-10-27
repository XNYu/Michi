/**
 * Kiro's ACP handshake against a real child process (fixtures/fakeAcpStdio.js),
 * ported from the public repository's acpHandshake.test.ts and corrected to
 * what kiro-cli is actually sent: protocolVersion 1 (a number, checked on the
 * reply), engine-specific argv, no authenticate step.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcpClient } from "../src/adapters/kiro/acpClient";

const FAKE = path.join(__dirname, "fixtures", "fakeAcpStdio.js");
const SWITCHES = ["FAKE_ACP_LOG", "FAKE_ACP_ARGV", "FAKE_ACP_PROFILE", "FAKE_ACP_EMIT", "FAKE_ACP_AGENT_CAPS", "FAKE_ACP_PROTOCOL"];
// The fixture runs through its shebang.
const posixOnly = { skip: process.platform === "win32" };

function received(logFile: string): Array<Record<string, any>> {
    return JSON.parse(fs.readFileSync(logFile, "utf8"));
}

describe("Kiro ACP handshake over stdio", () => {
    let tmp: string;
    let logFile: string;
    let argvFile: string;
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acp-kiro-handshake-")));
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

    async function handshake(client: AcpClient): Promise<string> {
        try {
            client.start();
            await client.initialize();
            const { sessionId } = await client.newSession([]);
            return sessionId;
        } finally {
            await client.shutdown();
        }
    }

    test("initialize and session/new complete over NDJSON", posixOnly, async () => {
        const sessionId = await handshake(new AcpClient(FAKE, tmp, undefined, "v2"));
        assert.equal(sessionId, "sess-1");
        const messages = received(logFile);
        assert.deepEqual(messages.map((m) => m.method), ["initialize", "session/new"]);
        assert.deepEqual(messages[1].params, { cwd: tmp, mcpServers: [] }, "v2 sends no _meta");
    });

    test("v2: protocolVersion 1, Michi's client info, no capabilities, no authenticate", posixOnly, async () => {
        await handshake(new AcpClient(FAKE, tmp, undefined, "v2"));
        assert.deepEqual(JSON.parse(fs.readFileSync(argvFile, "utf8")), ["acp", "--agent-engine", "v2"]);
        const [init] = received(logFile);
        assert.equal(init.params.protocolVersion, 1);
        assert.deepEqual(init.params.clientInfo, { name: "michi", version: "1.0.0" });
        assert.deepEqual(init.params.clientCapabilities, {});
        assert.ok(!received(logFile).some((m) => m.method === "authenticate"));
    });

    test("v2 passes the cold-start model on argv", posixOnly, async () => {
        await handshake(new AcpClient(FAKE, tmp, "claude-sonnet", "v2"));
        assert.deepEqual(JSON.parse(fs.readFileSync(argvFile, "utf8")), ["acp", "--agent-engine", "v2", "--model", "claude-sonnet"]);
    });

    test("v3 uses CLI auth and never puts the model on argv", posixOnly, async () => {
        await handshake(new AcpClient(FAKE, tmp, "claude-sonnet", "v3"));
        assert.deepEqual(JSON.parse(fs.readFileSync(argvFile, "utf8")), ["acp", "--agent-engine", "v3", "--auth-method", "cli"]);
        const [init, sessionNew] = received(logFile);
        assert.equal(init.params.protocolVersion, 1);
        assert.deepEqual(sessionNew.params, { cwd: tmp, mcpServers: [], _meta: { kiro: { modelId: "claude-sonnet" } } });
    });

    test("initialize keeps the advertised agent capabilities", posixOnly, async () => {
        const caps = { loadSession: true, mcpCapabilities: { http: true }, promptCapabilities: { image: true } };
        process.env.FAKE_ACP_AGENT_CAPS = JSON.stringify(caps);
        const client = new AcpClient(FAKE, tmp, undefined, "v2");
        try {
            client.start();
            await client.initialize();
            assert.deepEqual(client.capabilities, caps);
        } finally {
            await client.shutdown();
        }
    });

    test("an agent answering another protocol version is refused", posixOnly, async () => {
        process.env.FAKE_ACP_PROTOCOL = "2";
        process.env.FAKE_ACP_AGENT_CAPS = JSON.stringify({ loadSession: true });
        const client = new AcpClient(FAKE, tmp, undefined, "v2");
        try {
            client.start();
            await assert.rejects(client.initialize(), { name: "ACPError", message: "Unsupported ACP protocol version" });
            assert.equal(client.capabilities, undefined, "the refused reply is not kept");
        } finally {
            await client.shutdown();
        }
    });
});
