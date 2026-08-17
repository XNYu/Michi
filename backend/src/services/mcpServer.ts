import express, { Request, Response } from "express";
import { randomBytes } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { listThreads, searchMessages, readNode } from "./globalContext";
import { getNodeSessionBinding } from "./dbRepository";
import {
    BUILTIN_TOOLS,
    type BuiltinTool,
    type ParamField,
    type ParamSpec,
} from "../agents/builtinTools";
import type { BridgeContextResult } from "../agents/toolBridge";
import { log } from "./logger";

function paramToZod(spec: ParamSpec): z.ZodTypeAny {
    if (spec === "string") return z.string();
    if (spec === "number") return z.number();
    if (spec === "boolean") return z.boolean();
    if ("array" in spec) return z.array(paramToZod(spec.array));
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [k, v] of Object.entries(spec.object)) shape[k] = fieldToZod(v);
    return z.object(shape);
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
    if (field.description) schema = schema.describe(field.description);
    return field.optional ? schema.optional() : schema;
}

function builtinToZodShape(tool: BuiltinTool): Record<string, z.ZodTypeAny> {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [k, v] of Object.entries(tool.parameters.object)) shape[k] = fieldToZod(v);
    return shape;
}

/**
 * A "slot" is a per-ACP-session binding that the MCP tool handler uses to
 * correlate incoming tool calls back to the owning parent session. The
 * client (our backend) hands kiro a URL like /mcp/<slotId> when creating
 * the ACP session, and whatever tool kiro calls on that URL knows which
 * parent session it belongs to.
 */
export interface McpSlot {
    slotId: string;
    /**
     * Michi node id for the owning chat. This is the durable identity used to
     * derive workspace_id from SQLite. Warm slots start null and are rebound
     * when handed off to a real node.
     */
    nodeId: string | null;
    /**
     * Runtime session id used for callbacks into the owning agent session.
     * Historical name: this is not always a Michi "parent" node id.
     */
    parentChatId: string;
    cwd: string;
    /**
     * Cached workspace id for compatibility and cold-start races. Tool calls
     * resolve the workspace from nodeId first, then runtime session ids, and
     * only use this cache as a final fallback.
     */
    workspaceId: string | null;
    /**
     * Better-Auth user id of the chat owner. Used by globalContext tools
     * (list_threads / search_messages / read_node) to scope DB reads so an
     * attacker who gains Kiro chat access cannot read another user's data.
     * Null on desktop (single-user, no auth).
     */
    ownerUserId: string | null;
    onSpawnBranches: (
        topics: Array<{ title: string; prompt: string }>,
    ) => Promise<Array<{ title: string; prompt: string; chatId: string }>>;
    onSaveArtifact: (name: string, body: string) => BridgeContextResult | null;
    onUpdateArtifact: (name: string, body: string) => BridgeContextResult | null;
    onShowImage: (inputPath: string, caption?: string) => { relPath: string; mimeType: string; size: number } | { error: string };
    /** Structured turn metadata callbacks. Optional so runtimes expose only
     * the metadata tools they can route back into their own event stream. */
    onSetFollowUps?: (followUps: string[]) => void;
    onSetBranchOverview?: (overview: string) => void;
    /** Runtime-only assistant token requested after set_branch_overview so an
     * ACP turn can finish with a non-empty model response. The owning runtime
     * must strip this token before exposing assistant text. */
    metadataDoneSentinel?: string;
    onValidateFollowUps?: () => Record<string, unknown>;
    onApprove?: (params: {
        toolName: string;
        input: unknown;
        toolUseId: string;
    }) => Promise<
        | { behavior: "allow"; updatedInput?: unknown }
        | { behavior: "deny"; message: string }
    >;
    onAskUser?: (questions: Array<{
        question: string;
        header?: string;
        options: Array<{ label: string; description?: string }>;
        multiSelect: boolean;
    }>) => Promise<Record<string, string> | null>;
    /** Best-effort UI backfill of the real MCP result onto the in-flight ACP tool card. */
    onMcpToolResult?: (toolName: string, result: unknown) => void;
}

