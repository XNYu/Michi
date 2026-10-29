import { hostOwner } from '../ownerMapping';
import { openUrlTool } from '../openUrlTool';
import { readConversationUpdatesTool } from '../conversationUpdatesTool';
import { chatNodeOf, isRunOwner, runIdOfOwner } from '../ownerMapping';
import { reportConversationNoChange } from '../../services/scheduledJobs/conversationBatch';
import { michiDocsTool } from '../../services/michiDocs';
import type { AgentToolBridge } from "../toolBridge";
import {
    AGENT_RUN_TOOL_NAMES,
    type AgentRunToolName,
    type AgentRunToolInvoker,
} from "../runToolBridge";
import {
    listEnabledBuiltinTools,
    AGENT_RUN_TOOL_DEFINITIONS,
    SUBMIT_AGENT_RESULT_DEFINITION,
    type ParamField,
    type ParamObjectShape,
    type ParamSpec,
} from "../builtinTools";
import { getRuntimeDeps } from "../runtimeDeps";
import {
    inspectPaneTool,
    readPaneOutputTool,
    listPanesTool,
    waitPaneTool,
    type PaneInspectionToolBinding,
} from "../paneInspectionTools";
import { executeRead, type TurnImageQuota } from "../tools/read";
import { executeLs } from "../tools/ls";
import { executeGrep } from "../tools/grep";
import { executeFind } from "../tools/find";
import { executeWrite } from "../tools/write";
import { executeEdit } from "../tools/edit";
import { executeBash } from "../tools/bash";
import { resolveShowImage } from "michi-runtime/internal/core/showImage";
import {
    sendToThreadTool,
    type ThreadMessageApprovalRequest,
    type ThreadMessageApprovalResult,
} from "../threadMessageTool";
import {
    scheduledJobTool,
    type ScheduledJobApprovalRequest,
    type ScheduledJobApprovalResult,
    type ScheduledJobToolName,
} from "../scheduledJobTools";
import { formatWebSearchForAgent, isWebSearchEnabled, searchWeb } from "../../services/webSearch";

const SCHEDULED_JOB_TOOL_LABELS: Record<ScheduledJobToolName, string> = {
    list_scheduled_jobs: "List scheduled jobs",
    create_scheduled_job: "Create scheduled job",
    update_scheduled_job: "Change scheduled job",
    run_scheduled_job: "Run scheduled job",
    delete_scheduled_job: "Delete scheduled job",
};
import type { NormalizedEvent } from "../../services/chatEvents";
import type { RuntimeSessionOwner, RuntimeToolProfile } from "../types";
import {
    SUBMIT_AGENT_RESULT_TOOL,
    type RunWorkerToolProfile,
} from "../runs/runWorkerTools";
import { assistantToolsFor, runAssistantTool } from "../../assistant/tools";
import { assistantPurposeOf, isAssistantWorkspace } from "../../assistant/identity";
import { PAGE_TOOL_NAMES, type ActivePageTurnAttributionGetter, type PageToolName } from '../pageToolNames';
import { runPageTool } from '../pageTools';
import { isMaintenanceProfile } from '../maintenancePolicy';

/**
 * Build the AgentTool[] array fed to pi-agent-core.
 *
 * Title and follow-ups are emitted as inline `[TITLE:]` / `[FOLLOW-UP n/3:]`
 * sentinels in the LLM's text stream — not as tools — so this factory
 * handles the side-effect tools (spawn_branches, save_artifact, update_artifact) and the
 * read-only globalContext tools (list_threads, search_messages, read_node).
 *
 * spawn_branches forces sequential execution because it mutates the chat
 * graph; if a single assistant response ever included another tool call
 * alongside it, parallel execution could race the parent's child registry.
 */

