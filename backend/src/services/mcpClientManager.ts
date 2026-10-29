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
import { JSON_BODY_LIMIT_BYTES } from "./requestBodyLimit";
import { abortable, withDeadline } from '../agents/runtimeLifecycle';
import { getUserSandboxRoot } from './workspaceSandbox';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import type { JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/types.js';
import { DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/sdk/client/stdio.js';

const MCP_SETUP_TIMEOUT_MS = 30_000;
const MCP_CLEANUP_TIMEOUT_MS = 5_000;
const MCP_MAX_TOOL_PAGES = 100;
const MCP_MAX_TOOLS = 10_000;

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
    outputSchema?: Tool['outputSchema'];
    execution?: Tool['execution'];
    [key: string]: unknown;
}

/** Result of an MCP tool invocation. */
export type McpToolResult = CallToolResult;

export interface McpClientManagerOptions {
    ownerUserId?: string | null;
    /** Only an owner-scoped configuration/credential source may supply this.
     * Process-global desktop MCP configuration must never opt cloud users in. */
    cloudEnvironment?: { ownerUserId: string; env?: Record<string, string> };
}

export function mcpSubprocessEnvironment(config: McpServerConfig, options: McpClientManagerOptions): Record<string, string> {
    if (process.env.MICHI_CLOUD === '1') {
        const policy = options.cloudEnvironment;
        if (!options.ownerUserId || !policy || policy.ownerUserId !== options.ownerUserId) {
            throw Object.assign(new Error('External MCP requires an owner-scoped cloud configuration and credential policy'), { code: 'MCP_CLOUD_POLICY_REQUIRED' });
        }
        if (Object.keys(config.env ?? {}).length) {
            throw new Error('Process-global MCP environment is unavailable in cloud mode; use owner-scoped credentials');
        }
        // StdioClientTransport always merges its own inherited defaults. Empty
        // overrides prevent host USER/LOGNAME/SHELL (and Windows profile paths)
        // from being reintroduced behind the explicit cloud allowlist.
        const suppressedDefaults = Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map(key => [key, '']));
        return { ...suppressedDefaults, PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: process.env.LANG ?? 'en_US.UTF-8',
            NODE_NO_WARNINGS: '1', ...policy.env, HOME: getUserSandboxRoot(options.ownerUserId) };
    }
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    return { ...env, ...config.env };
}

interface ManagedConnection {
    serverName: string;
    client: InstanceType<typeof import("@modelcontextprotocol/sdk/client/index.js").Client>;
    transport: InstanceType<typeof import("@modelcontextprotocol/sdk/client/stdio.js").StdioClientTransport>;
    tools: McpToolInfo[];
    outputValidators: Map<string, JsonSchemaValidator<unknown>>;
}

export class McpClientManager {
    constructor(private readonly options: McpClientManagerOptions = {}) {}
    private connections = new Map<string, ManagedConnection>();
    private readonly connecting = new Map<string, Promise<{ tools: McpToolInfo[] }>>();
    private readonly pendingConnections = new Set<ManagedConnection>();
    // Remember idempotence weakly after a resource has closed. Only unfinished
    // closes need a strong owner; retries must not retain old SDK clients and
    // partially discovered catalogs for the rest of the session.
    private readonly closing = new WeakMap<ManagedConnection, Promise<void>>();
    private readonly closingConnections = new Set<ManagedConnection>();
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

        const transport = new StdioClientTransport({
            command: config.command,
            args: config.args,
            env: mcpSubprocessEnvironment(config, this.options),
            cwd: config.cwd,
            stderr: "pipe",
            // A result the SDK's default 10 MiB read buffer would refuse,
            // closing the server's connection, is one Michi carries elsewhere.
            maxBufferSize: JSON_BODY_LIMIT_BYTES,
        });

        const client = new Client(
            { name: "michi", version: "1.0.0" },
        );
        // Own the transport before either handshake or discovery can suspend.
        const conn: ManagedConnection = { serverName: config.serverName, client, transport, tools: [], outputValidators: new Map() };
        this.pendingConnections.add(conn);

        try {
            await abortable(client.connect(transport, { signal, timeout: MCP_SETUP_TIMEOUT_MS }), signal);
            signal.throwIfAborted();
            let cursor: string | undefined;
            const seen = new Set<string>();
            const names = new Set<string>();
            for (let page = 0; ; page++) {
                if (page >= MCP_MAX_TOOL_PAGES) throw new Error('MCP tool discovery exceeded its page limit');
                const response = await abortable(client.listTools(cursor !== undefined ? { cursor } : undefined, { signal, timeout: MCP_SETUP_TIMEOUT_MS }), signal);
                for (const t of response.tools) {
                    if (names.has(t.name)) throw new Error(`MCP tool discovery returned duplicate tool: ${t.name}`);
                    names.add(t.name);
                    if (names.size > MCP_MAX_TOOLS) throw new Error('MCP tool discovery exceeded its tool limit');
                    conn.tools.push(t);
                    // SDK listTools caches only its latest page. Keep aggregate
                    // validators through the supported public validator provider
                    // so earlier-page output/task contracts remain enforced.
                    if (t.outputSchema) conn.outputValidators.set(t.name,
                        new AjvJsonSchemaValidator().getValidator(t.outputSchema));
                }
                cursor = response.nextCursor;
                if (cursor === undefined) break;
                if (seen.has(cursor)) throw new Error('MCP tool discovery repeated a cursor');
                seen.add(cursor);
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
            const tool = conn.tools.find(tool => tool.name === toolName);
            if (tool?.execution?.taskSupport === 'required') {
                throw new Error(`MCP tool "${toolName}" requires task-based execution, which the Pi bridge does not support`);
            }
            const result = await conn.client.callTool({ name: toolName, arguments: args }, undefined, { signal });
            const validate = conn.outputValidators?.get(toolName);
            if (validate) {
                if (!result.structuredContent && !result.isError) throw new Error(`MCP tool "${toolName}" has an output schema but did not return structured content`);
                if (result.structuredContent) {
                    const validation = validate(result.structuredContent);
                    if (!validation.valid) throw new Error(`MCP structured content does not match the tool's output schema: ${validation.errorMessage}`);
                }
            }
            // SDK validation owns the wire contract. Preserve the entire result,
            // including resource/link metadata, MIME types, structuredContent and _meta.
            return result as CallToolResult;
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
            this.closingConnections.add(conn);
            work = Promise.allSettled([
                Promise.resolve().then(() => conn.client.close()),
                Promise.resolve().then(() => conn.transport.close()),
            ]).then((results) => {
                const failed = results.find((result) => result.status === 'rejected');
                if (failed?.status === 'rejected') throw failed.reason;
                this.pendingConnections.delete(conn);
                this.closingConnections.delete(conn);
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
        const connections = new Set([...this.connections.values(), ...this.pendingConnections, ...this.closingConnections]);
        this.connections.clear();
        this.disposePromise = Promise.all([...connections].map((conn) => this.closeConnection(conn))).then(() => {});
        return this.disposePromise;
    }
}
