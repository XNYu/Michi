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
import type { McpClientManager, McpToolInfo } from "../../services/mcpClientManager";

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

/**
 * Convert a JSON Schema property definition into a TypeBox schema.
 * Handles string, number, integer, boolean, array, and object types.
 * Falls back to Type.Unknown() for unrecognized shapes.
 */
function jsonSchemaPropertyToTypebox(prop: Record<string, unknown>, Type: any): any {
    const type = prop.type as string | undefined;
    const description = prop.description as string | undefined;

    let schema: any;

    switch (type) {
        case "string":
            if (Array.isArray(prop.enum)) {
                schema = prop.enum.length > 0
                    ? Type.Union(prop.enum.map((v: unknown) => Type.Literal(v)))
                    : Type.String();
            } else {
                schema = Type.String();
            }
            break;
        case "number":
        case "integer":
            schema = Type.Number();
            break;
        case "boolean":
            schema = Type.Boolean();
            break;
        case "array":
            schema = Type.Array(
                prop.items && typeof prop.items === "object"
                    ? jsonSchemaPropertyToTypebox(prop.items as Record<string, unknown>, Type)
                    : Type.Unknown(),
            );
            break;
        case "object": {
            const properties = prop.properties as Record<string, unknown> | undefined;
            const required = new Set(Array.isArray(prop.required) ? prop.required : []);
            if (properties && typeof properties === "object") {
                const shape: Record<string, any> = {};
                for (const [k, v] of Object.entries(properties)) {
                    if (v && typeof v === "object") {
                        const inner = jsonSchemaPropertyToTypebox(v as Record<string, unknown>, Type);
                        shape[k] = required.has(k) ? inner : Type.Optional(inner);
                    }
                }
                schema = Type.Object(shape);
            } else {
                // Generic object — accept anything
                schema = Type.Object({}, { additionalProperties: true });
            }
            break;
        }
        default:
            schema = Type.Unknown();
    }

    if (description && schema) {
        schema = { ...schema, description };
    }
    return schema;
}

/**
 * Convert an MCP tool's inputSchema (JSON Schema) into a TypeBox Object.
 */
function mcpInputSchemaToTypebox(inputSchema: Record<string, unknown>, Type: any): any {
    const properties = inputSchema.properties as Record<string, unknown> | undefined;
    const required = new Set(Array.isArray(inputSchema.required) ? inputSchema.required : []);

    if (!properties || typeof properties !== "object") {
        // No properties — just pass a __tool_use_purpose field
        return Type.Object({
            __tool_use_purpose: {
                ...Type.String(),
                description: "One short sentence stating why you're calling this tool.",
            },
        });
    }

    const shape: Record<string, any> = {
        __tool_use_purpose: {
            ...Type.String(),
            description: "One short sentence stating why you're calling this tool.",
        },
    };
    for (const [k, v] of Object.entries(properties)) {
        if (v && typeof v === "object") {
            const inner = jsonSchemaPropertyToTypebox(v as Record<string, unknown>, Type);
            shape[k] = required.has(k) ? inner : Type.Optional(inner);
        }
    }
    return Type.Object(shape);
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
            // Apply allowlist filter
            if (allowedTools && !allowedTools.has(mcpTool.name)) continue;

            const name = mcpToolName(serverName, mcpTool.name);
            const parameters = mcpInputSchemaToTypebox(mcpTool.inputSchema, Type);

            tools.push({
                name,
                label: mcpTool.name,
                description: mcpTool.description ?? `MCP tool: ${mcpTool.name} (from ${serverName})`,
                parameters,
                execute: async (_id: string, args: Record<string, unknown>) => {
                    // Strip the __tool_use_purpose field before forwarding
                    const { __tool_use_purpose, ...cleanArgs } = args;
                    const result = await mcpManager.callTool(serverName, mcpTool.name, cleanArgs);
                    // Flatten text content into a single string for the model
                    const textParts = result.content
                        .filter((c) => c.type === "text" && typeof c.text === "string")
                        .map((c) => c.text!);
                    return {
                        content: [{ type: "text", text: textParts.join("\n") || "(no text content)" }],
                        details: { serverName, toolName: mcpTool.name, isError: result.isError },
                        isError: result.isError,
                    };
                },
            });
        }
    }

    return tools;
}
