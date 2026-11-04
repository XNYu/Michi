/**
 * mcpToolBridge — converts MCP tools discovered by McpClientManager into
 * Pi-compatible AgentTool[] entries that can be appended to buildPiTools().
 *
 * Each MCP tool is namespaced as `mcp__{serverName}__{toolName}` to avoid
 * collisions with built-in Michi tools.
 *
 * The bridge also supports an optional allowlist for filtering which MCP
 * tools are exposed to the model (important for weak models that can't
 * handle 30+ tool schemas without hallucinating).
 */
import type { McpClientManager, McpToolResult } from "../../services/mcpClientManager";

/** Options for building MCP tool wrappers. */
export interface McpToolBridgeOpts {
    /** The MCP Client Manager holding active connections. */
    mcpManager: McpClientManager;
    /** TypeBox `Type` namespace from pi-ai (for schema construction). */
    Type: any;
    /**
     * Optional allowlist of MCP tool names (without namespace prefix).
     * When set, only tools whose original name appears here are included.
     * When absent, all discovered tools are included.
     */
    allowedTools?: ReadonlySet<string>;
}

/** Preserve external JSON Schema verbatim. Adding a purpose property changes
 * arbitrary objects, additionalProperties:false, refs and conditional schemas.
 * Type.Unsafe is the Pi/TypeBox escape hatch for an existing JSON Schema. */
export function mcpInputSchemaToTypebox(inputSchema: Record<string, unknown>, Type: any): any {
    return Type.Unsafe(inputSchema);
}

/** Pi natively accepts text and images. Other MCP content stays in details and
 * receives an explicit textual projection so a successful resource/structured
 * result never appears empty to the model. */
function projectMcpResult(result: McpToolResult): any[] {
    const content: any[] = [];
    for (const block of result.content) {
        if (block.type === "text") content.push({ type: "text", text: block.text });
        else if (block.type === "image") content.push({ type: "image", data: block.data, mimeType: block.mimeType });
        else if (block.type === "resource" && "text" in block.resource) {
            content.push({ type: "text", text: `Resource ${block.resource.uri}:\n${block.resource.text}` });
        } else if (block.type === "resource_link") {
            content.push({ type: "text", text: `Resource link: ${JSON.stringify(block)}` });
        } else {
            // Binary audio/resources are unsupported by Pi tool messages. Do not
            // dump base64 into model text; preserve it losslessly in mcpResult.
            const { data: _data, ...metadata } = block as Record<string, unknown>;
            if (metadata.resource && typeof metadata.resource === 'object') {
                const { blob: _blob, ...resource } = metadata.resource as Record<string, unknown>;
                metadata.resource = resource;
            }
            content.push({ type: "text", text: `MCP ${block.type} content (binary retained in tool details): ${JSON.stringify(metadata)}` });
        }
    }
    if (result.structuredContent !== undefined) content.push({ type: "text", text: `Structured result: ${JSON.stringify(result.structuredContent)}` });
    return content.length ? content : [{ type: "text", text: "(no text content; MCP returned no content)" }];
}

/**
 * Format the MCP tool name for registration in pi-agent-core.
 * Uses double-underscore as separator: `mcp__sample__ReadPages`
 */
export function mcpToolName(serverName: string, toolName: string): string {
    return `mcp__${serverName}__${toolName}`;
}

/**
 * Parse a namespaced MCP tool name back into (serverName, originalToolName).
 * Returns null if the name doesn't match the `mcp__*__*` pattern.
 */
export function parseMcpToolName(name: string): { serverName: string; toolName: string } | null {
    const match = name.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
    if (!match) return null;
    return { serverName: match[1], toolName: match[2] };
}

/** Name of Pi's tool-discovery tool (pi-coding-agent createToolSearchExtension). */
export const PI_TOOL_SEARCH_TOOL_NAME = "tool_search";

/**
 * MCP definitions at or above this estimate are deferred in "auto" mode. A
 * few small servers stay declared, since deferral costs one search call; a
 * large catalog (spec-studio alone is 100+ tools) is resent every request.
 */
export const MCP_TOOL_SEARCH_AUTO_TOKENS = 10_000;

/** Rough token estimate of the declarations a model request carries. */
export function estimateToolDefinitionTokens(tools: readonly any[]): number {
    let chars = 0;
    for (const tool of tools) chars += JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length;
    return Math.ceil(chars / 4);
}

