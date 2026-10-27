import { openUrlTool } from '../agents/openUrlTool';
import { readConversationUpdatesTool } from '../agents/conversationUpdatesTool';
import { isRunOwner, chatNodeOf, hostOwner, runIdOfOwner } from '../agents/ownerMapping';
import { reportConversationNoChange } from './scheduledJobs/conversationBatch';
import { michiDocsTool } from './michiDocs';
import { PAGE_TOOL_NAMES, type ActivePageTurnAttributionGetter, type PageToolName } from '../agents/pageToolNames';
import { runPageTool } from '../agents/pageTools';
import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
    getParseErrorMessage,
    normalizeObjectSchema,
    objectFromShape,
    safeParseAsync,
    type AnySchema,
    type ZodRawShapeCompat,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import {
    createMcpHost,
    createMcpSlotProvider,
    type HostToolDef,
    type JsonSchemaObject,
    type McpHost,
    type McpHostHandler,
    type SessionToolSink,
    type ToolAnnotations,
    type ToolResult,
} from "michi-runtime/internal/mcp-host/index";
import { mcpSlotProviderInternals } from "michi-runtime/internal/mcp-host/slotProviderInternals";
import { z } from "zod";
import { listThreads, searchMessages, readNode, readNodeOverview } from "./globalContext";
import { getNodeSessionBinding } from "./dbRepository";
import {
    listEnabledBuiltinTools,
    AGENT_RUN_TOOL_DEFINITIONS,
    SUBMIT_AGENT_RESULT_DEFINITION,
    type BuiltinTool,
    type ParamField,
    type ParamObjectShape,
    type ParamSpec,
} from "../agents/builtinTools";
import { isAssistantWorkspace } from "../assistant/identity";
import { ASSISTANT_TOOLS, runAssistantTool } from "../assistant/tools";
import {
    inspectPaneTool,
    readPaneOutputTool,
    listPanesTool,
    waitPaneTool,
    type PaneInspectionToolBinding,
} from "../agents/paneInspectionTools";
import {
    SEND_TO_THREAD_TOOL,
    askUserThreadMessageApprover,
    sendToThreadTool,
} from "../agents/threadMessageTool";
import {
    askUserScheduledJobApprover,
    isScheduledJobToolName,
    scheduledJobTool,
} from "../agents/scheduledJobTools";
import {
    AGENT_RUN_TOOL_NAMES,
    SUBMIT_AGENT_RESULT_TOOL,
    type AgentRunToolName,
    type AgentRunToolInvoker,
    type BridgeContextResult,
} from "michi-runtime/internal/contract/tools";
import type {
    McpHttpEndpoint,
    McpSlot as RuntimeMcpSlot,
    McpSlotCallbacks as RuntimeMcpSlotCallbacks,
    McpSlotProvider,
    McpSlotRebindPatch,
} from "michi-runtime/internal/contract/mcp";
import type { MichiHostEvent } from "../agents/hostEvents";
import type { RuntimeSessionOwner, MaintenanceExecutionContext } from "../agents/types";
import { createMaintenanceTools } from './pages/maintenanceTools';
import { META_AGENT_MAINTENANCE_TOOL_NAMES } from '../agents/maintenancePolicy';
import { log } from "./logger";
import { JSON_BODY_LIMIT_BYTES } from "./requestBodyLimit";
import { isLoopbackAddress } from "./remoteAccess";
import { fullNodeSummaryExperimentEnabled, FULL_NODE_SUMMARY_INSTRUCTION } from "../agents/nodeSummaryExperiment";

function paramToZod(spec: ParamSpec): z.ZodTypeAny {
    if (spec === "string") return z.string();
    if (spec === "number") return z.number();
    if (spec === "integer") return z.number().int();
    if (spec === "boolean") return z.boolean();
    if ("array" in spec) return z.array(spec.array === "string" && spec.itemMinLength !== undefined ? z.string().min(spec.itemMinLength) : paramToZod(spec.array));
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [k, v] of Object.entries(spec.object)) shape[k] = fieldToZod(v);
    return spec.additionalProperties ? z.object(shape).passthrough() : z.object(shape);
}

function fieldToZod(field: ParamField): z.ZodTypeAny {
    let schema: z.ZodTypeAny;
    if (field.enum && field.type === "string") {
        // z.enum requires a non-empty tuple; fall back to z.string() for empty inputs (shouldn't occur).
        schema = field.enum.length > 0
            ? z.enum(field.enum as unknown as [string, ...string[]])
            : z.string();
    } else {
        schema = paramToZod(field.type);
    }
    if (field.const !== undefined) schema = z.literal(field.const);
    if (schema instanceof z.ZodNumber) {
        if (field.minimum !== undefined) schema = schema.min(field.minimum);
        if (field.maximum !== undefined) schema = (schema as z.ZodNumber).max(field.maximum);
    }
    if (schema instanceof z.ZodString && field.minLength !== undefined) schema = schema.min(field.minLength);
    if (schema instanceof z.ZodArray && field.minItems !== undefined) schema = schema.min(field.minItems);
    if (field.description) schema = schema.describe(field.description);
    return field.optional ? schema.optional() : schema;
}

function paramObjectToZodShape(parameters: ParamObjectShape): Record<string, z.ZodTypeAny> {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [k, v] of Object.entries(parameters.object)) shape[k] = fieldToZod(v);
    return shape;
}

function builtinToZodShape(tool: BuiltinTool): Record<string, z.ZodTypeAny> {
    return paramObjectToZodShape(tool.parameters);
}

// The slot binding and its callbacks are the runtime package's MCP slot
// contract (runtime/src/contract/mcp.ts); re-exported so existing imports keep working.
export interface McpSlot extends RuntimeMcpSlot {
    /** Public ACP adapters backfill tool cards when a CLI omits the actual output. */
    onMcpToolResult?: (toolName: string, result: unknown) => void;
}
export interface McpSlotCallbacks extends RuntimeMcpSlotCallbacks {
    onMcpToolResult?: McpSlot['onMcpToolResult'];
}

function notifyMcpToolResult(slot: McpSlot, toolName: string, result: unknown): void {
    if (!slot.onMcpToolResult) return;
    setImmediate(() => {
        try {
            slot.onMcpToolResult?.(toolName, result);
        } catch {
            // UI backfill is best-effort; never change the MCP response.
        }
    });
}

const MCP_SERVER_NAME = "michi-tools";
const MCP_SERVER_VERSION = "1.0.0";
/** Description of the session group's routing argument; Kiro's per-turn context names the current SessionID. */
const SESSION_ANCHOR_DESCRIPTION = "Current ACP SessionID from the latest Michi session context.";
const CODEX_STOP_HOOK = "stop";
/** Where a tool's reports go when its call has no session sink (buildMcpServerForSlot): dropped. */
const NO_HOST_EVENTS: SessionToolSink = { emit: () => {} };
/** The backend's port when none is given, as in server.ts (PORT || 3000) and the runtime factories. */
const DEFAULT_MCP_PORT = 3000;

