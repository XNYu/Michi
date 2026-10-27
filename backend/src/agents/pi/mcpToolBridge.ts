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
