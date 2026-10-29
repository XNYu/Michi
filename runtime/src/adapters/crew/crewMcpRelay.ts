import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolRequest, type ListToolsResult, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Readable, Writable } from 'node:stream';
import { resolveCrewMcpEndpoint } from './crewMcpBinding';
import { JSON_BODY_LIMIT_BYTES } from '../../core/constants';
import { abortable, withDeadline } from '../../core/runtimeLifecycle';

const MCP_SETUP_TIMEOUT_MS = 30_000;
const MCP_CLEANUP_TIMEOUT_MS = 5_000;

export const CREW_MCP_HANDLER_API = 1;

/** Official broker stdio is the trust boundary; this process exposes no HTTP listener. */
export function createCrewMcpRelay(directory?: string, reload?: () => Promise<CrewMcpHandlers>): Server {
    const server = new Server({ name: 'michi-crew', version: '0.3.0' }, { capabilities: {
        tools: {}, experimental: { 'kirocrew.caller-identity': { schemaVersion: 1 } },
    } });
    const handlers = createCrewMcpHandlers(directory);
    server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
        extra.signal.throwIfAborted();
        return (await reload?.() ?? handlers).listTools();
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
        (await reload?.() ?? handlers).callTool(request, extra.signal));
    return server;
}

export interface CrewMcpHandlers {
    listTools(): Promise<ListToolsResult>;
    callTool(request: CallToolRequest, signal: AbortSignal): Promise<CallToolResult>;
}

/** Stateless request handlers can be replaced without closing broker transport. */
export function createCrewMcpHandlers(directory?: string, lifecycle: {
    setupTimeoutMs?: number; cleanupTimeoutMs?: number;
} = {}): CrewMcpHandlers {
    return {
    listTools: async (): Promise<ListToolsResult> => ({ tools: [
        { name: 'michi_list_tools', description: 'Discover the Michi tools available to this exact conversation, including their JSON input schemas. Includes michi_docs: consult bundled docs for Michi usage, setup, permissions and troubleshooting. Call before using michi_call_tool.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
        { name: 'michi_call_tool', description: 'Call a tool returned by michi_list_tools for this conversation. Workspace and node identity are supplied by the host.', inputSchema: {
            type: 'object', properties: { tool: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } }, required: ['tool', 'arguments'], additionalProperties: false,
        } },
    ] }),
    callTool: async (request, signal) => {
        signal.throwIfAborted();
        const client = new Client({ name: 'michi-crew-relay', version: '0.3.0' });
        let transport: StreamableHTTPClientTransport | undefined;
        const setupTimeout = new AbortController();
        const setupSignal = AbortSignal.any([signal, setupTimeout.signal]);
        const timer = setTimeout(() => setupTimeout.abort(new Error('MCP setup timed out')), (lifecycle.setupTimeoutMs ?? MCP_SETUP_TIMEOUT_MS));
        let stage = 'session binding';
        try {
            const url = await abortable(resolveCrewMcpEndpoint(request.params._meta, directory), setupSignal);
            stage = 'Michi connection';
            transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { redirect: 'error', signal: setupSignal } });
            await abortable(client.connect(transport, { signal: setupSignal, timeout: MCP_SETUP_TIMEOUT_MS }), setupSignal);
            clearTimeout(timer);
            signal.throwIfAborted();
            stage = 'Michi tool request';
            if (request.params.name === 'michi_list_tools') {
                const result = await client.listTools({}, { signal });
                return { content: [{ type: 'text', text: JSON.stringify(result) }] };
            }
            const args = request.params.arguments;
            if (request.params.name !== 'michi_call_tool' || typeof args?.tool !== 'string'
                || !args.arguments || typeof args.arguments !== 'object' || Array.isArray(args.arguments)) throw new Error('Invalid Michi tool request');
            return await client.callTool({ name: args.tool, arguments: args.arguments as Record<string, unknown> }, undefined, { signal }) as CallToolResult;
        } catch (error) {
            signal.throwIfAborted();
            // Paths contain bearer endpoint IDs. Never echo transport errors or binding contents.
            const code = (error as { code?: unknown })?.code;
            const category = ['ENOENT', 'EACCES', 'EPERM', 'ESRCH'].includes(String(code)) ? String(code) : 'unavailable';
            const hasCaller = !!request.params._meta?.['kirocrew.caller'];
            return { isError: true, content: [{ type: 'text', text: `Michi MCP is unavailable for this conversation (${stage}: ${category}; caller identity ${hasCaller ? 'present' : 'missing'}). Check the App MCP Stub setting and send a new turn from Michi to refresh its binding. No other session was used.` }] };
        } finally {
            clearTimeout(timer);
            setupTimeout.abort();
            // Request-owned HTTP connections must not keep a cancelled broker
            // request alive when an SDK/transport close never settles.
            await withDeadline(Promise.allSettled([
                Promise.resolve().then(() => client.close()),
                Promise.resolve().then(() => transport?.close()),
            ]), lifecycle.cleanupTimeoutMs ?? MCP_CLEANUP_TIMEOUT_MS, 'Crew MCP cleanup timed out').catch(() => undefined);
        }
    },
    };
}

/**
 * The broker's stdio, read up to Michi's JSON body limit: the SDK's default
 * of 10 MiB would close the transport, and with it every Michi tool of the
 * session, on a tool call the host behind the relay accepts.
 */
export function createCrewStdioTransport(stdin?: Readable, stdout?: Writable): StdioServerTransport {
    return new StdioServerTransport(stdin, stdout, { maxBufferSize: JSON_BODY_LIMIT_BYTES });
}

export async function runCrewMcpRelay(): Promise<void> {
    await createCrewMcpRelay().connect(createCrewStdioTransport());
}