export interface McpSlotCallbacks {
    onSpawnBranches: McpSlot["onSpawnBranches"];
    onSaveArtifact: McpSlot["onSaveArtifact"];
    onUpdateArtifact: McpSlot["onUpdateArtifact"];
    onShowImage: McpSlot["onShowImage"];
    onSetFollowUps?: McpSlot["onSetFollowUps"];
    onSetBranchOverview?: McpSlot["onSetBranchOverview"];
    metadataDoneSentinel?: McpSlot["metadataDoneSentinel"];
    onValidateFollowUps?: McpSlot["onValidateFollowUps"];
    onApprove?: (params: {
        toolName: string;
        input: unknown;
        toolUseId: string;
    }) => Promise<
        | { behavior: "allow"; updatedInput?: unknown }
        | { behavior: "deny"; message: string }
    >;
    onAskUser?: McpSlot["onAskUser"];
    onMcpToolResult?: McpSlot["onMcpToolResult"];
}

export class McpSlotRegistry {
    private slots = new Map<string, McpSlot>();

    create(
        parentChatId: string,
        cwd: string,
        ownerUserId: string | null,
        cbs: McpSlotCallbacks,
        opts?: { nodeId?: string | null; workspaceId?: string | null },
    ): McpSlot {
        const slotId = randomBytes(16).toString("hex");
        const slot: McpSlot = {
            slotId,
            nodeId: opts?.nodeId ?? null,
            parentChatId,
            cwd,
            workspaceId: opts?.workspaceId ?? null,
            ownerUserId,
            ...cbs,
        };
        this.slots.set(slotId, slot);
        return slot;
    }

    get(slotId: string): McpSlot | undefined {
        return this.slots.get(slotId);
    }

    async dispose(slotId: string): Promise<void> {
        // Transports are created per-request and torn down on response close
        // (see mountMcp), so there is nothing transport-level to dispose here —
        // we just drop the slot binding.
        this.slots.delete(slotId);
    }
}