export interface BuildPiToolsOpts {
    bridge: AgentToolBridge;
    cwd: string;
    parentChatId: string;
    /** Workspace this session is bound to. null when the session predates workspaceId threading or the lookup failed. */
    workspaceId: string | null;
    enableFollowUps: boolean;
    /** Per-turn cumulative image-byte budget shared by all read calls. */
    imageQuota: TurnImageQuota;
    /**
     * Session-scoped set of absolute paths the agent has successfully read.
     * read writes; write/edit consult so the agent can't blindly overwrite
     * or edit a file it hasn't actually seen.
     */
    seenPaths: Set<string>;
    /** typebox `Type` namespace, fetched at call time from pi-ai. */
    Type: any;
    /**
     * Better-Auth user id of the chat owner. Forwarded to executeBash so cloud
     * mode can apply an explicit env allowlist (hiding MICHI_ENCRYPTION_KEY etc.).
     * Required in cloud mode: without it bash refuses to run. Null / undefined
     * on desktop, where bash keeps the full process.env.
     */
    ownerUserId?: string | null;
    /**
     * Push a side-effect NormalizedEvent (e.g. an inline `image`) into the
     * active turn's event queue. show_image uses this to render an image in the
     * UI without feeding it into the LLM's context. No-op if no turn is active.
     */
    emitImage?: (ev: NormalizedEvent) => void;
    /**
     * Optional single-use approval when send_to_thread requests it. Absent
     * means only explicitly approval-requesting messages fail closed.
     */
    requestThreadMessageApproval?: (
        request: ThreadMessageApprovalRequest,
        signal?: AbortSignal,
    ) => Promise<ThreadMessageApprovalResult>;
    /**
     * Single-use user approval for one scheduled job change, shown in this
     * chat. Absent → the change fails closed.
     */
    requestScheduledJobApproval?: (
        request: ScheduledJobApprovalRequest,
        signal?: AbortSignal,
    ) => Promise<ScheduledJobApprovalResult>;
    /** Session-bound generic Agent tools resolved by PiSession. */
    agentRunTools?: AgentRunToolInvoker | null;
    owner?: RuntimeSessionOwner;
    toolProfile?: RuntimeToolProfile;
    /** Canonical attribution for this session's currently owning send. */
    getActivePageTurnAttribution?: ActivePageTurnAttributionGetter;
}

/**
 * pi-agent-core treats a resolved execute() promise as success unless its
 * afterToolCall hook explicitly overrides the error flag. Michi's built-in
 * tools return `{ isError: true }` for expected failures (sandbox rejection,
 * missing file, non-zero bash exit), so bridge that contract here.
 */
export function piToolResultErrorOverride(context: {
    result: unknown;
    isError: boolean;
}): { isError: true } | undefined {
    if (context.isError) return undefined;
    if (
        context.result
        && typeof context.result === "object"
        && (context.result as { isError?: unknown }).isError === true
    ) {
        return { isError: true };
    }
    return undefined;
}

function paramToTypebox(spec: ParamSpec, Type: any): any {
    if (spec === "string") return Type.String();
    if (spec === "number") return Type.Number();
    if (spec === "integer") return Type.Integer();
    if (spec === "boolean") return Type.Boolean();
    if ("array" in spec) return Type.Array(spec.array === "string" && spec.itemMinLength !== undefined ? Type.String({ minLength: spec.itemMinLength }) : paramToTypebox(spec.array, Type));
    const shape: Record<string, any> = {};
    for (const [k, v] of Object.entries(spec.object)) shape[k] = fieldToTypebox(v, Type);
    return Type.Object(shape, spec.additionalProperties === undefined ? {} : { additionalProperties: spec.additionalProperties });
}

/**
 * Wrap a tool's top-level parameter object with a required __tool_use_purpose
 * field so pi-agent-core's tool_execution_start event carries a one-line
 * description the UI can show next to the tool chip — same field Kiro path
 * extracts from kiro-cli's rawInput.
 */
function withPurposeField(parameters: ParamObjectShape, Type: any): any {
    const shape: Record<string, any> = {
        __tool_use_purpose: {
            ...Type.String(),
            description:
                "One short sentence stating why you're calling this tool — shown to the user as context. Always include this.",
        },
    };
    for (const [k, v] of Object.entries(parameters.object)) shape[k] = fieldToTypebox(v, Type);
    return Type.Object(shape);
}

