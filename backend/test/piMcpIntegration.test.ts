import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import type { McpServerConfig, McpToolInfo, McpToolResult } from "../src/services/mcpClientManager";
import { McpClientManager } from "../src/services/mcpClientManager";
import { buildMcpToolsForPi, mcpToolName, parseMcpToolName } from "../src/agents/pi/mcpToolBridge";

/**
 * Integration test: verifies the full MCP → Pi tool wiring that PiSession
 * relies on. We mock the McpClientManager at the SDK level (no real child
 * processes) and confirm that:
 *
 *   1. buildMcpToolsForPi produces tools with the right namespace
 *   2. execute() correctly strips __tool_use_purpose and forwards
 *   3. isError propagation works
 *   4. allowlist filtering works
 *   5. Multiple servers produce non-conflicting tools
 */

/** A fake McpClientManager that doesn't spawn processes. */
class FakeMcpManager {
    private servers = new Map<string, McpToolInfo[]>();
    private callLog: Array<{ server: string; tool: string; args: Record<string, unknown> }> = [];
    private callResults = new Map<string, McpToolResult>();

    addServer(name: string, tools: McpToolInfo[]) {
        this.servers.set(name, tools);
    }

    setCallResult(server: string, tool: string, result: McpToolResult) {
        this.callResults.set(`${server}/${tool}`, result);
    }

    connectedServers(): string[] {
        return [...this.servers.keys()];
    }

    listTools(serverName?: string): McpToolInfo[] {
        if (serverName) return this.servers.get(serverName) ?? [];
        const all: McpToolInfo[] = [];
        for (const tools of this.servers.values()) all.push(...tools);
        return all;
    }

    async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
        this.callLog.push({ server: serverName, tool: toolName, args });
        const key = `${serverName}/${toolName}`;
        return this.callResults.get(key) ?? {
            content: [{ type: "text", text: `mock result for ${key}` }],
            isError: false,
        };
    }

    getCallLog() { return this.callLog; }

    isConnected(name: string): boolean { return this.servers.has(name); }
    async disconnect(_name: string) {}
    async dispose() { this.servers.clear(); }
}

// Minimal TypeBox stand-in
const Type = {
    String: () => ({ type: "string" }),
    Number: () => ({ type: "number" }),
    Boolean: () => ({ type: "boolean" }),
    Object: (shape: any, opts?: any) => ({ type: "object", properties: shape, ...opts }),
    Optional: (s: any) => ({ ...s, optional: true }),
    Array: (items: any) => ({ type: "array", items }),
    Union: (members: any[]) => ({ anyOf: members }),
    Literal: (v: any) => ({ const: v }),
    Unknown: () => ({}),
};