function resolveSlotBinding(slot: McpSlot): { workspaceId: string | null; nodeId: string | null } {
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
 * Build an MCP server bound to a slot. Side-effect tools delegate to the
 * slot's callbacks, which own ACP session creation and context file writes.
 * A new McpServer + transport pair is built per-slot on demand so the
 * tool handler has a closure over the specific slot.
 */
function notifyMcpToolResult(slot: McpSlot, toolName: string, result: unknown): void {
    if (!slot.onMcpToolResult) return;
    setImmediate(() => {
        try {
            slot.onMcpToolResult?.(toolName, result);
        } catch {
            // Backfill is best-effort; never fail the MCP response.
        }
    });
}

function attachMcpToolResultNotify(server: McpServer, slot: McpSlot): void {
    const proto = server as unknown as { registerTool: (...args: any[]) => unknown };
    const original = proto.registerTool.bind(server);
    proto.registerTool = (name: string, config: unknown, handler: (...args: any[]) => unknown) =>
        original(name, config, async (...args: any[]) => {
            const result = await handler(...args);
            notifyMcpToolResult(slot, name, result);
            return result;
        });
}

export function buildMcpServerForSlot(slot: McpSlot): McpServer {
    const server = new McpServer(
        { name: "michi-tools", version: "1.0.0" },
        { capabilities: { tools: {} } },
    );
    attachMcpToolResultNotify(server, slot);

    // Side-effect tools that mutate the chat graph or filesystem. The
    // globalContext tools (list_threads / search_messages / read_node) are
    // registered separately below because they don't go through the slot
    // callback indirection.
    const SIDE_EFFECT_TOOL_NAMES = new Set(["spawn_branches", "save_artifact", "update_artifact", "show_image"]);
    for (const tool of BUILTIN_TOOLS) {
        if (!SIDE_EFFECT_TOOL_NAMES.has(tool.name)) continue;
        server.registerTool(
            tool.name,
            { description: tool.description, inputSchema: builtinToZodShape(tool) },
            async (args) => {
                switch (tool.name) {
                    case "spawn_branches": {
                        const topics = Array.isArray(args?.topics) ? args.topics : [];
                        const trimmed = topics.slice(0, 5);
                        const result = await slot.onSpawnBranches(trimmed);
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
                        const result = slot.onSaveArtifact(name, args.body);
                        if (!result) throw new Error(`Could not save artifact: @${name}`);
                        return { content: [{ type: "text", text: `Saved artifact: @${result.name}` }] };
                    }
                    case "update_artifact": {
                        const name = typeof args?.name === "string" ? args.name.trim() : "";
                        if (!name || typeof args?.body !== "string") {
                            throw new Error("update_artifact requires name and body");
                        }
                        const result = slot.onUpdateArtifact(name, args.body);
                        if (!result) throw new Error(`Artifact does not exist or could not be updated: @${name}`);
                        return { content: [{ type: "text", text: `Updated artifact: @${result.name}` }] };
                    }
                    case "show_image": {
                        const p = typeof args?.path === "string" ? args.path : "";
                        const caption = typeof args?.caption === "string" ? args.caption : undefined;
                        const result = slot.onShowImage(p, caption);
                        if ("error" in result) throw new Error(`show_image failed: ${result.error}`);
                        return { content: [{ type: "text", text: `Displayed ${result.relPath} to the user.` }] };
                    }
                }
                return { content: [{ type: "text", text: `unhandled tool: ${tool.name}` }] };
            },
        );
    }

    if (slot.onSetFollowUps) {
        server.registerTool(
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

    if (slot.onSetBranchOverview) {
        server.registerTool(
            "set_branch_overview",
            {
                description:
                    "Append this turn's entry to the branch's durable journal. Summarize what this turn did — what was explored, decided, or discovered — in 1-3 concise sentences, matching the user's language. Do not restate earlier turns. Call near the end of every reply.",
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
                                ? `Branch overview updated. Respond with exactly ${slot.metadataDoneSentinel} and no other text.`
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
        server.registerTool(
            "validate_follow_ups",
            {
                description:
                    "Legacy internal Stop-hook validator alias. The model must not call it directly.",
                inputSchema: {},
            },
            validateTurnMetadata,
        );
        server.registerTool(
            "validate_turn_metadata",
            {
                description:
                    "Internal Claude Stop-hook validator for required turn metadata. Claude invokes this automatically; the model must not call it directly.",
                inputSchema: {},
            },
            validateTurnMetadata,
        );
    }

    server.registerTool(
        "list_threads",
        {
            description:
                "List threads (trees) and their nodes in this workspace as JSON. Use when user references prior work outside this thread. Not speculatively. Each thread has its own id (\"t-...\") and a nodes[] array; only node ids (\"n-...\") are valid input to read_node.",
            inputSchema: {
                workspaceId: z.string().optional().describe("Defaults to current."),
            },
        },
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

    server.registerTool(
        "search_messages",
        {
            description:
                "Keyword search across workspace messages. Scope defaults to current workspace; pass 'all' only when user asked or current is empty.",
            inputSchema: {
                query: z.string().min(1).describe("Case-insensitive substring."),
                scope: z.enum(["current", "all"]).optional(),
                limit: z.number().int().min(1).max(50).optional().describe("Default 10."),
            },
        },
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

    server.registerTool(
        "read_node",
        {
            description:
                "Read a node's full transcript. Use AFTER list_threads/search_messages identified a relevant nodeId. Not speculatively.",
            inputSchema: {
                nodeId: z.string().min(1),
            },
        },
        async (args) => {
            const binding = resolveSlotBinding(slot);
            const result = readNode(binding.workspaceId, slot.ownerUserId, String(args?.nodeId ?? ""));
            return { content: [{ type: "text", text: result.text }] };
        },
    );

    server.registerTool(
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

    server.registerTool(
        "approve",
        {
            description:
                "Internal permission gate — claude calls this automatically. Do not invoke directly.",
            inputSchema: {
                tool_name: z.string(),
                input: z.unknown().optional(),
                tool_use_id: z.string().optional(),
            },
        },
        async (args) => {
            if (!slot.onApprove) {
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ behavior: "deny", message: "approve callback not configured" }),
                    }],
                };
            }
            const verdict = await slot.onApprove({
                toolName: String(args?.tool_name ?? ""),
                input: args?.input,
                toolUseId: typeof args?.tool_use_id === "string" ? args.tool_use_id : "",
            });
            return { content: [{ type: "text", text: JSON.stringify(verdict) }] };
        },
    );

    return server;
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
    if (!slot?.onValidateFollowUps) return {};
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
    const eventName = (payload as Record<string, unknown>).hook_event_name;
    if (eventName !== "Stop") return {};
    return slot.onValidateFollowUps();
}

function isLoopbackAddress(address: string | undefined): boolean {
    if (!address) return false;
    return address === "127.0.0.1"
        || address === "::1"
        || address === "::ffff:127.0.0.1";
}

/**
 * Mount the MCP HTTP endpoint under /mcp/:slotId on the provided Express router.
 *
 * Stateless transport: a fresh McpServer + StreamableHTTPServerTransport is
 * built per POST and torn down when the response closes. Because nothing is
 * shared across requests there is:
 *   - no per-session standalone SSE stream → no 409 "Only one SSE stream is
 *     allowed per session" when a client reconnects its stream;
 *   - no session id to invalidate when the backend restarts (nodemon/redeploy);
 *   - no cached transport to race over on the first concurrent requests.
 * Every tool here is request/response, so the server→client SSE channel that
 * stateful mode provides is unnecessary.
 */
export function mountMcp(
    router: express.Router,
    registry: McpSlotRegistry,
): void {
    router.post("/codex-hooks/:slotId/stop", (req: Request<{ slotId: string }>, res: Response) => {
        const slotId = req.params.slotId;
        if (!isLoopbackAddress(req.socket.remoteAddress)) {
            log.warn("mcp", "codex stop hook rejected non-loopback request", {
                slotId,
                remoteAddress: req.socket.remoteAddress,
            });
            res.status(403).json({});
            return;
        }

        const slot = registry.get(slotId);
        const result = validateCodexStopHookForSlot(registry, slotId, req.body);
        log.debug("mcp", "codex follow-ups hook poc validator request", {
            slotId,
            nodeId: slot?.nodeId ?? null,
            decision: typeof result.decision === "string" ? result.decision : "allow",
            stopHookActive:
                !!req.body && typeof req.body === "object"
                    ? (req.body as Record<string, unknown>).stop_hook_active === true
                    : false,
        });
        res.json(result);
    });

    const handlePost = async (req: Request<{ slotId: string }>, res: Response) => {
        const slotId = req.params.slotId;
        const slot = registry.get(slotId);
        if (!slot) {
            // Almost always an orphaned child from a previous backend instance
            // (nodemon restart / redeploy) still POSTing to its old slotId.
            // Surface it so "MCP not connected" stops being a silent mystery.
            log.warn("mcp", "unknown mcp slot", { slotId, method: req.method });
            res.status(404).json({ error: "unknown mcp slot" });
            return;
        }
        const server = buildMcpServerForSlot(slot);
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined, // stateless
        });
        res.on("close", () => {
            void transport.close().catch(() => {});
            void server.close().catch(() => {});
        });
        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (err) {
            log.error("mcp", "request failed", { slotId, err: (err as Error).message });
            if (!res.headersSent) res.status(500).end();
        }
    };

    // Stateless mode exposes no standalone server→client SSE stream and has no
    // session to terminate, so GET (open stream) and DELETE (end session) are
    // unsupported. Spec-compliant clients treat 405 here as "no server push".
    const methodNotAllowed = (_req: Request, res: Response) => {
        res
            .status(405)
            .set("Allow", "POST")
            .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method Not Allowed" }, id: null });
    };

    router.post("/mcp/:slotId", handlePost);
    router.get("/mcp/:slotId", methodNotAllowed);
    router.delete("/mcp/:slotId", methodNotAllowed);
}
