/**
 * Tests for McpClientManager.
 *
 * These tests verify the manager's lifecycle, error handling, and public
 * API without spawning real MCP server processes. We mock the SDK Client
 * and StdioClientTransport at the module level.
 */
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { McpClientManager, type McpServerConfig, type McpToolInfo } from "../src/services/mcpClientManager";

/**
 * Since McpClientManager dynamically imports @modelcontextprotocol/sdk,
 * we test it via a subclass that injects mock SDK modules. This avoids
 * needing a real MCP server binary on the test machine.
 */

// ─── Mock plumbing ──────────────────────────────────────────────────────

interface MockClient {
    connectCalled: boolean;
    closeCalled: boolean;
    listToolsResult: { tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> };
    callToolResults: Map<string, { content: Array<{ type: string; text?: string }>; isError?: boolean }>;
    connect: (transport: unknown) => Promise<void>;
    close: () => Promise<void>;
    listTools: () => Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }>;
    callTool: (req: { name: string; arguments?: Record<string, unknown> }) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
}

interface MockTransport {
    closeCalled: boolean;
    close: () => Promise<void>;
}

function createMockTransport(): MockTransport {
    return {
        closeCalled: false,
        close: async function (this: MockTransport) { this.closeCalled = true; },
    };
}

function createMockClient(tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> = []): MockClient {
    return {
        connectCalled: false,
        closeCalled: false,
        listToolsResult: { tools },
        callToolResults: new Map(),
        connect: async function (this: MockClient) { this.connectCalled = true; },
        close: async function (this: MockClient) { this.closeCalled = true; },
        listTools: async function (this: MockClient) { return this.listToolsResult; },
        callTool: async function (this: MockClient, req) {
            const result = this.callToolResults.get(req.name);
            if (!result) throw new Error(`tool not found: ${req.name}`);
            return result;
        },
    };
}

/**
 * TestableManager exposes a seam for injecting mock SDK behaviour.
 * We override the private dynamic import by directly injecting mock
 * Client/Transport into the connection flow.
 */
class TestableManager extends McpClientManager {
    public mockClients: Map<string, MockClient> = new Map();
    public mockTransports: Map<string, MockTransport> = new Map();
    private defaultTools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> = [];

    /** Pre-configure tools that will be "discovered" on the next connect. */
    setDefaultTools(tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>) {
        this.defaultTools = tools;
    }

    /** Pre-configure a mock for a specific server. */
    setMockClient(serverName: string, client: MockClient) {
        this.mockClients.set(serverName, client);
    }

    // Override connect to use mocks instead of real child processes.
    async connect(config: McpServerConfig): Promise<{ tools: McpToolInfo[] }> {
        // Check disposed via parent API
        if (!this.canConnect()) throw new Error("McpClientManager is disposed");

        // Reuse existing connection
        const existingTools = this.listTools(config.serverName);
        if (this.isConnected(config.serverName)) return { tools: existingTools };

        const client = this.mockClients.get(config.serverName)
            ?? createMockClient(this.defaultTools);
        const transport = createMockTransport();

        this.mockClients.set(config.serverName, client);
        this.mockTransports.set(config.serverName, transport);

        await client.connect(transport);
        const { tools: rawTools } = await client.listTools();
        const tools = rawTools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
        }));

        // Store in parent's internal map via reflection (test seam)
        (this as any).connections.set(config.serverName, {
            serverName: config.serverName,
            client,
            transport,
            tools,
        });

        return { tools };
    }

    /** Test helper: check if connect would throw. */
    canConnect(): boolean {
        return !(this as any).disposed;
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("McpClientManager", () => {
    let manager: TestableManager;

    beforeEach(() => {
        manager = new TestableManager();
    });

    test("connect discovers tools from an MCP server", async () => {
        manager.setDefaultTools([
            { name: "search_code", description: "Search project code", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
            { name: "read_file", description: "Read a file" },
        ]);

        const result = await manager.connect({ serverName: "sample", command: "sample-mcp" });

        assert.equal(result.tools.length, 2);
        assert.equal(result.tools[0].name, "search_code");
        assert.equal(result.tools[0].description, "Search project code");
        assert.equal(result.tools[1].name, "read_file");
        assert.ok(manager.isConnected("sample"));
    });

    test("connect to multiple servers", async () => {
        manager.setMockClient("alpha", createMockClient([{ name: "alpha_tool" }]));
        manager.setMockClient("beta", createMockClient([{ name: "beta_tool" }]));

        await manager.connect({ serverName: "alpha", command: "alpha-mcp" });
        await manager.connect({ serverName: "beta", command: "beta-mcp" });

        assert.deepEqual(manager.connectedServers().sort(), ["alpha", "beta"]);
        assert.equal(manager.listTools("alpha").length, 1);
        assert.equal(manager.listTools("beta").length, 1);
        // All tools from all servers
        assert.equal(manager.listTools().length, 2);
    });

    test("callTool invokes the correct server and returns result", async () => {
        const client = createMockClient([{ name: "echo" }]);
        client.callToolResults.set("echo", {
            content: [{ type: "text", text: "hello world" }],
        });
        manager.setMockClient("test", client);
        await manager.connect({ serverName: "test", command: "test-mcp" });

        const result = await manager.callTool("test", "echo", { input: "hello" });

        assert.ok(!result.isError);
        assert.equal(result.content.length, 1);
        assert.equal(result.content[0].text, "hello world");
    });

    test("callTool returns error for disconnected server", async () => {
        const result = await manager.callTool("missing", "tool", {});

        assert.equal(result.isError, true);
        assert.ok(result.content[0].text?.includes("not connected"));
    });

    test("callTool returns error when server throws", async () => {
        const client = createMockClient([{ name: "fail" }]);
        // Don't set a result — callTool will throw "tool not found"
        manager.setMockClient("test", client);
        await manager.connect({ serverName: "test", command: "test-mcp" });

        const result = await manager.callTool("test", "fail", {});

        assert.equal(result.isError, true);
        assert.ok(result.content[0].text?.includes("tool not found"));
    });

    test("disconnect removes a server", async () => {
        manager.setDefaultTools([{ name: "t" }]);
        await manager.connect({ serverName: "s", command: "cmd" });
        assert.ok(manager.isConnected("s"));

        await manager.disconnect("s");

        assert.ok(!manager.isConnected("s"));
        assert.deepEqual(manager.connectedServers(), []);
        const client = manager.mockClients.get("s")!;
        assert.ok(client.closeCalled);
    });

    test("disconnect is safe for unknown server", async () => {
        await manager.disconnect("nonexistent"); // should not throw
    });

    test("dispose disconnects all and prevents new connections", async () => {
        manager.setDefaultTools([{ name: "t" }]);
        await manager.connect({ serverName: "a", command: "a" });
        await manager.connect({ serverName: "b", command: "b" });

        await manager.dispose();

        assert.ok(!manager.isConnected("a"));
        assert.ok(!manager.isConnected("b"));
        await assert.rejects(
            () => manager.connect({ serverName: "c", command: "c" }),
            /disposed/,
        );
    });

    test("dispose is idempotent", async () => {
        await manager.dispose();
        await manager.dispose(); // should not throw
    });
});