/**
 * Whether a session's MCP tools go behind tool_search. MICHI_PI_TOOL_SEARCH:
 * "0"/"off" never, "1"/"on" always, otherwise (auto) when the definitions
 * are large. An Agent Run tool allowlist is an explicit loadout and stays
 * declared: tool_search is not on it.
 */
export function shouldDeferMcpTools(opts: { tools: readonly any[]; mode?: string; allowlisted: boolean }): boolean {
    const mode = (opts.mode ?? "auto").trim().toLowerCase();
    if (opts.allowlisted || opts.tools.length === 0 || mode === "0" || mode === "off" || mode === "false") return false;
    if (mode === "1" || mode === "on" || mode === "true" || mode === "always") return true;
    return estimateToolDefinitionTokens(opts.tools) >= MCP_TOOL_SEARCH_AUTO_TOKENS;
}

/**
 * The same MCP tools with Pi's `deferred` exposure: registered and callable,
 * declared to the model only after tool_search loads them. The namespace lets
 * a search for the server name find its tools.
 */
export function deferMcpTools(tools: readonly any[]): any[] {
    return tools.map((tool) => {
        const parsed = parseMcpToolName(tool.name);
        if (!parsed) return tool;
        return {
            ...tool, exposure: "deferred",
            namespace: { name: `mcp__${parsed.serverName}`, aliases: [parsed.serverName], description: `MCP server ${parsed.serverName}` },
        };
    });
}

/** Maximum characters of the deferred-server system prompt section. */
const MAX_DEFERRED_SECTION_CHARS = 4096;

/**
 * The system prompt section naming the servers whose tools are deferred.
 * tool_search does not list them, so without it the model cannot know which
 * capabilities exist. Undefined when nothing is deferred.
 */
export function renderDeferredMcpSection(tools: readonly any[]): string | undefined {
    const counts = new Map<string, number>();
    for (const tool of tools) {
        if (tool.exposure !== "deferred") continue;
        const server = parseMcpToolName(tool.name)?.serverName;
        if (server) counts.set(server, (counts.get(server) ?? 0) + 1);
    }
    if (counts.size === 0) return undefined;
    const intro = `MCP servers whose tools are not declared to you yet. Load the ones a task needs with \`${PI_TOOL_SEARCH_TOOL_NAME}\` (search by task words or the server name); loaded tools stay available for the rest of the conversation.`;
    const lines = [...counts].sort(([a], [b]) => a.localeCompare(b))
        .map(([server, count]) => `- ${server} (${count} tool${count === 1 ? "" : "s"})`);
    let text = [intro, ...lines].join("\n");
    while (text.length > MAX_DEFERRED_SECTION_CHARS && lines.length > 1) {
        lines.pop();
        text = [intro, ...lines, `- … more servers; find their tools with \`${PI_TOOL_SEARCH_TOOL_NAME}\``].join("\n");
    }
    return text;
}

/**
 * Build Pi-compatible AgentTool entries for all MCP tools from all connected
 * servers. Returns an array that can be spread into the buildPiTools result.
 */
export function buildMcpToolsForPi(opts: McpToolBridgeOpts): any[] {
    const { mcpManager, Type, allowedTools } = opts;
    const tools: any[] = [];

    for (const serverName of mcpManager.connectedServers()) {
        const mcpTools = mcpManager.listTools(serverName);
        for (const mcpTool of mcpTools) {
            // Pi's regular tool executor cannot own MCP task streams.
            if (mcpTool.execution?.taskSupport === 'required') continue;
            // Apply allowlist filter
            if (allowedTools && !allowedTools.has(mcpTool.name)) continue;

            const name = mcpToolName(serverName, mcpTool.name);
            const parameters = mcpInputSchemaToTypebox(mcpTool.inputSchema, Type);

            tools.push({
                name,
                label: mcpTool.name,
                description: mcpTool.description ?? `MCP tool: ${mcpTool.name} (from ${serverName})`,
                parameters,
                execute: async (_id: string, args: Record<string, unknown>, signal?: AbortSignal) => {
                    signal?.throwIfAborted();
                    const result = await mcpManager.callTool(serverName, mcpTool.name, args, signal);
                    return {
                        content: projectMcpResult(result),
                        details: { serverName, toolName: mcpTool.name, isError: result.isError, mcpResult: result },
                        isError: result.isError,
                    };
                },
            });
        }
    }

    return tools;
}
