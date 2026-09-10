/**
 * McpClientManager — manages stdio MCP Client connections for runtimes
 * (like Pi) that don't have native MCP support.
 *
 * Each "server" is a named stdio child process (e.g. `sample-mcp`).
 * The manager handles:
 *   - Spawning the child process via StdioClientTransport
 *   - Connecting the MCP Client and performing capability negotiation
 *   - Tool discovery via listTools()
 *   - Tool invocation via callTool()
 *   - Graceful shutdown (SIGTERM + timeout)
 *
 * Designed for session-scoped or workspace-scoped lifetime. Callers should
 * call dispose() when the owning session/workspace is destroyed.
 */
import { log } from "./logger";

// Lazy-loaded MCP SDK imports. The SDK is ESM-only and the backend is CJS,
// so we dynamic-import at first use.
let _sdkClientModule: typeof import("@modelcontextprotocol/sdk/client/index.js") | null = null;
let _sdkStdioModule: typeof import("@modelcontextprotocol/sdk/client/stdio.js") | null = null;

async function loadSdkClient() {
    if (!_sdkClientModule) {
        _sdkClientModule = await import("@modelcontextprotocol/sdk/client/index.js");
    }
    return _sdkClientModule;
}

async function loadSdkStdio() {
    if (!_sdkStdioModule) {
        _sdkStdioModule = await import("@modelcontextprotocol/sdk/client/stdio.js");
    }
    return _sdkStdioModule;
}

/** Configuration for a single MCP server to connect to. */
export interface McpServerConfig {
    /** Unique name for this MCP server (e.g. "sample", "sample-docs"). */
    serverName: string;
    /** Executable command (e.g. "sample-mcp"). */
    command: string;
    /** Command-line arguments. */
    args?: string[];
    /** Extra environment variables merged with process.env. */
    env?: Record<string, string>;
    /** Working directory for the child process. */
    cwd?: string;
}

/** A discovered MCP tool, as returned by the server. */
export interface McpToolInfo {
    /** Tool name as declared by the MCP server. */
    name: string;
    /** Human-readable description. */
    description?: string;
    /** JSON Schema for the tool's input parameters. */
    inputSchema: Record<string, unknown>;
}

/** Result of an MCP tool invocation. */
export interface McpToolResult {
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
    isError?: boolean;
}

interface ManagedConnection {
    serverName: string;
    client: InstanceType<typeof import("@modelcontextprotocol/sdk/client/index.js").Client>;
    transport: InstanceType<typeof import("@modelcontextprotocol/sdk/client/stdio.js").StdioClientTransport>;
    tools: McpToolInfo[];
}

export class McpClientManager {
    private connections = new Map<string, ManagedConnection>();
    private disposed = false;

    /**
     * Connect to an MCP server via stdio transport. Idempotent — if a
     * connection with the same serverName already exists, it is returned.
     *
     * Throws if the child process fails to start or capability negotiation
     * fails within the timeout.
     */
    async connect(config: McpServerConfig): Promise<{ tools: McpToolInfo[] }> {
        if (this.disposed) throw new Error("McpClientManager is disposed");

        const existing = this.connections.get(config.serverName);
        if (existing) return { tools: existing.tools };

        const { Client } = await loadSdkClient();
        const { StdioClientTransport } = await loadSdkStdio();

        log.info("mcp", `connecting to MCP server: ${config.serverName}`, {
            command: config.command,
            args: config.args,
        });

        // Build a clean env record with no undefined values (satisfies
        // StdioServerParameters["env"] which requires Record<string, string>).
        const baseEnv: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
            if (v !== undefined) baseEnv[k] = v;
        }
        Object.assign(baseEnv, config.env ?? {});

        const transport = new StdioClientTransport({
            command: config.command,
            args: config.args,
            env: baseEnv,
            cwd: config.cwd,
            stderr: "pipe",
        });

        const client = new Client(
            { name: "michi", version: "1.0.0" },
        );

        try {
            await client.connect(transport);
        } catch (err) {
            log.error("mcp", `failed to connect to ${config.serverName}`, {
                error: (err as Error).message,
            });
            // Clean up partial connection
            try { await transport.close(); } catch { /* ignore */ }
            throw new Error(
                `Failed to connect to MCP server "${config.serverName}" (${config.command}): ${(err as Error).message}`,
            );
        }

        // Discover available tools
        let tools: McpToolInfo[] = [];
        try {
            const response = await client.listTools();
            tools = (response.tools ?? []).map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
            }));
        } catch (err) {
            log.warn("mcp", `listTools failed for ${config.serverName}`, {
                error: (err as Error).message,
            });
            // Non-fatal: the server is connected but has no tools (or hasn't registered them yet).
        }

        log.info("mcp", `connected to ${config.serverName}: ${tools.length} tools discovered`, {
            toolNames: tools.map((t) => t.name),
        });

        const conn: ManagedConnection = { serverName: config.serverName, client, transport, tools };
        this.connections.set(config.serverName, conn);
        return { tools };
    }

    /** List tools from all connected servers, or from a specific server. */
    listTools(serverName?: string): McpToolInfo[] {
        if (serverName) {
            return this.connections.get(serverName)?.tools ?? [];
        }
        const all: McpToolInfo[] = [];
        for (const conn of this.connections.values()) {
            all.push(...conn.tools);
        }
        return all;
    }

    /** Invoke a tool on a connected MCP server. */
    async callTool(
        serverName: string,
        toolName: string,
        args: Record<string, unknown>,
    ): Promise<McpToolResult> {
        const conn = this.connections.get(serverName);
        if (!conn) {
            return {
                content: [{ type: "text", text: `MCP server "${serverName}" is not connected` }],
                isError: true,
            };
        }

        try {
            const result = await conn.client.callTool({ name: toolName, arguments: args });
            // Normalize content to always be an array of { type, text?, ... }
            const content = Array.isArray(result.content)
                ? result.content.map((c: any) => ({
                    type: typeof c.type === "string" ? c.type : "text",
                    ...(typeof c.text === "string" ? { text: c.text } : {}),
                    ...(c.data ? { data: c.data } : {}),
                }))
                : [{ type: "text", text: String(result.content ?? "") }];
            return { content, isError: result.isError === true };
        } catch (err) {
            log.error("mcp", `callTool failed: ${serverName}/${toolName}`, {
                error: (err as Error).message,
            });
            return {
                content: [{ type: "text", text: `MCP tool call failed: ${(err as Error).message}` }],
                isError: true,
            };
        }
    }

    /** Check if a specific server is connected. */
    isConnected(serverName: string): boolean {
        return this.connections.has(serverName);
    }

    /** Get the names of all connected servers. */
    connectedServers(): string[] {
        return [...this.connections.keys()];
    }

    /** Disconnect a single server. */
    async disconnect(serverName: string): Promise<void> {
        const conn = this.connections.get(serverName);
        if (!conn) return;
        this.connections.delete(serverName);
        try {
            await conn.client.close();
        } catch {
            /* ignore close errors */
        }
        try {
            await conn.transport.close();
        } catch {
            /* ignore */
        }
        log.info("mcp", `disconnected from ${serverName}`);
    }

    /** Disconnect all servers and mark this manager as disposed. */
    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        const names = [...this.connections.keys()];
        await Promise.allSettled(names.map((n) => this.disconnect(n)));
    }
}
