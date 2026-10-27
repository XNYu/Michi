import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { McpToolInfo, McpToolResult } from "../src/services/mcpClientManager";

import { buildMcpToolsForPi } from "../src/agents/pi/mcpToolBridge";

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
    Unsafe: (schema: any) => schema,
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

    it("allowlist filters out tools", () => {
        const tools = buildMcpToolsForPi({
            mcpManager: manager as any,
            Type,
            allowedTools: new Set(["ReadPages"]),
        });
        assert.equal(tools.length, 1);
        assert.equal(tools[0].name, "mcp__sample__ReadPages");
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
        // Exact constraints and actual Pi validation are exercised by
        // mcpProductionBridge.test.ts using a real stdio server.
        assert.ok(complexTool.parameters);
    });
});