function fieldToTypebox(field: ParamField, Type: any): any {
    let schema: any;
    if (field.enum && field.type === "string") {
        schema = field.enum.length > 0
            ? Type.Union(field.enum.map((v) => Type.Literal(v)))
            : Type.String();
    } else {
        schema = paramToTypebox(field.type, Type);
    }
    if (field.const !== undefined) schema = Type.Literal(field.const);
    for (const key of ['minimum', 'maximum', 'minLength', 'minItems'] as const) {
        if (field[key] !== undefined) schema = { ...schema, [key]: field[key] };
    }
    if (field.description) schema = { ...schema, description: field.description };
    return field.optional ? Type.Optional(schema) : schema;
}

/**
 * The Michi assistant's Pi tools: its own catalog (assistant/tools.ts) and
 * nothing else, so no native read/write/edit/bash tool exists in the session.
 */
function buildPiAssistantTools(opts: BuildPiToolsOpts): any[] {
    const owner = opts.owner;
    const nodeId = chatNodeOf(owner) ?? null;
    const requestApproval = opts.requestThreadMessageApproval;
    const requestJobApproval = opts.requestScheduledJobApproval;
    // No Desk tools while Agent Desk is off.
    return assistantToolsFor(assistantPurposeOf(nodeId)).map((tool) => ({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: withPurposeField(tool.parameters, opts.Type),
        ...(tool.sequential ? { executionMode: "sequential" as const } : {}),
        execute: async (_id: string, args: any, signal?: AbortSignal) => {
            const { __tool_use_purpose: _purpose, ...input } = (args ?? {}) as Record<string, unknown>;
            const result = await runAssistantTool(tool, {
                ownerUserId: opts.ownerUserId ?? null,
                workspaceId: opts.workspaceId,
                nodeId,
                approveThreadMessage: requestApproval
                    ? (request) => requestApproval(request, signal)
                    : async () => ({ approved: false, reason: "unavailable" }),
                approveScheduledJob: requestJobApproval
                    ? (request) => requestJobApproval(request, signal)
                    : async () => ({ approved: false, reason: "unavailable" }),
                getActivePageTurnAttribution: opts.getActivePageTurnAttribution,
            }, input);
            return { ...result, details: result };
        },
    }));
}

/** Pi's own tools for files and commands; the Scheduled window keeps these beside its Michi catalog. */
const PI_NATIVE_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "ls", "grep", "find", "write", "edit", "bash", "web_search"]);

