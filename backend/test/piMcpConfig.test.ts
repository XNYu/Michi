import { isolatedConfigDir } from './isolatedConfigDir';
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from 'node:fs';
import path from 'node:path';

import { readPiMcpServers } from "../src/services/piMcpConfig";

describe("piMcpConfig", () => {
    const envKeys = ['MICHI_PI_MCP_SERVERS'] as const;
    const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    const configPath = path.join(isolatedConfigDir, 'config.json');

    beforeEach(() => {
        for (const key of envKeys) delete process.env[key];
        fs.writeFileSync(configPath, '{}');
    });

    afterEach(() => {
        for (const key of envKeys) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
    });

    it('reads MCP definitions from the selected isolated config directory', () => {
        fs.writeFileSync(configPath, JSON.stringify({ piMcpServers: [{ serverName: 'preview', command: 'preview-mcp' }] }));
        assert.deepEqual(readPiMcpServers(), [{ serverName: 'preview', command: 'preview-mcp', args: undefined, env: undefined, cwd: undefined }]);
    });

    it('lets explicit env definitions override the selected disk config by name', () => {
        fs.writeFileSync(configPath, JSON.stringify({ piMcpServers: ['disk-only-mcp', { serverName: 'same', command: 'disk-mcp' }] }));
        process.env.MICHI_PI_MCP_SERVERS = JSON.stringify([{ serverName: 'same', command: 'env-mcp' }]);
        const servers = readPiMcpServers();
        assert.equal(servers.find(server => server.serverName === 'same')?.command, 'env-mcp');
        assert.equal(servers.find(server => server.serverName === 'disk-only')?.command, 'disk-only-mcp');
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

    it("derives serverName from command basename", () => {
        process.env.MICHI_PI_MCP_SERVERS = "/opt/tools/sample-mcp";
        const servers = readPiMcpServers();
        const sample = servers.find((s) => s.serverName === "sample");
        assert.ok(sample, "expected serverName 'sample' derived from '/opt/tools/sample-mcp'");
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
    it('surfaces corrupt selected config instead of treating it as an empty catalog or starting unconfigured servers', () => {
        fs.writeFileSync(configPath, '{"credential":"fixture-secret",');
        assert.throws(readPiMcpServers, (error: any) => error.code === 'CONFIG_CORRUPT' && !error.message.includes('fixture-secret'));
        fs.writeFileSync(configPath, '[]');
        assert.throws(readPiMcpServers, { code: 'CONFIG_CORRUPT' });
    });

    it('rejects malformed JSON-looking env config without turning it into a shorthand command', () => {
        for (const value of ['[{"credential":"fixture-secret",', '{"command":"fixture"}']) {
            process.env.MICHI_PI_MCP_SERVERS = value;
            assert.throws(readPiMcpServers, (error: any) => error.code === 'MCP_CONFIG_INVALID' && !error.message.includes('fixture-secret'));
        }
    });


});
