/**
 * Tests for mcpToolBridge — verifying JSON Schema → TypeBox conversion,
 * namespacing, allowlist filtering, and tool execution proxy.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
    buildMcpToolsForPi,
    mcpToolName,
    parseMcpToolName,
} from "../src/agents/pi/mcpToolBridge";
import type { McpClientManager, McpToolInfo, McpToolResult } from "../src/services/mcpClientManager";

// Minimal TypeBox stand-in (same pattern as piTools.test.ts)
const Type: any = new Proxy({}, {
    get: (_target, prop) => {
        if (prop === "Object") return (shape: any, _opts?: any) => ({ __tb: "object", shape });
        if (prop === "String") return () => ({ __tb: "string" });
        if (prop === "Number") return () => ({ __tb: "number" });
        if (prop === "Boolean") return () => ({ __tb: "boolean" });
        if (prop === "Array") return (items: any) => ({ __tb: "array", items });
        if (prop === "Optional") return (inner: any) => ({ __tb: "optional", inner });
        if (prop === "Union") return (variants: any) => ({ __tb: "union", variants });
        if (prop === "Literal") return (value: any) => ({ __tb: "literal", value });
        if (prop === "Unknown") return () => ({ __tb: "unknown" });
        return (..._a: any[]) => ({});
    },
});

// ─── Mock McpClientManager ──────────────────────────────────────────────

class FakeManager {
    private servers = new Map<string, McpToolInfo[]>();
    private results = new Map<string, McpToolResult>();

    addServer(name: string, tools: McpToolInfo[]) {
        this.servers.set(name, tools);
    }

    setToolResult(serverName: string, toolName: string, result: McpToolResult) {
        this.results.set(`${serverName}/${toolName}`, result);
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

    async callTool(serverName: string, toolName: string, _args: Record<string, unknown>): Promise<McpToolResult> {
        const result = this.results.get(`${serverName}/${toolName}`);
        if (!result) throw new Error(`no mock result for ${serverName}/${toolName}`);
        return result;
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("mcpToolName / parseMcpToolName", () => {
    test("formats namespaced tool names", () => {
        assert.equal(mcpToolName("sample", "ReadPages"), "mcp__sample__ReadPages");
        assert.equal(mcpToolName("sample-docs", "get-spec-content"), "mcp__sample-docs__get-spec-content");
    });

    test("parses namespaced tool names back", () => {
        const parsed = parseMcpToolName("mcp__sample__ReadPages");
        assert.deepEqual(parsed, { serverName: "sample", toolName: "ReadPages" });
    });

    test("parseMcpToolName handles hyphenated server names", () => {
        const parsed = parseMcpToolName("mcp__sample-docs__get-spec-content");
        assert.deepEqual(parsed, { serverName: "sample-docs", toolName: "get-spec-content" });
    });

    test("parseMcpToolName returns null for non-MCP names", () => {
        assert.equal(parseMcpToolName("read"), null);
        assert.equal(parseMcpToolName("spawn_branches"), null);
        assert.equal(parseMcpToolName("mcp__incomplete"), null);
    });
});

describe("buildMcpToolsForPi", () => {
    test("wraps all tools from all connected servers", () => {
        const mgr = new FakeManager();
        mgr.addServer("sample", [
            { name: "search_code", description: "Search code", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
            { name: "read_wiki", description: "Read wiki page", inputSchema: { type: "object", properties: { url: { type: "string" } } } },
        ]);
        mgr.addServer("spec", [
            { name: "get_spec", description: "Get spec", inputSchema: {} },
        ]);

        const tools = buildMcpToolsForPi({
            mcpManager: mgr as unknown as McpClientManager,
            Type,
        });

        assert.equal(tools.length, 3);
        const names = tools.map((t: any) => t.name);
        assert.ok(names.includes("mcp__sample__search_code"));
        assert.ok(names.includes("mcp__sample__read_wiki"));
        assert.ok(names.includes("mcp__spec__get_spec"));
    });

    test("applies allowlist filter", () => {
        const mgr = new FakeManager();
        mgr.addServer("sample", [
            { name: "search_code", inputSchema: {} },
            { name: "dangerous_tool", inputSchema: {} },
            { name: "read_wiki", inputSchema: {} },
        ]);

        const tools = buildMcpToolsForPi({
            mcpManager: mgr as unknown as McpClientManager,
            Type,
            allowedTools: new Set(["search_code", "read_wiki"]),
        });

        assert.equal(tools.length, 2);
        const names = tools.map((t: any) => t.name);
        assert.ok(names.includes("mcp__sample__search_code"));
        assert.ok(names.includes("mcp__sample__read_wiki"));
        assert.ok(!names.includes("mcp__sample__dangerous_tool"));
    });

    test("returns empty array when no servers connected", () => {
        const mgr = new FakeManager();
        const tools = buildMcpToolsForPi({ mcpManager: mgr as unknown as McpClientManager, Type });
        assert.equal(tools.length, 0);
    });

    test("each tool has __tool_use_purpose in its parameters schema", () => {
        const mgr = new FakeManager();
        mgr.addServer("test", [
            { name: "my_tool", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
        ]);

        const tools = buildMcpToolsForPi({ mcpManager: mgr as unknown as McpClientManager, Type });
        const tool = tools[0];
        // The parameter schema is a TypeBox object built with our proxy
        assert.ok(tool.parameters);
        assert.ok(tool.parameters.shape.__tool_use_purpose, "should include __tool_use_purpose");
    });

    test("tool execute forwards to mcpManager.callTool and strips __tool_use_purpose", async () => {
        const mgr = new FakeManager();
        mgr.addServer("sample", [
            { name: "echo", description: "Echo tool", inputSchema: { type: "object", properties: { msg: { type: "string" } } } },
        ]);
        mgr.setToolResult("sample", "echo", {
            content: [{ type: "text", text: "echoed: hello" }],
        });

        // Intercept callTool to verify args
        let capturedArgs: Record<string, unknown> | null = null;
        const origCallTool = mgr.callTool.bind(mgr);
        mgr.callTool = async (serverName, toolName, args) => {
            capturedArgs = args;
            return origCallTool(serverName, toolName, args);
        };

        const tools = buildMcpToolsForPi({ mcpManager: mgr as unknown as McpClientManager, Type });
        const echoPi = tools[0];

        const result = await echoPi.execute("call-1", {
            __tool_use_purpose: "Testing echo",
            msg: "hello",
        });

        // __tool_use_purpose should NOT be forwarded to MCP
        assert.deepEqual(capturedArgs, { msg: "hello" });
        assert.ok(result.content[0].text.includes("echoed: hello"));
    });

    test("tool execute propagates isError from MCP result", async () => {
        const mgr = new FakeManager();
        mgr.addServer("sample", [
            { name: "fail_tool", inputSchema: {} },
        ]);
        mgr.setToolResult("sample", "fail_tool", {
            content: [{ type: "text", text: "access denied" }],
            isError: true,
        });

        const tools = buildMcpToolsForPi({ mcpManager: mgr as unknown as McpClientManager, Type });
        const result = await tools[0].execute("call-2", {});

        assert.equal(result.isError, true);
        assert.ok(result.content[0].text.includes("access denied"));
    });

    test("converts nested JSON Schema to TypeBox", () => {
        const mgr = new FakeManager();
        mgr.addServer("test", [
            {
                name: "complex_tool",
                description: "A tool with complex schema",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: { type: "string", description: "Search query" },
                        limit: { type: "integer", description: "Max results" },
                        verbose: { type: "boolean" },
                        tags: { type: "array", items: { type: "string" } },
                        config: {
                            type: "object",
                            properties: {
                                mode: { type: "string", enum: ["fast", "thorough"] },
                            },
                        },
                    },
                    required: ["query"],
                },
            },
        ]);

        const tools = buildMcpToolsForPi({ mcpManager: mgr as unknown as McpClientManager, Type });
        assert.equal(tools.length, 1);
        const params = tools[0].parameters;
        // Verify the TypeBox proxy captured the shape
        assert.ok(params.shape.query, "should have query parameter");
        assert.ok(params.shape.limit, "should have limit parameter");
        assert.ok(params.shape.verbose, "should have verbose parameter");
        assert.ok(params.shape.tags, "should have tags parameter");
        assert.ok(params.shape.config, "should have config parameter");
    });
});
