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
import { abortable, withDeadline } from '../agents/runtimeLifecycle';

const MCP_SETUP_TIMEOUT_MS = 30_000;
const MCP_CLEANUP_TIMEOUT_MS = 5_000;

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
    private readonly connecting = new Map<string, Promise<{ tools: McpToolInfo[] }>>();
    private readonly pendingConnections = new Set<ManagedConnection>();
    private readonly closing = new Map<ManagedConnection, Promise<void>>();
    private readonly lifetimeAbort = new AbortController();
    private disposePromise: Promise<void> | undefined;
    private cleanupError: Error | undefined;
    private disposed = false;

    /**
     * Connect to an MCP server via stdio transport. Idempotent — if a
     * connection with the same serverName already exists, it is returned.
     *
     * Throws if the child process fails to start or capability negotiation
     * fails within the timeout.
     */
    async connect(config: McpServerConfig, signal?: AbortSignal): Promise<{ tools: McpToolInfo[] }> {
        if (this.disposed) throw new Error("McpClientManager is disposed");
        if (this.cleanupError) throw this.cleanupError;
        signal?.throwIfAborted();

        const existing = this.connections.get(config.serverName);
        if (existing) return { tools: existing.tools };
        const pending = this.connecting.get(config.serverName);
        if (pending) return signal ? abortable(pending, signal) : pending;

        const timeout = new AbortController();
        const setupSignal = AbortSignal.any([this.lifetimeAbort.signal, timeout.signal, ...(signal ? [signal] : [])]);
        const timer = setTimeout(() => timeout.abort(new Error(`MCP setup timed out: ${config.serverName}`)), MCP_SETUP_TIMEOUT_MS);
        const work = this.openConnection(config, setupSignal).finally(() => clearTimeout(timer));
        this.connecting.set(config.serverName, work);
        const clear = () => { if (this.connecting.get(config.serverName) === work) this.connecting.delete(config.serverName); };
        void work.then(clear, clear);
        return work;
    }

    private async openConnection(config: McpServerConfig, signal: AbortSignal): Promise<{ tools: McpToolInfo[] }> {
        const { Client } = await abortable(loadSdkClient(), signal);
        const { StdioClientTransport } = await abortable(loadSdkStdio(), signal);
        signal.throwIfAborted();

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
        // Own the transport before either handshake or discovery can suspend.
        const conn: ManagedConnection = { serverName: config.serverName, client, transport, tools: [] };
        this.pendingConnections.add(conn);

        try {
            await abortable(client.connect(transport, { signal, timeout: MCP_SETUP_TIMEOUT_MS }), signal);
            signal.throwIfAborted();
            try {
                const response = await abortable(client.listTools(undefined, { signal, timeout: MCP_SETUP_TIMEOUT_MS }), signal);
                conn.tools = (response.tools ?? []).map((t) => ({
                    name: t.name,
                    description: t.description,
                    inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
                }));
            } catch (err) {
                signal.throwIfAborted();
                log.warn('mcp', `listTools failed for ${config.serverName}`, { error: (err as Error).message });
            }
            signal.throwIfAborted();
            this.connections.set(config.serverName, conn);
            this.pendingConnections.delete(conn);
            log.info('mcp', `connected to ${config.serverName}: ${conn.tools.length} tools discovered`, {
                toolNames: conn.tools.map((tool) => tool.name),
            });
            return { tools: conn.tools };
        } catch (err) {
            await this.closeConnection(conn);
            signal.throwIfAborted();
            throw new Error(
                `Failed to connect to MCP server "${config.serverName}" (${config.command}): ${(err as Error).message}`,
            );
        }
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
        signal?: AbortSignal,
    ): Promise<McpToolResult> {
        signal?.throwIfAborted();
        const conn = this.connections.get(serverName);
        if (!conn) {
            return {
                content: [{ type: "text", text: `MCP server "${serverName}" is not connected` }],
                isError: true,
            };
        }

        try {
            const result = await conn.client.callTool({ name: toolName, arguments: args }, undefined, { signal });
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
            signal?.throwIfAborted();
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
        await this.closeConnection(conn);
        log.info("mcp", `disconnected from ${serverName}`);
    }

    private closeConnection(conn: ManagedConnection): Promise<void> {
        let work = this.closing.get(conn);
        if (!work) {
            work = Promise.allSettled([
                Promise.resolve().then(() => conn.client.close()),
                Promise.resolve().then(() => conn.transport.close()),
            ]).then((results) => {
                const failed = results.find((result) => result.status === 'rejected');
                if (failed?.status === 'rejected') throw failed.reason;
                this.pendingConnections.delete(conn);
            });
            this.closing.set(conn, work);
        }
        return withDeadline(work, MCP_CLEANUP_TIMEOUT_MS, `MCP cleanup timed out: ${conn.serverName}`)
            .catch((cause) => {
                this.cleanupError = Object.assign(new Error(`MCP cleanup could not be confirmed: ${conn.serverName}`), {
                    code: 'MCP_CLEANUP_TIMEOUT', cause,
                });
                throw this.cleanupError;
            });
    }

    /** Disconnect all servers and mark this manager as disposed. */
    dispose(): Promise<void> {
        if (this.disposePromise) return this.disposePromise;
        this.disposed = true;
        this.lifetimeAbort.abort();
        const connections = new Set([...this.connections.values(), ...this.pendingConnections, ...this.closing.keys()]);
        this.connections.clear();
        this.disposePromise = Promise.all([...connections].map((conn) => this.closeConnection(conn))).then(() => {});
        return this.disposePromise;
    }
}
