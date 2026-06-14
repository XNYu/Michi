/**
 * Catalog of in-tree tools the Pi runtime exposes to the model. Each
 * runtime is responsible for rendering each tool's parameter shape into
 * its native schema language (Zod for the MCP server / Kiro path,
 * typebox for pi-ai) and for executing the matching handler.
 *
 * Coverage by runtime:
 *   - spawn_branches / save_context / update_context: BOTH (Kiro via mcpServer slot
 *     callbacks, Pi via piTools).
 *   - list_threads / search_messages / read_node: BOTH (services/globalContext
 *     functions; Kiro's MCP server registers them separately, Pi calls
 *     them directly through piTools).
 *   - read / ls / grep / find: PI ONLY. Kiro inherits its own filesystem
 *     tools from kiro-cli, so we don't expose ours through the MCP slot.
 *
 * Two-tier param model:
 *   ParamSpec is the simplified element shape (string / number / boolean /
 *   array / object). ParamField wraps a ParamSpec with field-level metadata
 *   (description, optional, enum). Object shapes use ParamField for each key
 *   so optional/enum work on the field — not on the value type itself.
 */

export type ParamPrimitive = "string" | "number" | "boolean";
export interface ParamArray { array: ParamSpec }
export interface ParamObjectShape { object: Record<string, ParamField> }
export type ParamSpec = ParamPrimitive | ParamArray | ParamObjectShape;

export interface ParamField {
    type: ParamSpec;
    description?: string;
    /** Default false. */
    optional?: boolean;
    /** Valid only when type === "string". When set, restricts the value to one of the listed strings. */
    enum?: readonly string[];
}

export type BuiltinToolName =
    | "spawn_branches"
    | "save_context"
    | "update_context"
    | "show_image"
    | "list_threads"
    | "search_messages"
    | "read_node"
    | "read"
    | "ls"
    | "grep"
    | "find"
    | "write"
    | "edit"
    | "bash";

export interface BuiltinTool {
    name: BuiltinToolName;
    description: string;
    parameters: ParamObjectShape;
}

const f = (
    type: ParamSpec,
    opts: { description?: string; optional?: boolean; enum?: readonly string[] } = {},
): ParamField => ({ type, ...opts });