describe("PiSession MCP integration (via mcpToolBridge)", () => {
    let manager: FakeMcpManager;

    beforeEach(() => {
        manager = new FakeMcpManager();
        manager.addServer("sample", [
            {
                name: "ReadPages",
                description: "Read sample documentation pages",
                inputSchema: {
                    type: "object",
                    properties: {
                        inputs: {
                            type: "array",
                            items: { type: "string" },
                            description: "URLs to read",
                        },
                    },
                    required: ["inputs"],
                },
            },
            {
                name: "SearchPages",
                description: "Search sample documentation",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: { type: "string", description: "Search query" },
                        domain: { type: "string", description: "Domain" },
                    },
                    required: ["query"],
                },
            },
        ]);
    });

    it("produces namespaced tools from MCP server", () => {
        const tools = buildMcpToolsForPi({
            mcpManager: manager as any,
            Type,
        });
        assert.equal(tools.length, 2);
        assert.equal(tools[0].name, "mcp__sample__ReadPages");
        assert.equal(tools[1].name, "mcp__sample__SearchPages");
        assert.equal(tools[0].label, "ReadPages");
        assert.ok(tools[0].description.includes("sample documentation"));
    });

    it("execute() strips __tool_use_purpose and forwards clean args", async () => {
        const tools = buildMcpToolsForPi({
            mcpManager: manager as any,
            Type,
        });
        const readTool = tools[0];
        await readTool.execute("call-1", {
            __tool_use_purpose: "Reading a sample profile page",
            inputs: ["https://example.com/users/alice"],
        });
        const log = manager.getCallLog();
        assert.equal(log.length, 1);
        assert.equal(log[0].server, "sample");
        assert.equal(log[0].tool, "ReadPages");
        assert.deepEqual(log[0].args, {
            inputs: ["https://example.com/users/alice"],
        });
        // __tool_use_purpose must NOT appear in forwarded args
        assert.equal("__tool_use_purpose" in log[0].args, false);
    });

    it("propagates isError from MCP server", async () => {
        manager.setCallResult("sample", "ReadPages", {
            content: [{ type: "text", text: "403 Forbidden" }],
            isError: true,
        });
        const tools = buildMcpToolsForPi({ mcpManager: manager as any, Type });
        const result = await tools[0].execute("call-2", { inputs: ["https://restricted.example.com"] });
        assert.equal(result.isError, true);
        assert.ok(result.content[0].text.includes("403"));
    });

    it("allowlist filters out tools", () => {
        const tools = buildMcpToolsForPi({
            mcpManager: manager as any,
            Type,
            allowedTools: new Set(["ReadPages"]),
        });
        assert.equal(tools.length, 1);
        assert.equal(tools[0].name, "mcp__sample__ReadPages");
    });

    it("handles multiple MCP servers without name collisions", () => {
        manager.addServer("sample-docs", [
            {
                name: "get-spec-content",
                description: "Get spec content",
                inputSchema: { type: "object", properties: { name: { type: "string" } } },
            },
        ]);
        const tools = buildMcpToolsForPi({ mcpManager: manager as any, Type });
        assert.equal(tools.length, 3);
        const names = tools.map((t: any) => t.name);
        assert.ok(names.includes("mcp__sample__ReadPages"));
        assert.ok(names.includes("mcp__sample__SearchPages"));
        assert.ok(names.includes("mcp__sample-docs__get-spec-content"));
    });

    it("mcpToolName and parseMcpToolName round-trip correctly", () => {
        const name = mcpToolName("sample", "ReadPages");
        assert.equal(name, "mcp__sample__ReadPages");
        const parsed = parseMcpToolName(name);
        assert.deepEqual(parsed, { serverName: "sample", toolName: "ReadPages" });
    });

    it("parseMcpToolName returns null for non-MCP tool names", () => {
        assert.equal(parseMcpToolName("save_artifact"), null);
        assert.equal(parseMcpToolName("spawn_branches"), null);
        assert.equal(parseMcpToolName("read"), null);
    });

    it("handles empty MCP tool result gracefully", async () => {
        manager.setCallResult("sample", "ReadPages", {
            content: [],
            isError: false,
        });
        const tools = buildMcpToolsForPi({ mcpManager: manager as any, Type });
        const result = await tools[0].execute("call-3", { inputs: [] });
        assert.equal(result.isError, false);
        assert.ok(result.content[0].text.includes("no text content"));
    });

    it("flattens multi-part text content", async () => {
        manager.setCallResult("sample", "ReadPages", {
            content: [
                { type: "text", text: "Part 1" },
                { type: "text", text: "Part 2" },
                { type: "image", data: "..." },  // non-text skipped
            ],
            isError: false,
        });
        const tools = buildMcpToolsForPi({ mcpManager: manager as any, Type });
        const result = await tools[0].execute("call-4", { inputs: [] });
        assert.equal(result.content[0].text, "Part 1\nPart 2");
    });

    it("converts nested JSON Schema to TypeBox parameters", () => {
        manager.addServer("complex", [
            {
                name: "ComplexTool",
                description: "Has nested params",
                inputSchema: {
                    type: "object",
                    properties: {
                        config: {
                            type: "object",
                            properties: {
                                enabled: { type: "boolean" },
                                count: { type: "number" },
                            },
                        },
                        tags: {
                            type: "array",
                            items: { type: "string" },
                        },
                        mode: {
                            type: "string",
                            enum: ["fast", "thorough"],
                        },
                    },
                    required: ["config"],
                },
            },
        ]);
        const tools = buildMcpToolsForPi({ mcpManager: manager as any, Type });
        const complexTool = tools.find((t: any) => t.name === "mcp__complex__ComplexTool");
        assert.ok(complexTool, "complex tool should be present");
        // Just verify it exists and has parameters — deep TypeBox shape
        // validation is covered in mcpToolBridge.test.ts
        assert.ok(complexTool.parameters);
    });
});