/**
 * Michi's MCP slots: the runtime package's slot provider
 * (createMcpSlotProvider) on its MCP host, which serves Michi's tool catalog
 * and the Codex Stop hook. Slot ids, session-group routing and turn windows
 * live in the host; the provider keeps the slots and groups.
 */
export class McpSlotRegistry implements McpSlotProvider {
    private readonly host: McpHost<McpSlot>;
    private readonly mcpPort: () => number;
    private readonly provider: McpSlotProvider;

    /**
     * `mcpPort` is the backend's HTTP port, where mountMcp's routes are
     * served; the runtime factories receive the same number as
     * RuntimeFactoryDeps.mcpPort. Default 3000. A function is read each time
     * a URL is built, so a caller can create the registry before its server
     * has bound a port (tests listening on port 0) and still keep one source
     * for the port.
     */
    constructor(options: { mcpPort?: number | (() => number) } = {}) {
        const mcpPort = options.mcpPort ?? DEFAULT_MCP_PORT;
        this.mcpPort = typeof mcpPort === "function" ? mcpPort : () => mcpPort;
        this.host = createMcpHost<McpSlot>({
            basePath: "/mcp",
            publicBaseUrl: () => this.baseUrl,
            serverName: MCP_SERVER_NAME,
            serverVersion: MCP_SERVER_VERSION,
            maxBodyBytes: JSON_BODY_LIMIT_BYTES,
            log: (level, msg, data) => log[level]("mcp", msg, data),
        });
        this.host.registerToolSource((view) => michiToolCatalog(view.binding).map(hostToolDef));
        this.host.registerHook(CODEX_STOP_HOOK, async (view, body) => {
            const result = codexStopHookResult(view.binding, body);
            log.debug("mcp", "codex follow-ups hook poc validator request", {
                nodeId: view.binding.nodeId ?? null,
                decision: typeof result.decision === "string" ? result.decision : "allow",
                stopHookActive: !!body && typeof body === "object"
                    ? (body as Record<string, unknown>).stop_hook_active === true
                    : false,
            });
            return result;
        });
        this.provider = createMcpSlotProvider(this.host, {
            sessionAnchorDescription: SESSION_ANCHOR_DESCRIPTION,
            // mountMcp's Express route `/api/codex-hooks/<slotId>/stop`, not the
            // host's `/mcp-hooks` route: it answers an unknown slot with `{}`.
            hookEndpoint: (slotId, hook) => {
                if (hook !== CODEX_STOP_HOOK) throw new Error(`Unknown MCP slot hook: ${String(hook)}`);
                return `${this.baseUrl}/codex-hooks/${slotId}/${CODEX_STOP_HOOK}`;
            },
        });
    }

    /** `http://127.0.0.1:<port>/api`: server.ts mounts mountMcp's routes under /api. */
    private get baseUrl(): string {
        return `http://127.0.0.1:${this.mcpPort()}/api`;
    }

    /** Request handler for mountMcp's routes. */
    httpHandler(): McpHostHandler {
        return this.host.handler();
    }

    /** Chat-only gateway: a stable catalog/URL, explicit native
     * ACP session IDs on calls. Warm sessions are never added to its routing map. */
    createSessionGroup(catalog: McpSlot): string {
        return this.provider.createSessionGroup(catalog);
    }

    getSessionGroupCatalog(groupId: string): McpSlot | undefined {
        return mcpSlotProviderInternals(this.provider).sessionGroupCatalog(groupId)?.binding;
    }

    bindSession(groupId: string, sessionId: string, slotId: string): void {
        this.provider.bindSession(groupId, sessionId, slotId);
    }

    beginSessionTurn(groupId: string, sessionId: string, getActivePageTurnAttribution?: ActivePageTurnAttributionGetter): () => void {
        return this.provider.beginSessionTurn(groupId, sessionId, getActivePageTurnAttribution);
    }

    endSessionTurn(groupId: string, sessionId: string): void {
        this.provider.endSessionTurn(groupId, sessionId);
    }

    resolveSessionSlot(groupId: string, sessionId: string): McpSlot | undefined {
        return mcpSlotProviderInternals(this.provider).resolveSessionSlot(groupId, sessionId);
    }

    disposeSessionGroup(groupId: string): void {
        this.provider.disposeSessionGroup(groupId);
    }

    create(
        parentChatId: string,
        cwd: string,
        ownerUserId: string | null,
        cbs: McpSlotCallbacks,
        opts?: { nodeId?: string | null; workspaceId?: string | null },
    ): McpSlot {
        return this.provider.create(parentChatId, cwd, ownerUserId, cbs, opts);
    }

    get(slotId: string): McpSlot | undefined {
        return this.provider.get(slotId);
    }

    dispose(slotId: string): Promise<void> {
        return this.provider.dispose(slotId);
    }

    /**
     * `http://127.0.0.1:<port>/api/mcp/<slotId>`, byte for byte the URL the
     * Kiro, Codex and Claude adapters build and the only shape Crew's relay
     * accepts. Built from the id alone, so a disposed slot's URL answers 404.
     */
    endpoint(slotId: string): McpHttpEndpoint {
        return this.provider.endpoint(slotId);
    }

    /** `http://127.0.0.1:<port>/api/mcp-session/<groupId>`, as Kiro's michiSessionMcpServer builds it. */
    sessionEndpoint(groupId: string): McpHttpEndpoint {
        return this.provider.sessionEndpoint(groupId);
    }

    /**
     * mountMcp's Express route `/api/codex-hooks/<slotId>/stop`, not the
     * host's `/mcp-hooks` route: it answers an unknown slot with `{}`.
     */
    hookEndpoint(slotId: string, hook: "stop"): string {
        return this.provider.hookEndpoint(slotId, hook);
    }

    /**
     * Assigns the patch on the slot's binding itself: the host reads that
     * same object on every call, so the next tool call sees the new values.
     * A new parentChatId also becomes the host slot's sessionKey, and a
     * present exposedToolNames its allow-list. An unknown or disposed slot is
     * left alone, as get() answers undefined for it.
     */
    rebind(slotId: string, patch: McpSlotRebindPatch): void {
        this.provider.rebind(slotId, patch);
    }
}