export const BUILTIN_TOOLS: readonly BuiltinTool[] = [
    {
        name: "spawn_branches",
        description:
            "Fan out ≤5 child threads. Each inherits context. ONLY when user explicitly asks to branch/fan out/split.",
        parameters: {
            object: {
                topics: f({
                    array: { object: { title: f("string"), prompt: f("string") } },
                }),
            },
        },
    },
    {
        name: "save_context",
        description:
            "Save a named context block referenceable as @name. Use when user asks, or when you produced a reusable artifact (spec/summary/API).",
        parameters: { object: { name: f("string"), body: f("string") } },
    },
    {
        name: "update_context",
        description:
            "Update an existing named context block @name with a full replacement body. Use only when revising a context that already exists; use save_context for new contexts.",
        parameters: { object: { name: f("string"), body: f("string") } },
    },
    {
        name: "show_image",
        description:
            "Display an image to the USER, inline in your reply. Use ONLY when you want the human to see an image — a screenshot you captured, a chart/diagram you generated, or an existing image file. This does NOT load the image into your own context: to analyze an image yourself, use `read` instead. `path` must point to an image file (png/jpg/jpeg/gif/webp) inside the workspace.",
        parameters: {
            object: {
                path: f("string", { description: "Workspace-relative or workspace-absolute path to an image file." }),
                caption: f("string", { optional: true, description: "Optional caption shown under the image." }),
            },
        },
    },
    {
        name: "list_threads",
        description:
            "List threads (trees) and their nodes in this workspace as JSON. Use when user references prior work outside this thread. Not speculatively. Each thread has its own id (\"t-...\") and a nodes[] array; only node ids (\"n-...\") are valid input to read_node.",
        parameters: {
            object: {
                workspaceId: f("string", { optional: true, description: "Defaults to current." }),
            },
        },
    },
    {
        name: "search_messages",
        description:
            "Keyword search across workspace messages. Scope defaults to current workspace; pass 'all' only when user asked or current is empty.",
        parameters: {
            object: {
                query: f("string", { description: "Case-insensitive substring." }),
                scope: f("string", { optional: true, enum: ["current", "all"] }),
                limit: f("number", { optional: true, description: "1..50, default 10." }),
            },
        },
    },
    {
        name: "read_node",
        description:
            "Read a node's full transcript. Use AFTER list_threads/search_messages identified a relevant nodeId. Not speculatively.",
        parameters: { object: { nodeId: f("string") } },
    },
    {
        name: "read",
        description:
            "Read a file in the workspace. Text files return their content (truncated to 5000 lines / 150 KB). Image files (.png/.jpg/.jpeg/.gif/.webp) are returned as inline images, capped at 5 MB each. Use offset/limit for large files.",
        parameters: {
            object: {
                path: f("string", { description: "Path relative to the workspace, or absolute within the workspace." }),
                offset: f("number", { optional: true, description: "1-indexed first line. Default 1." }),
                limit: f("number", { optional: true, description: "Max lines to return after offset." }),
            },
        },
    },
    {
        name: "ls",
        description:
            "List a workspace directory. Alphabetical, dotfiles included, directories suffixed with /. Caps at 500 entries. Use to orient yourself before reading specific files.",
        parameters: {
            object: {
                path: f("string", { optional: true, description: "Defaults to the workspace root." }),
                limit: f("number", { optional: true, description: "Max entries. Default 500." }),
            },
        },
    },
    {
        name: "grep",
        description:
            "Search file contents in the workspace, respecting .gitignore. Returns 'path:line:text' lines. Default 100 matches, regex by default (set literal=true for plain string). Always prefer this over reading files when looking for specific content.",
        parameters: {
            object: {
                pattern: f("string", { description: "Regex pattern, or literal string when literal=true." }),
                path: f("string", { optional: true, description: "Subdirectory to search. Defaults to workspace root." }),
                glob: f("string", { optional: true, description: "Filter files by glob, e.g. '*.md' or '**/*.ts'." }),
                ignoreCase: f("boolean", { optional: true }),
                literal: f("boolean", { optional: true, description: "Treat pattern as a literal string." }),
                context: f("number", { optional: true, description: "Lines of context before/after each match." }),
                limit: f("number", { optional: true, description: "Max matches. Default 100." }),
            },
        },
    },
    {
        name: "find",
        description:
            "Locate files by glob pattern, respecting .gitignore. Returns relative paths. Default 1000 results.",
        parameters: {
            object: {
                pattern: f("string", { description: "Glob, e.g. '**/*.md' or 'src/**/*.ts'." }),
                path: f("string", { optional: true, description: "Subdirectory to search. Defaults to workspace root." }),
                limit: f("number", { optional: true, description: "Max results. Default 1000." }),
            },
        },
    },
    {
        name: "write",
        description:
            "Overwrite (or create) a file in the workspace. The user is asked to approve every call — only use when the user has clearly asked for a file to be written. If the target file already exists, you MUST read it first this session; otherwise the call is rejected to prevent clobbering content you haven't seen.",
        parameters: {
            object: {
                path: f("string", { description: "Path relative to the workspace, or absolute within it." }),
                content: f("string", { description: "Full new file contents." }),
            },
        },
    },
    {
        name: "edit",
        description:
            "Replace one occurrence of old_string with new_string in an existing file. You MUST read the file first this session — edit always rejects unread paths so you only modify text you've actually seen. old_string MUST be unique in the file; widen the surrounding context until it is. The user is asked to approve every call.",
        parameters: {
            object: {
                path: f("string", { description: "Path of the file to edit." }),
                old_string: f("string", { description: "Existing text. Must occur exactly once." }),
                new_string: f("string", { description: "Replacement text." }),
            },
        },
    },
    {
        name: "bash",
        description:
            "Run a bash command. cwd is only the starting directory — the command can still touch anything the user can. The user is asked to approve every call. Default timeout 30s, max 5 minutes. Output is tail-truncated.",
        parameters: {
            object: {
                command: f("string", { description: "Shell command. Use full pipelines/quotes as needed." }),
                cwd: f("string", { optional: true, description: "Subdirectory to run in. Defaults to the workspace root." }),
                timeoutMs: f("number", { optional: true, description: "Override timeout (ms). Default 30000, max 300000." }),
            },
        },
    },
];
