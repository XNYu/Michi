import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolRequest, type ListToolsResult, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { resolveCrewMcpEndpoint } from './crewMcpBinding';

export const CREW_MCP_HANDLER_API = 1;

/** Official broker stdio is the trust boundary; this process exposes no HTTP listener. */
export function createCrewMcpRelay(directory?: string, reload?: () => Promise<CrewMcpHandlers>): Server {
    const server = new Server({ name: 'michi-crew', version: '0.3.0' }, { capabilities: {
        tools: {}, experimental: { 'kirocrew.caller-identity': { schemaVersion: 1 } },
    } });
    const handlers = createCrewMcpHandlers(directory);
    server.setRequestHandler(ListToolsRequestSchema, async () => (await reload?.() ?? handlers).listTools());
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
        (await reload?.() ?? handlers).callTool(request, extra.signal));
    return server;
}

export interface CrewMcpHandlers {
    listTools(): Promise<ListToolsResult>;
    callTool(request: CallToolRequest, signal: AbortSignal): Promise<CallToolResult>;
}

/** Stateless request handlers can be replaced without closing broker transport. */
export function createCrewMcpHandlers(directory?: string): CrewMcpHandlers {
    return {
    listTools: async (): Promise<ListToolsResult> => ({ tools: [
        { name: 'michi_list_tools', description: 'Discover the Michi tools available to this exact conversation, including their JSON input schemas. Includes michi_docs: consult bundled docs for Michi usage, setup, permissions and troubleshooting. Call before using michi_call_tool.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
        { name: 'michi_call_tool', description: 'Call a tool returned by michi_list_tools for this conversation. Workspace and node identity are supplied by the host.', inputSchema: {
            type: 'object', properties: { tool: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } }, required: ['tool', 'arguments'], additionalProperties: false,
        } },
    ] }),
    callTool: async (request, signal) => {
        const client = new Client({ name: 'michi-crew-relay', version: '0.3.0' });
        let stage = 'session binding';
        try {
            const url = await resolveCrewMcpEndpoint(request.params._meta, directory);
            stage = 'Michi connection';
            await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { redirect: 'error' } }));
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
            // Paths contain bearer endpoint IDs. Never echo transport errors or binding contents.
            const code = (error as { code?: unknown })?.code;
            const category = ['ENOENT', 'EACCES', 'EPERM', 'ESRCH'].includes(String(code)) ? String(code) : 'unavailable';
            const hasCaller = !!request.params._meta?.['kirocrew.caller'];
            return { isError: true, content: [{ type: 'text', text: `Michi MCP is unavailable for this conversation (${stage}: ${category}; caller identity ${hasCaller ? 'present' : 'missing'}). Check the App MCP Stub setting and send a new turn from Michi to refresh its binding. No other session was used.` }] };
        } finally { await client.close().catch(() => undefined); }
    },
    };
}

export async function runCrewMcpRelay(): Promise<void> {
    await createCrewMcpRelay().connect(new StdioServerTransport());
}