function resolveSlotBinding(slot: McpSlot): { workspaceId: string | null; nodeId: string | null } {
    // Agent Run owners carry an immutable Workspace binding supplied at slot
    // creation time. They MUST NOT perform a Node lookup — Runs have no
    // backing node row, and querying one would be both incorrect and a
    // contract violation (§2.5 of the implementation plan).
    if (isRunOwner(slot.owner)) {
        return { workspaceId: slot.workspaceId, nodeId: null };
    }

    const fromNode = slot.nodeId
        ? getNodeSessionBinding(slot.nodeId, slot.ownerUserId)
        : null;
    if (fromNode) {
        slot.nodeId = fromNode.nodeId;
        slot.workspaceId = fromNode.workspaceId;
        return { workspaceId: fromNode.workspaceId, nodeId: fromNode.nodeId };
    }

    const fromRuntimeSession = slot.parentChatId && slot.parentChatId !== "__pending__"
        ? getNodeSessionBinding(slot.parentChatId, slot.ownerUserId)
        : null;
    if (fromRuntimeSession) {
        slot.nodeId = fromRuntimeSession.nodeId;
        slot.workspaceId = fromRuntimeSession.workspaceId;
        return { workspaceId: fromRuntimeSession.workspaceId, nodeId: fromRuntimeSession.nodeId };
    }

    if (process.env.MICHI_CLOUD === "1" && !slot.ownerUserId) {
        return { workspaceId: null, nodeId: slot.nodeId };
    }
    return { workspaceId: slot.workspaceId, nodeId: slot.nodeId };
}

/**
 * Returns true when a tool is permitted by the slot's exposed-tool allow-list.
 * When no allow-list is set (legacy callers / chat slots that don't restrict),
 * all tools are implicitly exposed. When the list is set, only tools in the
 * set pass. This is the product-level gate and is checked independently of
 * whether a callback exists.
 */
function isToolExposed(slot: McpSlot, toolName: string): boolean {
    if (!slot.exposedToolNames) return true;
    return slot.exposedToolNames.has(toolName);
}

/**
 * Which catalog a slot gets. The assistant's needs both markers: the slot is
 * bound to a chat in the Michi assistant's workspace (the database, read on
 * every request) and was created by a session running the assistant profile
 * (`slot.restricted`). With only one of the two the session was not set up as
 * the assistant, or is outside its home, so the slot gets neither catalog.
 */
function slotCatalog(slot: McpSlot): "assistant" | "maintenance" | "fenced" | "chat" {
    if (slot.maintenance === true) {
        return !!chatNodeOf(slot.owner) && slot.getActiveMaintenanceExecutionContext ? 'maintenance' : 'fenced';
    }
    const home = !isRunOwner(slot.owner) && isAssistantWorkspace(resolveSlotBinding(slot).workspaceId);
    const profile = slot.restricted === true;
    if (home && profile) return "assistant";
    return home || profile ? "fenced" : "chat";
}

function maintenanceJsonSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
    const converted = maintenanceJsonSchemaShape(schema);
    // Descriptions are how an agent learns a field's format and a block's rules; keep them in the listed schema.
    return typeof schema.description === 'string' && schema.description ? converted.describe(schema.description) : converted;
}