export function buildPiTools(opts: BuildPiToolsOpts): any[] {
    // The assistant's catalog needs the profile and a chat in the assistant's
    // workspace; a profile session anywhere else gets no tools at all.
    if (opts.toolProfile?.restricted) {
        const home = chatNodeOf(opts.owner) !== undefined && isAssistantWorkspace(opts.workspaceId);
        return home ? buildPiAssistantTools(opts) : [];
    }
    const { bridge, cwd, parentChatId, workspaceId, enableFollowUps, imageQuota, seenPaths, Type, ownerUserId, emitImage } = opts;

    const builtinTools = listEnabledBuiltinTools().map((t): any => {
        if (PAGE_TOOL_NAMES.includes(t.name as PageToolName) && ((!opts.owner || hostOwner(opts.owner).kind !== 'chat_node') || isMaintenanceProfile(opts.toolProfile))) return null;
        // Search is opt-in. Omitting the tool entirely keeps an unconfigured
        // provider from causing the model to attempt a network request.
        if (t.name === "web_search" && !isWebSearchEnabled(ownerUserId ?? undefined)) return null;
        const parameters = withPurposeField(t.parameters, Type);

        switch (t.name) {
            case "michi_docs":
                return { name: t.name, label: "Michi docs", description: t.description, parameters,
                    execute: async (_id: string, args: any) => michiDocsTool(args) };
            case 'read_home':
            case 'edit_home':
            case 'list_pages':
            case 'read_page':
            case 'edit_page':
            case 'create_page':
            case 'create_database':
            case 'configure_database':
            case 'read_database':
            case 'edit_database':
            case 'list_page_components':
            case 'read_page_component':
            case 'save_page_component':
            case 'configure_database_view':
            case 'open_task_database':
            case 'list_tasks': {
                if (!PAGE_TOOL_NAMES.includes(t.name as PageToolName)) throw new Error(`unknown page tool: ${t.name}`);
                const name = t.name as PageToolName;
                return {
                    name,
                    label: name.replaceAll('_', ' '),
                    description: t.description,
                    parameters,
                    ...(['edit_home', 'edit_page', 'create_page', 'create_database', 'configure_database', 'edit_database', 'save_page_component', 'configure_database_view', 'open_task_database'].includes(name) ? { executionMode: 'sequential' as const } : {}),
                    execute: async (_id: string, args: any) => {
                        const { __tool_use_purpose: _purpose, ...input } = (args ?? {}) as Record<string, unknown>;
                        const result = runPageTool(name, {
                            ownerUserId: ownerUserId ?? null,
                            workspaceId: opts.workspaceId,
                            nodeId: (opts.owner && hostOwner(opts.owner).kind === 'chat_node') ? opts.owner.key : null,
                            ownerKind: opts.owner ? hostOwner(opts.owner).kind : null,
                            getActivePageTurnAttribution: opts.getActivePageTurnAttribution,
                        }, input);
                        return { ...result, details: result.details };
                    },
                };
            }
            case "open_url":
                return { name: t.name, label: "Open URL", description: t.description, parameters,
                    execute: async (_id: string, args: any) => openUrlTool({ workspaceId, ownerUserId,
                        nodeId: chatNodeOf(opts.owner) ?? null }, args.url) };
            // A business effect the bridge lacks offers no tool.
            case "spawn_branches":
                if (!bridge.spawnBranches) return null;
                return {
                    name: t.name,
                    label: "Spawn branches",
                    description: t.description,
                    parameters,
                    executionMode: "sequential" as const,
                    execute: async (_id: string, args: any) => {
                        const topics = Array.isArray(args?.topics) ? args.topics : [];
                        const created = await bridge.spawnBranches!({
                            parentChatId,
                            cwd,
                            enableFollowUps,
                            ownerUserId,
                            topics,
                        });
                        return {
                            content: [
                                { type: "text", text: `Spawned ${created.length} branches` },
                            ],
                            details: { created },
                        };
                    },
                };

            case "save_artifact":
                if (!bridge.saveContext) return null;
                return {
                    name: t.name,
                    label: "Save artifact",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        const result = bridge.saveContext!({
                            cwd,
                            chatId: parentChatId,
                            ownerUserId: opts.ownerUserId,
                            name: args.name,
                            body: args.body,
                            path: args.path,
                        });
                        if (!result) {
                            throw new Error(`Invalid context name: ${args.name}`);
                        }
                        return {
                            content: [
                                { type: "text", text: `Saved context: ${result.name}` },
                            ],
                            details: result,
                        };
                    },
                };

            case "update_artifact":
                if (!bridge.updateContext) return null;
                return {
                    name: t.name,
                    label: "Update artifact",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        const result = bridge.updateContext!({
                            cwd,
                            chatId: parentChatId,
                            ownerUserId: opts.ownerUserId,
                            name: args.name,
                            body: args.body,
                        });
                        if (!result) {
                            throw new Error(`Context does not exist or could not be updated: ${args.name}`);
                        }
                        return {
                            content: [
                                { type: "text", text: `Updated context: ${result.name}` },
                            ],
                            details: result,
                        };
                    },
                };

            case "show_image":
                return {
                    name: t.name,
                    label: "Show image",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        const r = resolveShowImage(cwd, String(args?.path ?? ""));
                        if (!r.ok) {
                            return {
                                content: [{ type: "text", text: `Error: ${r.error}` }],
                                details: { error: r.error },
                                isError: true,
                            };
                        }
                        const caption = typeof args?.caption === "string" ? args.caption : undefined;
                        emitImage?.({
                            kind: "host_event",
                            type: "image",
                            payload: {
                                path: r.relPath,
                                caption,
                                mimeType: r.mimeType,
                                size: r.size,
                            },
                        });
                        return {
                            content: [{ type: "text", text: `Displayed image to the user: ${r.relPath}` }],
                            details: { relPath: r.relPath, mimeType: r.mimeType, size: r.size, caption },
                        };
                    },
                };

            case "list_threads": {
                const gc = getRuntimeDeps().globalContext;
                if (!gc) return null;
                return {
                    name: t.name,
                    label: "List threads",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        const result = gc.listThreads(
                            workspaceId,
                            ownerUserId ?? null,
                            typeof args?.workspaceId === "string" ? args.workspaceId : undefined,
                            parentChatId,
                        );
                        return { content: [{ type: "text", text: result.text }], details: result };
                    },
                };
            }

            case "search_messages": {
                const gc = getRuntimeDeps().globalContext;
                if (!gc) return null;
                return {
                    name: t.name,
                    label: "Search messages",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        const result = gc.searchMessages(
                            workspaceId,
                            ownerUserId ?? null,
                            String(args?.query ?? ""),
                            args?.scope === "all" ? "all" : "current",
                            typeof args?.limit === "number" ? args.limit : 10,
                        );
                        return { content: [{ type: "text", text: result.text }], details: result };
                    },
                };
            }

            case "web_search":
                return {
                    name: t.name,
                    label: "Search the web",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        try {
                            const result = await searchWeb(String(args?.query ?? ""), {
                                maxResults: typeof args?.maxResults === "number" ? args.maxResults : undefined,
                                userId: ownerUserId ?? undefined,
                            });
                            return {
                                content: [{ type: "text", text: formatWebSearchForAgent(result) }],
                                details: result,
                            };
                        } catch (error) {
                            const message = error instanceof Error ? error.message : "Web search failed.";
                            return {
                                content: [{ type: "text", text: `Web search unavailable: ${message}` }],
                                details: { error: message },
                                isError: true,
                            };
                        }
                    },
                };

            case "read_node": {
                const gc = getRuntimeDeps().globalContext;
                if (!gc) return null;
                return {
                    name: t.name,
                    label: "Read node",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        const opts: { role?: "user" | "assistant"; from?: "head" | "tail"; offset?: number; limit?: number } = {};
                        if (args?.role === "user" || args?.role === "assistant") opts.role = args.role;
                        if (args?.from === "head" || args?.from === "tail") opts.from = args.from;
                        if (typeof args?.offset === "number") opts.offset = args.offset;
                        if (typeof args?.limit === "number") opts.limit = args.limit;
                        const hasOpts = Object.keys(opts).length > 0;
                        const result = gc.readNode(workspaceId, ownerUserId ?? null, String(args?.nodeId ?? ""), hasOpts ? opts : undefined);
                        return { content: [{ type: "text", text: result.text }], details: result };
                    },
                };
            }

            case "report_conversation_no_change": {
                const nodeId = chatNodeOf(opts.owner) ?? null;
                if (!nodeId) return null;
                return { name: t.name, label: "Report no conversation change", description: t.description, parameters,
                    execute: async (_id: string, args: unknown) => reportConversationNoChange({ nodeId, workspaceId }, args) };
            }

            case "read_conversation_updates": {
                return {
                    name: t.name, label: "Read conversation updates", description: t.description, parameters,
                    execute: async (_id: string, args: unknown) => readConversationUpdatesTool({
                        ownerUserId: ownerUserId ?? null, workspaceId, backendConnectionId: 'local',
                        runOwnerRunId: runIdOfOwner(opts.owner),
                    }, args),
                };
            }

            case "read_node_overview": {
                const gc = getRuntimeDeps().globalContext;
                if (!gc) return null;
                return {
                    name: t.name,
                    label: "Read node overview",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        const result = gc.readNodeOverview(workspaceId, ownerUserId ?? null, String(args?.nodeId ?? ""));
                        return { content: [{ type: "text", text: result.text }], details: result };
                    },
                };
            }

            case "inspect_pane": {
                const binding: PaneInspectionToolBinding = {
                    ownerUserId: ownerUserId ?? null,
                    workspaceId,
                    runOwnerRunId: runIdOfOwner(opts.owner),
                    backendConnectionId: 'local',
                };
                return {
                    name: t.name,
                    label: "Inspect pane",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        const result = inspectPaneTool(binding, {
                            paneId: typeof args?.paneId === "string" ? args.paneId : undefined,
                            nodeId: typeof args?.nodeId === "string" ? args.nodeId : undefined,
                            runId: typeof args?.runId === "string" ? args.runId : undefined,
                            executionRef: args?.executionRef,
                        });
                        return { ...result, details: result };
                    },
                };
            }

            case "read_pane_output": {
                const binding: PaneInspectionToolBinding = {
                    ownerUserId: ownerUserId ?? null,
                    workspaceId,
                    runOwnerRunId: runIdOfOwner(opts.owner),
                    backendConnectionId: 'local',
                };
                return {
                    name: t.name,
                    label: "Read pane output",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        const result = readPaneOutputTool(binding, {
                            paneId: typeof args?.paneId === "string" ? args.paneId : undefined,
                            nodeId: typeof args?.nodeId === "string" ? args.nodeId : undefined,
                            runId: typeof args?.runId === "string" ? args.runId : undefined,
                            selection: args?.selection,
                            executionRef: args?.executionRef,
                            outputId: typeof args?.outputId === "string" ? args.outputId : undefined,
                            pageCursor: typeof args?.pageCursor === "string" ? args.pageCursor : undefined,
                            limitBytes: typeof args?.limitBytes === "number" ? args.limitBytes : undefined,
                        });
                        return { ...result, details: result };
                    },
                };
            }

            case "list_panes": {
                const binding: PaneInspectionToolBinding = {
                    ownerUserId: ownerUserId ?? null,
                    workspaceId,
                    runOwnerRunId: runIdOfOwner(opts.owner),
                    backendConnectionId: 'local',
                };
                return {
                    name: t.name,
                    label: "List panes",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        const result = listPanesTool(binding, {
                            treeId: typeof args?.treeId === "string" ? args.treeId : undefined,
                            kind: args?.kind,
                            parentNodeId: typeof args?.parentNodeId === "string" ? args.parentNodeId : undefined,
                            scope: args?.scope,
                            includeArchived: typeof args?.includeArchived === "boolean" ? args.includeArchived : undefined,
                            limit: typeof args?.limit === "number" ? args.limit : undefined,
                            cursor: typeof args?.cursor === "string" ? args.cursor : undefined,
                        });
                        return { ...result, details: result };
                    },
                };
            }

            case "wait_pane": {
                const binding: PaneInspectionToolBinding = {
                    ownerUserId: ownerUserId ?? null,
                    workspaceId,
                    runOwnerRunId: runIdOfOwner(opts.owner),
                    backendConnectionId: 'local',
                };
                return {
                    name: t.name,
                    label: "Wait for pane",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        const result = await waitPaneTool(binding, {
                            paneId: typeof args?.paneId === "string" ? args.paneId : undefined,
                            nodeId: typeof args?.nodeId === "string" ? args.nodeId : undefined,
                            runId: typeof args?.runId === "string" ? args.runId : undefined,
                            until: args?.until,
                            cursor: typeof args?.cursor === "string" ? args.cursor : undefined,
                            executionRef: args?.executionRef,
                            timeoutMs: typeof args?.timeoutMs === "number" ? args.timeoutMs : undefined,
                        });
                        return { ...result, details: result };
                    },
                };
            }

            case "send_to_thread": {
                // Chat-only: an Agent Run (or an unowned session) has no
                // calling thread to attribute the message to.
                const nodeId = chatNodeOf(opts.owner);
                if (nodeId === undefined) return null;
                const requestApproval = opts.requestThreadMessageApproval;
                return {
                    name: t.name,
                    label: "Send to thread",
                    description: t.description,
                    parameters,
                    executionMode: "sequential" as const,
                    execute: async (_id: string, args: any, signal?: AbortSignal) => {
                        const result = await sendToThreadTool(
                            { ownerUserId: ownerUserId ?? null, workspaceId, nodeId, isAgentRun: false },
                            { nodeId: args?.nodeId, text: args?.text, requestApproval: args?.requestApproval },
                            requestApproval
                                ? (request) => requestApproval(request, signal)
                                : async () => ({ approved: false, reason: "unavailable" }),
                        );
                        return { ...result, details: result };
                    },
                };
            }

            case "list_scheduled_jobs":
            case "create_scheduled_job":
            case "update_scheduled_job":
            case "run_scheduled_job":
            case "delete_scheduled_job": {
                // Chat-only, like send_to_thread: approvals need a watching user.
                const nodeId = chatNodeOf(opts.owner);
                if (nodeId === undefined) return null;
                const toolName = t.name;
                const requestApproval = opts.requestScheduledJobApproval;
                return {
                    name: toolName,
                    label: SCHEDULED_JOB_TOOL_LABELS[toolName],
                    description: t.description,
                    parameters,
                    executionMode: "sequential" as const,
                    execute: async (_id: string, args: any, signal?: AbortSignal) => {
                        const result = await scheduledJobTool(
                            toolName,
                            { ownerUserId: ownerUserId ?? null, workspaceId, nodeId, isAgentRun: false },
                            args,
                            requestApproval
                                ? (request) => requestApproval(request, signal)
                                : async () => ({ approved: false, reason: "unavailable" }),
                        );
                        return { ...result, details: result };
                    },
                };
            }

            case "read":
                return {
                    name: t.name,
                    label: "Read file",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) =>
                        executeRead(
                            {
                                path: String(args?.path ?? ""),
                                offset: typeof args?.offset === "number" ? args.offset : undefined,
                                limit: typeof args?.limit === "number" ? args.limit : undefined,
                            },
                            cwd,
                            imageQuota,
                            seenPaths,
                        ),
                };

            case "ls":
                return {
                    name: t.name,
                    label: "List directory",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) =>
                        executeLs(
                            {
                                path: typeof args?.path === "string" ? args.path : undefined,
                                limit: typeof args?.limit === "number" ? args.limit : undefined,
                            },
                            cwd,
                        ),
                };

            case "grep":
                return {
                    name: t.name,
                    label: "Search files",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) =>
                        executeGrep(
                            {
                                pattern: String(args?.pattern ?? ""),
                                path: typeof args?.path === "string" ? args.path : undefined,
                                glob: typeof args?.glob === "string" ? args.glob : undefined,
                                ignoreCase: typeof args?.ignoreCase === "boolean" ? args.ignoreCase : undefined,
                                literal: typeof args?.literal === "boolean" ? args.literal : undefined,
                                context: typeof args?.context === "number" ? args.context : undefined,
                                limit: typeof args?.limit === "number" ? args.limit : undefined,
                            },
                            cwd,
                        ),
                };

            case "find":
                return {
                    name: t.name,
                    label: "Find files",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) =>
                        executeFind(
                            {
                                pattern: String(args?.pattern ?? ""),
                                path: typeof args?.path === "string" ? args.path : undefined,
                                limit: typeof args?.limit === "number" ? args.limit : undefined,
                            },
                            cwd,
                        ),
                };

            case "write":
                return {
                    name: t.name,
                    label: "Write file",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) =>
                        executeWrite(
                            {
                                path: String(args?.path ?? ""),
                                content: typeof args?.content === "string" ? args.content : "",
                            },
                            cwd,
                            seenPaths,
                        ),
                };

            case "edit":
                return {
                    name: t.name,
                    label: "Edit file",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) =>
                        executeEdit(
                            {
                                path: String(args?.path ?? ""),
                                old_string: typeof args?.old_string === "string" ? args.old_string : "",
                                new_string: typeof args?.new_string === "string" ? args.new_string : "",
                            },
                            cwd,
                            seenPaths,
                        ),
                };

            case "bash":
                return {
                    name: t.name,
                    label: "Run bash",
                    description: t.description,
                    parameters,
                    executionMode: "sequential" as const,
                    execute: async (_id: string, args: any, signal?: AbortSignal) =>
                        executeBash(
                            {
                                command: String(args?.command ?? ""),
                                cwd: typeof args?.cwd === "string" ? args.cwd : undefined,
                                timeoutMs: typeof args?.timeoutMs === "number" ? args.timeoutMs : undefined,
                            },
                            cwd,
                            { ownerUserId, signal },
                        ),
                };
        }
        throw new Error(`unknown builtin tool: ${(t as any).name}`);
    }).filter(Boolean);
    const tools = opts.agentRunTools
        ? [...builtinTools, ...buildPiAgentRunTools(opts.agentRunTools, Type)]
        : builtinTools;
    if (opts.toolProfile?.assistant) {
        if (chatNodeOf(opts.owner) === undefined || !isAssistantWorkspace(opts.workspaceId)) return [];
        const assistantTools = buildPiAssistantTools(opts);
        const names = new Set(assistantTools.map((tool) => tool.name));
        // The Scheduled window keeps only Pi's native tools beside its own
        // catalog: none of the ordinary Michi tools (Pages, artifacts, branches,
        // Agent Runs) bound to the assistant's hidden workspace.
        const scheduling = assistantPurposeOf(chatNodeOf(opts.owner)) === "schedule";
        const kept = tools.filter((tool) => !names.has(tool.name) && (!scheduling || PI_NATIVE_TOOL_NAMES.has(tool.name)));
        return [...kept, ...assistantTools];
    }
    const worker = runWorkerProfile(opts.owner, opts.toolProfile);
    return worker ? [...tools, buildSubmitAgentResultTool(opts.owner!, worker, Type)] : tools;
}

