/**
 * Tests for mcpToolBridge — verifying JSON Schema → TypeBox conversion,
 * namespacing, allowlist filtering, and tool execution proxy.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildMcpToolsForPi, mcpInputSchemaToTypebox, parseMcpToolName } from "../src/agents/pi/mcpToolBridge";
import type { McpClientManager, McpToolInfo, McpToolResult } from "../src/services/mcpClientManager";

// Minimal TypeBox stand-in (same pattern as piTools.test.ts)
const Type: any = new Proxy({}, {
    get: (_target, prop) => {
        if (prop === "Unsafe") return (schema: any) => schema;
        if (prop === "Object") return (shape: any, _opts?: any) => ({ __tb: "object", shape });
        if (prop === "String") return () => ({ __tb: "string" });
        if (prop === "Number") return () => ({ __tb: "number" });
        if (prop === "Boolean") return () => ({ __tb: "boolean" });
        if (prop === "Null") return () => ({ __tb: "null" });
        if (prop === "Array") return (items: any, opts?: any) => ({ __tb: "array", items, opts });
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
    test("parses namespaced tool names back", () => {
        const parsed = parseMcpToolName("mcp__sample__ReadPages");
        assert.deepEqual(parsed, { serverName: "sample", toolName: "ReadPages" });
    });

    test("parseMcpToolName returns null for non-MCP names", () => {
        assert.equal(parseMcpToolName("read"), null);
        assert.equal(parseMcpToolName("spawn_branches"), null);
        assert.equal(parseMcpToolName("mcp__incomplete"), null);
    });
});

describe("buildMcpToolsForPi", () => {
    test("preserves row-operation unions and typed database value maps", () => {
        const inputSchema = {
            type: "object",
            properties: {
                ops: {
                    type: "array",
                    maxItems: 50,
                    items: {
                        oneOf: [
                            { type: "object", properties: { op: { type: "string", enum: ["row.add"] }, values: {
                                type: "object", additionalProperties: { anyOf: [
                                    { type: "string" }, { type: "number" }, { type: "null" },
                                ] },
                            } }, required: ["op", "values"], additionalProperties: false },
                            { type: "object", properties: { op: { type: "string", enum: ["row.delete"] }, id: { type: "string", maxLength: 200 }, expectRev: { type: "integer", minimum: 1 } },
                                required: ["op", "id", "expectRev"], additionalProperties: false },
                        ],
                    },
                },
            },
            required: ["ops"],
        };
        const schema = mcpInputSchemaToTypebox(inputSchema, Type);

        assert.equal(schema, inputSchema);
        const operationUnion = schema.properties.ops.items;
        assert.equal(schema.properties.ops.maxItems, 50);
        const addOperation = operationUnion.oneOf[0];
        assert.equal(addOperation.additionalProperties, false);
        assert.ok(addOperation.properties.values);
        assert.deepEqual(addOperation.properties.values.additionalProperties.anyOf, [
            { type: "string" }, { type: "number" }, { type: "null" },
        ]);
        assert.deepEqual(operationUnion.oneOf[1].properties.expectRev, { type: "integer", minimum: 1 });
        assert.deepEqual(operationUnion.oneOf[1].properties.id, { type: "string", maxLength: 200 });
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
});