function maintenanceJsonSchemaShape(schema: Record<string, unknown>): z.ZodTypeAny {
    const branches = Array.isArray(schema.oneOf) ? schema.oneOf
        : Array.isArray(schema.anyOf) ? schema.anyOf : null;
    if (branches) {
        const schemas = branches.filter((branch): branch is Record<string, unknown> => Boolean(branch) && typeof branch === 'object')
            .map((branch) => maintenanceJsonSchemaToZod(branch));
        if (schemas.length === 1) return schemas[0];
        if (schemas.length > 1) return z.union(schemas as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
        return z.unknown();
    }
    if (Object.prototype.hasOwnProperty.call(schema, 'const')) return z.literal(schema.const as string | number | boolean | null);
    if (schema.enum && Array.isArray(schema.enum) && schema.enum.length > 0) {
        const values = schema.enum;
        if (values.every((value): value is string => typeof value === 'string')) {
            return z.enum(values as [string, ...string[]]);
        }
        const literals = values.map((value) => z.literal(value as string | number | boolean | null));
        return literals.length === 1 ? literals[0] : z.union(literals as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
    }
    if (Array.isArray(schema.type)) {
        const schemas = schema.type.map((type) => maintenanceJsonSchemaToZod({ ...schema, type }));
        return schemas.length === 1 ? schemas[0] : z.union(schemas as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
    }
    switch (schema.type) {
        case 'string': {
            let value = z.string();
            if (typeof schema.minLength === 'number') value = value.min(schema.minLength);
            if (typeof schema.maxLength === 'number') value = value.max(schema.maxLength);
            return value;
        }
        case 'number': {
            let value = z.number();
            if (typeof schema.minimum === 'number') value = value.min(schema.minimum);
            if (typeof schema.maximum === 'number') value = value.max(schema.maximum);
            if (typeof schema.exclusiveMinimum === 'number') value = value.gt(schema.exclusiveMinimum);
            if (typeof schema.exclusiveMaximum === 'number') value = value.lt(schema.exclusiveMaximum);
            return value;
        }
        case 'integer': {
            let value = z.number().int();
            if (typeof schema.minimum === 'number') value = value.min(schema.minimum);
            if (typeof schema.maximum === 'number') value = value.max(schema.maximum);
            if (typeof schema.exclusiveMinimum === 'number') value = value.gt(schema.exclusiveMinimum);
            if (typeof schema.exclusiveMaximum === 'number') value = value.lt(schema.exclusiveMaximum);
            return value;
        }
        case 'boolean': return z.boolean();
        case 'null': return z.null();
        case 'array': {
            let value = z.array(schema.items && typeof schema.items === 'object'
                ? maintenanceJsonSchemaToZod(schema.items as Record<string, unknown>) : z.unknown());
            if (typeof schema.minItems === 'number') value = value.min(schema.minItems);
            if (typeof schema.maxItems === 'number') value = value.max(schema.maxItems);
            return value;
        }
        case 'object': {
            const properties = schema.properties && typeof schema.properties === 'object'
                ? schema.properties as Record<string, unknown> : {};
            const required = new Set(Array.isArray(schema.required) ? schema.required : []);
            const shape: Record<string, z.ZodTypeAny> = {};
            for (const [key, value] of Object.entries(properties)) {
                if (!value || typeof value !== 'object') continue;
                const field = maintenanceJsonSchemaToZod(value as Record<string, unknown>);
                shape[key] = required.has(key) ? field : field.optional();
            }
            const object = z.object(shape);
            if (schema.additionalProperties === false) return object.strict();
            if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
                return object.catchall(maintenanceJsonSchemaToZod(schema.additionalProperties as Record<string, unknown>));
            }
            return object.passthrough();
        }
        default:
            // JSON Schema allows object schemas to omit `type` when they are
            // expressed through properties/required/additionalProperties.
            if (schema.properties || schema.required || schema.additionalProperties !== undefined) {
                return maintenanceJsonSchemaToZod({ ...schema, type: 'object' });
            }
            return z.unknown();
    }
}

function registerMaintenanceTools(registerTool: AddTool, slot: McpSlot): void {
    if (!slot.getActiveMaintenanceExecutionContext) return;
    const tools = createMaintenanceTools(() => slot.getActiveMaintenanceExecutionContext?.() ?? null, {});
    for (const tool of tools) {
        if (!META_AGENT_MAINTENANCE_TOOL_NAMES.includes(tool.name) || !isToolExposed(slot, tool.name)) continue;
        const properties = Object.fromEntries(Object.entries(tool.parameters.properties).map(([key, schema]) =>
            [key, maintenanceJsonSchemaToZod(schema as Record<string, unknown>)]));
        const required = new Set(tool.parameters.required);
        const inputSchema: Record<string, z.ZodTypeAny> = Object.fromEntries(Object.entries(properties).map(([key, field]) =>
            [key, required.has(key) ? field : field.optional()]));
        registerTool(tool.name, { description: tool.description, inputSchema }, async (args) => {
            const result = tool.execute(args);
            return { content: result.content, ...(result.isError ? { isError: true } : {}) };
        });
    }
}

/**
 * The assistant's whole catalog (assistant/tools.ts, the Meta agent's chat
 * window) in place of the ordinary chat tools: cross-workspace reads, Pages in
 * every workspace, starting a conversation with its approval through this
 * slot's ask_user channel, and the native Page tools. Nothing that writes files or
 * sends into an existing conversation is offered.
 */
function registerAssistantTools(registerTool: AddTool, slot: McpSlot): void {
    // No Desk tools while Agent Desk is off, whatever the slot's allow-list says.
    for (const tool of ASSISTANT_TOOLS) {
        if (!isToolExposed(slot, tool.name)) continue;
        registerTool(tool.name, { description: tool.description, inputSchema: paramObjectToZodShape(tool.parameters) }, async (args) => {
            const binding = resolveSlotBinding(slot);
            return runAssistantTool(tool, {
                ownerUserId: slot.ownerUserId,
                workspaceId: binding.workspaceId,
                nodeId: binding.nodeId,
                approveThreadMessage: askUserThreadMessageApprover(slot.onAskUser),
                getActivePageTurnAttribution: slot.getActivePageTurnAttribution,
            }, args);
        });
    }
}

/** The artifact_saved / artifact_updated payload for a context the bridge saved or updated. */
function artifactPayload(result: BridgeContextResult): Extract<MichiHostEvent, { type: "artifact_saved" }>["payload"] {
    return { contextId: result.id, name: result.name, filePath: result.filePath, size: result.size };
}

function allowedAgentRunToolNames(slot: McpSlot): AgentRunToolName[] {
    const configured = slot.agentRunToolNames
        ?? (slot.exposedToolNames
            ? AGENT_RUN_TOOL_NAMES
            : isRunOwner(slot.owner) ? [] : AGENT_RUN_TOOL_NAMES);
    return configured.filter((name) => isToolExposed(slot, name));
}

/** What a tool's handler gets besides its arguments. */
interface ToolCallExtra {
    signal?: AbortSignal;
    /** The slot's session sink (see hostToolDef); absent through buildMcpServerForSlot. */
    sink?: SessionToolSink;
}
/** Gets the arguments as the tool's zod schema parsed them (see hostToolDef). */
type ToolHandler = (args: any, extra?: ToolCallExtra) => unknown;
type ToolInputSchema = Record<string, z.ZodTypeAny> | z.ZodTypeAny;
interface ToolConfig {
    description: string;
    inputSchema: ToolInputSchema;
    annotations?: ToolAnnotations;
}
/** One tool of a slot's catalog, in the shape McpServer.registerTool takes. */
interface MichiTool {
    name: string;
    config: ToolConfig;
    handler: ToolHandler;
}
type AddTool = (name: string, config: ToolConfig, handler: ToolHandler) => void;

/**
 * The tools a slot serves right now, in wire order. Side-effect tools
 * delegate to the slot's callbacks, which own ACP session creation and
 * context file writes. Evaluated on every tools/list and tools/call (the
 * host's tool source), so catalog gates read the slot as it is then.
 */
function michiToolCatalog(slot: McpSlot): MichiTool[] {
    const tools: MichiTool[] = [];
    // A slot that is not serving (McpSlot.isServing) refuses every call.
    const registerTool: AddTool = (name, config, handler) => {
        const isServing = slot.isServing;
        tools.push({
            name,
            config,
            handler: async (...args: [any, ToolCallExtra?]) => {
                if (isServing && !isServing()) {
                    return { content: [{ type: "text" as const, text: "This session cannot run tools now: it has not passed its safety check, or it was stopped." }], isError: true };
                }
                const result = await handler(...args);
                notifyMcpToolResult(slot, name, result);
                return result;
            },
        });
    };

    // The Michi assistant gets its own catalog instead of the ordinary chat
    // tools; only the user channel (ask_user) and the runtime's
    // turn-metadata tools below are shared with every chat.
    const catalog = slotCatalog(slot);
    if (catalog === 'maintenance') {
        registerMaintenanceTools(registerTool, slot);
        return tools;
    }
    if (catalog === "assistant") registerAssistantTools(registerTool, slot);
    const ordinary = catalog === "chat";
    const exposes = (name: string) => ordinary && isToolExposed(slot, name);

    const builtinRegistration = (name: string) => {
        const tool = listEnabledBuiltinTools().find(candidate => candidate.name === name);
        if (!tool) throw new Error(`Missing builtin tool definition: ${name}`);
        return { description: tool.description, inputSchema: builtinToZodShape(tool) };
    };
    for (const name of PAGE_TOOL_NAMES) {
        const tool = listEnabledBuiltinTools().find((candidate) => candidate.name === name);
        if (!tool || !exposes(name)) continue;
        registerTool(name, {
            description: tool.description,
            inputSchema: builtinToZodShape(tool),
            annotations: {
                readOnlyHint: name === 'read_home' || name === 'list_pages' || name === 'read_page' || name === 'read_database' || name === 'list_page_components' || name === 'read_page_component' || name === 'list_tasks',
                destructiveHint: name === 'edit_home' || name === 'edit_page' || name === 'edit_database' || name === 'create_page' || name === 'save_page_component' || name === 'configure_database_view',
                openWorldHint: false,
            },
        }, async (args) => {
            const binding = resolveSlotBinding(slot);
            return runPageTool(name as PageToolName, {
                ownerUserId: slot.ownerUserId,
                workspaceId: binding.workspaceId,
                nodeId: binding.nodeId,
                ownerKind: slot.owner ? hostOwner(slot.owner).kind : null,
                getActivePageTurnAttribution: slot.getActivePageTurnAttribution,
            }, args);
        });
    }

    const docsTool = listEnabledBuiltinTools().find(tool => tool.name === 'michi_docs');
    if (docsTool && exposes(docsTool.name)) registerTool(docsTool.name, {
        description: docsTool.description,
        inputSchema: builtinToZodShape(docsTool),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, async (args) => michiDocsTool(args));

    // Side-effect tools that mutate the chat graph or filesystem. The
    // globalContext tools (list_threads / search_messages / read_node) are
    // registered separately below because they don't go through the slot
    // callback indirection.
    const SIDE_EFFECT_TOOL_NAMES = new Set(["open_url", "spawn_branches", "save_artifact", "update_artifact", "show_image"]);
    for (const tool of listEnabledBuiltinTools()) {
        if (!SIDE_EFFECT_TOOL_NAMES.has(tool.name) || !exposes(tool.name)) continue;
        // A tool whose slot callback the host left out is not offered.
        if (tool.name === "show_image" && !slot.onShowImage) continue;
        if (tool.name === "spawn_branches" && !slot.onSpawnBranches) continue;
        if (tool.name === "save_artifact" && !slot.onSaveArtifact) continue;
        if (tool.name === "update_artifact" && !slot.onUpdateArtifact) continue;
        registerTool(
            tool.name,
            { description: tool.description, inputSchema: builtinToZodShape(tool) },
            async (args, extra) => {
                // The tool's effect on the session, reported once its callback has succeeded.
                const report = (event: MichiHostEvent) => (extra?.sink ?? NO_HOST_EVENTS).emit(event);
                switch (tool.name) {
                    case "open_url": return openUrlTool({ ...resolveSlotBinding(slot), ownerUserId: slot.ownerUserId }, args.url);
                    case "spawn_branches": {
                        const topics = Array.isArray(args?.topics) ? args.topics : [];
                        const trimmed = topics.slice(0, 5);
                        if (!slot.onSpawnBranches) throw new Error("spawn_branches is unavailable");
                        const result = await slot.onSpawnBranches(trimmed);
                        report({ type: "spawn_branches", payload: { topics: result } });
                        const summary = result.map((r) => `- ${r.title} (chatId: ${r.chatId})`).join("\n");
                        return {
                            content: [{
                                type: "text",
                                text: `Spawned ${result.length} branch${result.length === 1 ? "" : "es"}:\n${summary}`,
                            }],
                        };
                    }
                    case "save_artifact": {
                        const name = typeof args?.name === "string" ? args.name.trim() : "";
                        if (!name || typeof args?.body !== "string") {
                            throw new Error("save_artifact requires name and body");
                        }
                        if (!slot.onSaveArtifact) throw new Error("save_artifact is unavailable");
                        const result = slot.onSaveArtifact(name, args.body);
                        if (!result) throw new Error(`Could not save artifact: @${name}`);
                        report({ type: "artifact_saved", payload: artifactPayload(result) });
                        return { content: [{ type: "text", text: `Saved artifact: @${result.name}` }] };
                    }
                    case "update_artifact": {
                        const name = typeof args?.name === "string" ? args.name.trim() : "";
                        if (!name || typeof args?.body !== "string") {
                            throw new Error("update_artifact requires name and body");
                        }
                        if (!slot.onUpdateArtifact) throw new Error("update_artifact is unavailable");
                        const result = slot.onUpdateArtifact(name, args.body);
                        if (!result) throw new Error(`Artifact does not exist or could not be updated: @${name}`);
                        report({ type: "artifact_updated", payload: artifactPayload(result) });
                        return { content: [{ type: "text", text: `Updated artifact: @${result.name}` }] };
                    }
                    case "show_image": {
                        const p = typeof args?.path === "string" ? args.path : "";
                        const caption = typeof args?.caption === "string" ? args.caption : undefined;
                        const result = slot.onShowImage?.(p, caption);
                        if (!result) throw new Error("show_image is unavailable");
                        if ("error" in result) throw new Error(`show_image failed: ${result.error}`);
                        report({ type: "image", payload: { path: result.relPath, caption, mimeType: result.mimeType, size: result.size } });
                        return { content: [{ type: "text", text: `Displayed ${result.relPath} to the user.` }] };
                    }
                }
                return { content: [{ type: "text", text: `unhandled tool: ${tool.name}` }] };
            },
        );
    }

    if (slot.agentRuns && ordinary) {
        const allowedNames = allowedAgentRunToolNames(slot);
        if (allowedNames.length > 0) registerAgentRunTools(registerTool, slot.agentRuns, allowedNames);
    }

    // submit_agent_result is registered only for agent_run owners with a bound
    // Attempt collector callback AND when the tool passes the exposed-tool
    // gate. Chat slots must never discover or invoke this tool.
    if (
        isRunOwner(slot.owner)
        && slot.onSubmitAgentResult
        && isToolExposed(slot, SUBMIT_AGENT_RESULT_TOOL)
    ) {
        registerTool(
            SUBMIT_AGENT_RESULT_TOOL,
            {
                description: SUBMIT_AGENT_RESULT_DEFINITION.description,
                inputSchema: z.object(paramObjectToZodShape(SUBMIT_AGENT_RESULT_DEFINITION.parameters)).passthrough(),
            },
            async (args) => {
                if (!slot.onSubmitAgentResult) {
                    throw new Error("submit_agent_result callback is no longer available");
                }
                slot.onSubmitAgentResult(args ?? {});
                return { content: [{ type: "text", text: "Agent result submitted." }] };
            },
        );
    }

    if (slot.onSetFollowUps && isToolExposed(slot, "set_follow_ups")) {
        registerTool(
            "set_follow_ups",
            {
                description:
                    "Set exactly three follow-up questions for this turn. Write them from the user's point of view and in the user's language. Call near the end of the reply.",
                inputSchema: {
                    follow_ups: z.array(z.string().min(1)).min(1).max(3),
                },
            },
            async (args) => {
                const cleaned = (Array.isArray(args?.follow_ups) ? args.follow_ups : [])
                    .map((value: unknown) => typeof value === "string" ? value.trim() : "")
                    .filter((value: string) => value.length > 0)
                    .slice(0, 3);
                if (cleaned.length > 0) slot.onSetFollowUps?.(cleaned);
                return {
                    content: [{ type: "text", text: `Follow-ups set: ${cleaned.length}` }],
                };
            },
        );
    }

    if (slot.onSetBranchOverview && isToolExposed(slot, "set_branch_overview")) {
        registerTool(
            "set_branch_overview",
            {
                description:
                    fullNodeSummaryExperimentEnabled()
                        ? `Record the experimental current-state node overview. ${FULL_NODE_SUMMARY_INSTRUCTION} Call near the end of every reply.`
                        : "Append this turn's entry to the branch's durable journal. Summarize what this turn did — what was explored, decided, or discovered — in 1-3 concise sentences, matching the user's language. Do not restate earlier turns. Call near the end of every reply.",
                inputSchema: {
                    overview: z.string().min(1).max(4000),
                },
            },
            async (args) => {
                const overview = typeof args?.overview === "string" ? args.overview.trim() : "";
                if (overview) slot.onSetBranchOverview?.(overview);
                return {
                    content: [{
                        type: "text",
                        text: overview
                            ? slot.metadataDoneSentinel
                                ? `Branch overview recorded. This turn's user-facing response is already complete; emit ${slot.metadataDoneSentinel} as the runtime end-of-turn marker (auto-stripped before display).`
                                : "Branch overview updated."
                            : "Branch overview was empty; no update applied.",
                    }],
                };
            },
        );
    }

    if (slot.onValidateFollowUps) {
        const validateTurnMetadata = async () => ({
            content: [{
                type: "text" as const,
                text: JSON.stringify(slot.onValidateFollowUps?.() ?? {}),
            }],
        });
        if (isToolExposed(slot, "validate_follow_ups")) registerTool(
            "validate_follow_ups",
            {
                description:
                    "Legacy internal Stop-hook validator alias. The model must not call it directly.",
                inputSchema: {},
            },
            validateTurnMetadata,
        );
        if (isToolExposed(slot, "validate_turn_metadata")) registerTool(
            "validate_turn_metadata",
            {
                description:
                    "Internal Claude Stop-hook validator for required turn metadata. Claude invokes this automatically; the model must not call it directly.",
                inputSchema: {},
            },
            validateTurnMetadata,
        );
    }

    if (exposes("list_threads")) registerTool(
        "list_threads",
        builtinRegistration("list_threads"),
        async (args) => {
            const binding = resolveSlotBinding(slot);
            const result = listThreads(
                binding.workspaceId,
                slot.ownerUserId,
                typeof args?.workspaceId === "string" ? args.workspaceId : undefined,
                binding.nodeId ?? undefined,
            );
            return { content: [{ type: "text", text: result.text }] };
        },
    );

    if (exposes("search_messages")) registerTool(
        "search_messages",
        builtinRegistration("search_messages"),
        async (args) => {
            const binding = resolveSlotBinding(slot);
            const result = searchMessages(
                binding.workspaceId,
                slot.ownerUserId,
                String(args?.query ?? ""),
                args?.scope === "all" ? "all" : "current",
                typeof args?.limit === "number" ? args.limit : 10,
            );
            return { content: [{ type: "text", text: result.text }] };
        },
    );

    if (exposes("read_node")) registerTool(
        "read_node",
        builtinRegistration("read_node"),
        async (args) => {
            const binding = resolveSlotBinding(slot);
            const opts: { role?: "user" | "assistant"; from?: "head" | "tail"; offset?: number; limit?: number } = {};
            if (args?.role === "user" || args?.role === "assistant") opts.role = args.role;
            if (args?.from === "head" || args?.from === "tail") opts.from = args.from;
            if (typeof args?.offset === "number") opts.offset = args.offset;
            if (typeof args?.limit === "number") opts.limit = args.limit;
            const hasOpts = Object.keys(opts).length > 0;
            const result = readNode(binding.workspaceId, slot.ownerUserId, String(args?.nodeId ?? ""), hasOpts ? opts : undefined);
            return { content: [{ type: "text", text: result.text }] };
        },
    );

    if (exposes("report_conversation_no_change")) registerTool(
        "report_conversation_no_change",
        builtinRegistration("report_conversation_no_change"),
        async (args) => reportConversationNoChange(resolveSlotBinding(slot), args),
    );

    if (exposes("read_conversation_updates")) registerTool(
        "read_conversation_updates",
        builtinRegistration("read_conversation_updates"),
        async (args) => {
            const binding = resolveSlotBinding(slot);
            return readConversationUpdatesTool({ ownerUserId: slot.ownerUserId, workspaceId: binding.workspaceId,
                runOwnerRunId: runIdOfOwner(slot.owner), backendConnectionId: 'local' }, args);
        },
    );

    if (exposes("read_node_overview")) registerTool(
        "read_node_overview",
        builtinRegistration("read_node_overview"),
        async (args) => {
            const binding = resolveSlotBinding(slot);
            const result = readNodeOverview(binding.workspaceId, slot.ownerUserId, String(args?.nodeId ?? ""));
            return { content: [{ type: "text", text: result.text }] };
        },
    );

    // Pane Inspection tools (inspect_pane / read_pane_output — design §7.2/§7.3). Registered
    // unconditionally alongside the globalContext tools above, following the read_node pattern:
    // resolveSlotBinding(slot) FIRST, then call the shared implementation. Covers Kiro, Claude
    // and Codex — all three are MCP clients of this same server/slot (see report). The caller
    // binding is built from resolveSlotBinding(slot) + slot.ownerUserId + slot.owner (never from
    // args) so a model cannot forge ownerUserId/workspaceId/runOwner via a tool argument.
    function paneInspectionBinding(): PaneInspectionToolBinding {
        const resolved = resolveSlotBinding(slot);
        return {
            ownerUserId: slot.ownerUserId,
            workspaceId: resolved.workspaceId,
            runOwnerRunId: runIdOfOwner(slot.owner),
            backendConnectionId: 'local',
        };
    }

    if (exposes("inspect_pane")) registerTool(
        "inspect_pane",
        builtinRegistration("inspect_pane"),
        async (args) => {
            if (!isToolExposed(slot, "inspect_pane")) throw new Error("Tool is not exposed: inspect_pane");
            const binding = paneInspectionBinding();
            return inspectPaneTool(binding, {
                paneId: typeof args?.paneId === "string" ? args.paneId : undefined,
                nodeId: typeof args?.nodeId === "string" ? args.nodeId : undefined,
                runId: typeof args?.runId === "string" ? args.runId : undefined,
                executionRef: args?.executionRef,
            });
        },
    );

    if (exposes("read_pane_output")) registerTool(
        "read_pane_output",
        builtinRegistration("read_pane_output"),
        async (args) => {
            if (!isToolExposed(slot, "read_pane_output")) throw new Error("Tool is not exposed: read_pane_output");
            const binding = paneInspectionBinding();
            return readPaneOutputTool(binding, {
                paneId: typeof args?.paneId === "string" ? args.paneId : undefined,
                nodeId: typeof args?.nodeId === "string" ? args.nodeId : undefined,
                runId: typeof args?.runId === "string" ? args.runId : undefined,
                selection: args?.selection,
                executionRef: args?.executionRef,
                outputId: typeof args?.outputId === "string" ? args.outputId : undefined,
                pageCursor: typeof args?.pageCursor === "string" ? args.pageCursor : undefined,
                limitBytes: args?.limitBytes,
            });
        },
    );

    if (exposes("list_panes")) registerTool(
        "list_panes",
        builtinRegistration("list_panes"),
        async (args) => {
            if (!isToolExposed(slot, "list_panes")) throw new Error("Tool is not exposed: list_panes");
            const binding = paneInspectionBinding();
            return listPanesTool(binding, {
                treeId: typeof args?.treeId === "string" ? args.treeId : undefined,
                kind: args?.kind,
                parentNodeId: typeof args?.parentNodeId === "string" ? args.parentNodeId : undefined,
                scope: args?.scope,
                includeArchived: typeof args?.includeArchived === "boolean" ? args.includeArchived : undefined,
                limit: args?.limit,
                cursor: typeof args?.cursor === "string" ? args.cursor : undefined,
            });
        },
    );

    if (exposes("wait_pane")) registerTool(
        "wait_pane",
        builtinRegistration("wait_pane"),
        async (args) => {
            if (!isToolExposed(slot, "wait_pane")) throw new Error("Tool is not exposed: wait_pane");
            const binding = paneInspectionBinding();
            return waitPaneTool(binding, {
                paneId: typeof args?.paneId === "string" ? args.paneId : undefined,
                nodeId: typeof args?.nodeId === "string" ? args.nodeId : undefined,
                runId: typeof args?.runId === "string" ? args.runId : undefined,
                until: args?.until,
                cursor: typeof args?.cursor === "string" ? args.cursor : undefined,
                executionRef: args?.executionRef,
                timeoutMs: args?.timeoutMs,
            });
        },
    );

    // Cross-thread messaging. Chat slots only: the caller identity is the
    // slot's bound node/workspace. Optional approval uses this slot's own
    // ask_user channel; ordinary coordination sends without a prompt.
    const sendToThreadSpec = listEnabledBuiltinTools().find((tool) => tool.name === SEND_TO_THREAD_TOOL);
    if (sendToThreadSpec && !isRunOwner(slot.owner) && exposes(SEND_TO_THREAD_TOOL)) registerTool(
        SEND_TO_THREAD_TOOL,
        { description: sendToThreadSpec.description, inputSchema: builtinToZodShape(sendToThreadSpec) },
        async (args) => {
            const binding = resolveSlotBinding(slot);
            return sendToThreadTool(
                {
                    ownerUserId: slot.ownerUserId,
                    workspaceId: binding.workspaceId,
                    nodeId: binding.nodeId,
                    isAgentRun: isRunOwner(slot.owner),
                },
                { nodeId: args?.nodeId, text: args?.text, requestApproval: args?.requestApproval },
                askUserThreadMessageApprover(slot.onAskUser),
            );
        },
    );

    // Scheduled Job management: ordinary chat threads only (never the Michi
    // assistant's catalog, nor a fenced slot), workspace from the slot
    // binding, and every change except pausing approved by the user through
    // ask_user (permission modes cannot skip it). See agents/scheduledJobTools.ts.
    if (!isRunOwner(slot.owner)) {
        for (const spec of listEnabledBuiltinTools()) {
            if (!isScheduledJobToolName(spec.name) || !exposes(spec.name)) continue;
            const toolName = spec.name;
            registerTool(
                toolName,
                { description: spec.description, inputSchema: builtinToZodShape(spec) },
                async (args) => {
                    const binding = resolveSlotBinding(slot);
                    return scheduledJobTool(
                        toolName,
                        {
                            ownerUserId: slot.ownerUserId,
                            workspaceId: binding.workspaceId,
                            nodeId: binding.nodeId,
                            isAgentRun: false,
                        },
                        args,
                        askUserScheduledJobApprover(slot.onAskUser),
                    );
                },
            );
        }
    }

    if (slot.onAskUser && isToolExposed(slot, "ask_user")) registerTool(
        "ask_user",
        {
            description:
                "Ask the user one or more structured questions with selectable options. " +
                "Use when you need the user to make a choice or provide input before proceeding. " +
                "Each question can be single-select or multi-select, and users can always type a custom answer.",
            inputSchema: {
                questions: z.array(z.object({
                    question: z.string().describe("The question to ask the user."),
                    header: z.string().optional().describe("Short label (max 12 chars) displayed as a chip/tag."),
                    options: z.array(z.object({
                        label: z.string().describe("Display text for this option (1-5 words)."),
                        description: z.string().optional().describe("Explanation of what this option means."),
                    })).min(2).max(4).describe("Available choices (2-4 options)."),
                    multiSelect: z.boolean().default(false).describe("Allow multiple selections."),
                })).min(1).max(4).describe("Questions to ask (1-4)."),
            },
        },
        async (args) => {
            if (!slot.onAskUser) {
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ error: "ask_user callback not configured" }),
                    }],
                };
            }
            const questions = Array.isArray(args?.questions) ? args.questions : [];
            const parsed = questions.map((q: any) => ({
                question: String(q.question ?? ""),
                header: typeof q.header === "string" ? q.header : undefined,
                options: Array.isArray(q.options)
                    ? q.options.map((o: any) => ({
                        label: String(o.label ?? ""),
                        description: typeof o.description === "string" ? o.description : undefined,
                    }))
                    : [],
                multiSelect: q.multiSelect === true,
            }));
            const answers = await slot.onAskUser(parsed);
            if (!answers) {
                return {
                    content: [{
                        type: "text",
                        text: "The user did not answer the questions (skipped or timed out).",
                    }],
                };
            }
            return { content: [{ type: "text", text: JSON.stringify({ answers }) }] };
        },
    );

    return tools;
}

