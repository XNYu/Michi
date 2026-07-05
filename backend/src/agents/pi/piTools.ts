import type { AgentToolBridge } from "../toolBridge";
import {
    BUILTIN_TOOLS,
    type ParamField,
    type ParamObjectShape,
    type ParamSpec,
} from "../builtinTools";
import { getRuntimeDeps } from "../runtimeDeps";
import { executeRead, type TurnImageQuota } from "../tools/read";
import { executeLs } from "../tools/ls";
import { executeGrep } from "../tools/grep";
import { executeFind } from "../tools/find";
import { executeWrite } from "../tools/write";
import { executeEdit } from "../tools/edit";
import { executeBash } from "../tools/bash";
import { resolveShowImage } from "../claude/showImage";
import type { NormalizedEvent } from "../../services/chatEvents";

/**
 * Build the AgentTool[] array fed to pi-agent-core.
 *
 * Title and follow-ups are emitted as inline `[TITLE:]` / `[FOLLOW-UP n/3:]`
 * sentinels in the LLM's text stream — not as tools — so this factory
 * handles the side-effect tools (spawn_branches, save_context, update_context) and the
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
     * Null / undefined on desktop — falls through to full process.env.
     */
    ownerUserId?: string | null;
    /**
     * Push a side-effect NormalizedEvent (e.g. an inline `image`) into the
     * active turn's event queue. show_image uses this to render an image in the
     * UI without feeding it into the LLM's context. No-op if no turn is active.
     */
    emitImage?: (ev: NormalizedEvent) => void;
}

function paramToTypebox(spec: ParamSpec, Type: any): any {
    if (spec === "string") return Type.String();
    if (spec === "number") return Type.Number();
    if (spec === "boolean") return Type.Boolean();
    if ("array" in spec) return Type.Array(paramToTypebox(spec.array, Type));
    const shape: Record<string, any> = {};
    for (const [k, v] of Object.entries(spec.object)) shape[k] = fieldToTypebox(v, Type);
    return Type.Object(shape);
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
    if (field.description) schema = { ...schema, description: field.description };
    return field.optional ? Type.Optional(schema) : schema;
}

export function buildPiTools(opts: BuildPiToolsOpts): any[] {
    const { bridge, cwd, parentChatId, workspaceId, enableFollowUps, imageQuota, seenPaths, Type, ownerUserId, emitImage } = opts;

    return BUILTIN_TOOLS.map((t): any => {
        const parameters = withPurposeField(t.parameters, Type);

        switch (t.name) {
            case "spawn_branches":
                return {
                    name: t.name,
                    label: "Spawn branches",
                    description: t.description,
                    parameters,
                    executionMode: "sequential" as const,
                    execute: async (_id: string, args: any) => {
                        const topics = Array.isArray(args?.topics) ? args.topics : [];
                        const created = await bridge.spawnBranches({
                            parentChatId,
                            cwd,
                            enableFollowUps,
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

            case "save_context":
                return {
                    name: t.name,
                    label: "Save context",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        const result = bridge.saveContext({
                            cwd,
                            name: args.name,
                            body: args.body,
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

            case "update_context":
                return {
                    name: t.name,
                    label: "Update context",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        const result = bridge.updateContext({
                            cwd,
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
                            };
                        }
                        const caption = typeof args?.caption === "string" ? args.caption : undefined;
                        emitImage?.({
                            kind: "image",
                            path: r.relPath,
                            caption,
                            mimeType: r.mimeType,
                            size: r.size,
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

            case "read_node": {
                const gc = getRuntimeDeps().globalContext;
                if (!gc) return null;
                return {
                    name: t.name,
                    label: "Read node",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        const result = gc.readNode(workspaceId, ownerUserId ?? null, String(args?.nodeId ?? ""));
                        return { content: [{ type: "text", text: result.text }], details: result };
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
                    execute: async (_id: string, args: any) =>
                        executeBash(
                            {
                                command: String(args?.command ?? ""),
                                cwd: typeof args?.cwd === "string" ? args.cwd : undefined,
                                timeoutMs: typeof args?.timeoutMs === "number" ? args.timeoutMs : undefined,
                            },
                            cwd,
                            { ownerUserId },
                        ),
                };
        }
        throw new Error(`unknown builtin tool: ${(t as any).name}`);
    }).filter(Boolean);
}
