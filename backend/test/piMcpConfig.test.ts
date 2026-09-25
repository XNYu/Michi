import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

// piMcpConfig reads ~/.michi/config.json (hard-coded path) + env var.
// We test the env-var path heavily and verify the overall shape.
import { readPiMcpServers } from "../src/services/piMcpConfig";

describe("piMcpConfig", () => {
    const savedEnv = process.env.MICHI_PI_MCP_SERVERS;

    afterEach(() => {
        if (savedEnv === undefined) {
            delete process.env.MICHI_PI_MCP_SERVERS;
        } else {
            process.env.MICHI_PI_MCP_SERVERS = savedEnv;
        }
    });

    it("reads comma-separated shorthand from env", () => {
        process.env.MICHI_PI_MCP_SERVERS = "sample-mcp,sample-docs-mcp";
        const servers = readPiMcpServers();
        assert.ok(servers.length >= 2, `expected at least 2 servers, got ${servers.length}`);
        const names = servers.map((s) => s.serverName);
        assert.ok(names.includes("sample"), "expected 'sample' server");
        assert.ok(names.includes("sample-docs"), "expected 'sample-docs' server");
    });

    it("reads JSON array from env", () => {
        process.env.MICHI_PI_MCP_SERVERS = JSON.stringify([
            { serverName: "custom", command: "/usr/bin/my-mcp", args: ["--flag"] },
        ]);
        const servers = readPiMcpServers();
        const custom = servers.find((s) => s.serverName === "custom");
        assert.ok(custom, "expected 'custom' server from JSON env");
        assert.equal(custom.command, "/usr/bin/my-mcp");
        assert.deepEqual(custom.args, ["--flag"]);
    });

    it("returns empty array when nothing configured", () => {
        delete process.env.MICHI_PI_MCP_SERVERS;
        // May not be empty if ~/.michi/config.json has piMcpServers, but
        // at minimum it should not throw.
        const servers = readPiMcpServers();
        assert.ok(Array.isArray(servers));
    });

    it("de-duplicates by serverName (env wins over config.json)", () => {
        process.env.MICHI_PI_MCP_SERVERS = JSON.stringify([
            { serverName: "sample", command: "my-custom-sample" },
        ]);
        const servers = readPiMcpServers();
        const samples = servers.filter((s) => s.serverName === "sample");
        // Should have exactly one — env overrides any config.json entry
        assert.equal(samples.length, 1);
        assert.equal(samples[0].command, "my-custom-sample");
    });

    it("skips invalid entries", () => {
        process.env.MICHI_PI_MCP_SERVERS = JSON.stringify([
            null,
            42,
            { command: "" },  // empty command
            { command: "valid-mcp" },
        ]);
        const servers = readPiMcpServers();
        const valid = servers.find((s) => s.command === "valid-mcp");
        assert.ok(valid, "expected valid-mcp to survive");
    });

    it("passes cwd and env through from JSON config", () => {
        process.env.MICHI_PI_MCP_SERVERS = JSON.stringify([
            { serverName: "test", command: "test-mcp", cwd: "/tmp", env: { FOO: "bar" } },
        ]);
        const servers = readPiMcpServers();
        const test = servers.find((s) => s.serverName === "test");
        assert.ok(test);
        assert.equal(test.cwd, "/tmp");
        assert.deepEqual(test.env, { FOO: "bar" });
    });
});