function registerAgentRunTools(registerTool: AddTool, invoker: AgentRunToolInvoker,
    allowedNames?: readonly AgentRunToolName[]): void {
    const allowed = allowedNames ? new Set(allowedNames) : null;
    for (const name of AGENT_RUN_TOOL_NAMES) {
        if (allowed && !allowed.has(name)) continue;
        registerTool(name, { description: AGENT_RUN_TOOL_DEFINITIONS[name].description, inputSchema: paramObjectToZodShape(AGENT_RUN_TOOL_DEFINITIONS[name].parameters) }, async (args) => {
            const result = await invoker.invoke(name, args ?? {});
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        });
    }
}

const EMPTY_OBJECT_JSON_SCHEMA: JsonSchemaObject = { type: "object", properties: {} };

/** The zod schema McpServer.registerTool keeps for a config's inputSchema. */
function toolZodSchema(schema: ToolInputSchema): AnySchema {
    return schema instanceof z.ZodType ? schema as AnySchema : objectFromShape(schema as ZodRawShapeCompat);
}

/** The JSON Schema McpServer's tools/list renders for that zod schema. */
function wireInputSchema(schema: AnySchema): JsonSchemaObject {
    const object = normalizeObjectSchema(schema);
    return object
        ? toJsonSchemaCompat(object, { strictUnions: true, pipeStrategy: "input" }) as JsonSchemaObject
        : EMPTY_OBJECT_JSON_SCHEMA;
}