function runWorkerProfile(owner: RuntimeSessionOwner | undefined,
    profile: RuntimeToolProfile | undefined): RunWorkerToolProfile | null {
    if (!isRunOwner(owner) || !profile || !('runWorkerTools' in profile)) return null;
    if (!profile.allowedToolNames?.includes(SUBMIT_AGENT_RESULT_TOOL)) return null;
    const candidate = profile as RunWorkerToolProfile;
    return typeof candidate.runWorkerTools?.submitAgentResult === 'function' ? candidate : null;
}

function buildSubmitAgentResultTool(owner: RuntimeSessionOwner, profile: RunWorkerToolProfile, Type: any): any {
    return {
        name: SUBMIT_AGENT_RESULT_TOOL,
        label: 'Submit Agent result',
        description: SUBMIT_AGENT_RESULT_DEFINITION.description,
        parameters: paramToTypebox(SUBMIT_AGENT_RESULT_DEFINITION.parameters, Type),
        executionMode: 'sequential' as const,
        execute: async (_id: string, payload: unknown) => {
            profile.runWorkerTools.submitAgentResult(owner, payload);
            return { content: [{ type: 'text', text: 'Agent result submitted.' }], details: { submitted: true } };
        },
    };
}

function buildPiAgentRunTools(invoker: AgentRunToolInvoker, Type: any): any[] {
    return AGENT_RUN_TOOL_NAMES.map((name) => ({
        name,
        label: name.replace(/_/g, ' '),
        description: AGENT_RUN_TOOL_DEFINITIONS[name].description,
        parameters: paramToTypebox(AGENT_RUN_TOOL_DEFINITIONS[name].parameters, Type),
        executionMode: 'sequential' as const,
        execute: async (id: string, args: Record<string, unknown>) => {
            const result = await invoker.invoke(name, args ?? {}, { runtimeToolCallId: id || null });
            return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
        },
    }));
}