/**
 * A catalog entry as a host tool: tools/list gets the JSON Schema McpServer
 * would render, and tools/call validates arguments with the zod schema the
 * way McpServer does (parsed values to the handler, the same error otherwise).
 * The handler also gets the call's signal and the slot's session sink.
 */
function hostToolDef(tool: MichiTool): HostToolDef<McpSlot> {
    const schema = toolZodSchema(tool.config.inputSchema);
    return {
        name: tool.name,
        description: tool.config.description,
        inputSchema: wireInputSchema(schema),
        ...(tool.config.annotations ? { annotations: tool.config.annotations } : {}),
        async handler(args, ctx) {
            const parsed = await safeParseAsync(normalizeObjectSchema(schema) ?? schema, args);
            if (!parsed.success) {
                const reason = getParseErrorMessage("error" in parsed ? parsed.error : "Unknown error");
                const error = new McpError(ErrorCode.InvalidParams, `Input validation error: Invalid arguments for tool ${tool.name}: ${reason}`);
                return { content: [{ type: "text", text: error.message }], isError: true };
            }
            return await tool.handler(parsed.data, { signal: ctx.signal, sink: ctx.sink }) as ToolResult;
        },
    };
}

/**
 * The slot's catalog (michiToolCatalog) as an SDK McpServer. Exists only for
 * tests and compatibility, which read its `_registeredTools` or connect it to
 * their own transport; Michi serves MCP through the runtime package host
 * (McpSlotRegistry, mountMcp), built from the same catalog. With
 * `sessionAnchor` every tool also requires session_id to equal it, as the
 * session group's routing argument. There is no session sink here, so
 * tools report nothing to a session.
 */
export function buildMcpServerForSlot(slot: McpSlot, sessionAnchor?: string): McpServer {
    const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
    for (const tool of michiToolCatalog(slot)) {
        const { config, handler } = sessionAnchor === undefined ? tool : anchoredTool(tool, sessionAnchor);
        server.registerTool(tool.name, config as Parameters<McpServer["registerTool"]>[1], handler as never);
    }
    return server;
}

function anchoredTool(tool: MichiTool, sessionAnchor: string): Pick<MichiTool, "config" | "handler"> {
    const anchor = z.string().min(1).describe(SESSION_ANCHOR_DESCRIPTION);
    const { inputSchema } = tool.config;
    return {
        config: {
            ...tool.config,
            inputSchema: inputSchema instanceof z.ZodType
                ? inputSchema.and(z.object({ session_id: anchor }))
                : { ...inputSchema, session_id: anchor },
        },
        handler: async (args: any, extra?: ToolCallExtra) => {
            if (args.session_id !== sessionAnchor) throw new Error("MCP session_id does not match the routed session");
            const { session_id: _anchor, ...payload } = args;
            return tool.handler(payload, extra);
        },
    };
}

function codexStopHookResult(slot: McpSlot, payload: unknown): Record<string, unknown> {
    if (!slot.onValidateFollowUps) return {};
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
    const eventName = (payload as Record<string, unknown>).hook_event_name;
    if (eventName !== "Stop") return {};
    return slot.onValidateFollowUps();
}

/**
 * Capability-URL validator used by the Codex command Stop Hook POC. The
 * unguessable MCP slot id binds the external Hook process to exactly one
 * Michi node/session, avoiding any global "current node" lookup when several
 * branches are running concurrently.
 */
export function validateCodexStopHookForSlot(
    registry: McpSlotRegistry,
    slotId: string,
    payload: unknown,
): Record<string, unknown> {
    const slot = registry.get(slotId);
    return slot ? codexStopHookResult(slot, payload) : {};
}

/**
 * Mount Michi's MCP routes on the provided Express router: /mcp/:slotId,
 * /mcp-session/:groupId and the Codex Stop Hook at /codex-hooks/:slotId/stop.
 * The runtime package host serves them (its routes `/mcp/<slot>`,
 * `/mcp-session/<group>`, `/mcp-hooks/<slot>/stop`), behind its gates:
 * loopback peers only, no Origin or proxy forwarding headers, and the body
 * limit. express.json has parsed the body already and is passed through.
 *
 * Stateless transport: a fresh server and transport per POST, torn down when
 * the response closes, so there is no standalone SSE stream to collide on
 * reconnect, no session id to invalidate when the backend restarts, and no
 * cached transport to race over. GET and DELETE answer 405.
 */
export function mountMcp(
    router: express.Router,
    registry: McpSlotRegistry,
): void {
    const serve = registry.httpHandler();
    // The host routes on req.url. Put the Express path back before any other
    // 'finish' listener (server.ts's access log) reads req.path.
    const forward = (req: Request, res: Response, path: string) => {
        const original = req.url;
        const restore = () => { req.url = original; };
        res.prependOnceListener("finish", restore);
        res.once("close", restore);
        req.url = path;
        void serve(req, res, req.body);
    };

    router.post("/codex-hooks/:slotId/stop", (req: Request<{ slotId: string }>, res: Response) => {
        const slotId = req.params.slotId;
        if (!registry.get(slotId)) {
            // No such slot: the Stop Hook fails open with {}, as it always has.
            if (!isLoopbackAddress(req.socket.remoteAddress)) {
                log.warn("mcp", "codex stop hook rejected non-loopback request", { remoteAddress: req.socket.remoteAddress });
                res.status(403).json({});
                return;
            }
            res.json({});
            return;
        }
        forward(req, res, `/mcp-hooks/${slotId}/${CODEX_STOP_HOOK}`);
    });

    const slotRoute = (req: Request<{ slotId: string }>, res: Response) =>
        forward(req, res, `/mcp/${encodeURIComponent(req.params.slotId)}`);
    const groupRoute = (req: Request<{ groupId: string }>, res: Response) =>
        forward(req, res, `/mcp-session/${encodeURIComponent(req.params.groupId)}`);
    router.post("/mcp/:slotId", slotRoute);
    router.get("/mcp/:slotId", slotRoute);
    router.delete("/mcp/:slotId", slotRoute);
    router.post("/mcp-session/:groupId", groupRoute);
    router.get("/mcp-session/:groupId", groupRoute);
    router.delete("/mcp-session/:groupId", groupRoute);
}
