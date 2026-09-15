/**
 * Catalog of in-tree tools the Pi runtime exposes to the model. Each
 * runtime is responsible for rendering each tool's parameter shape into
 * its native schema language (Zod for the MCP server / Kiro path,
 * typebox for pi-ai) and for executing the matching handler.
 *
 * Coverage by runtime:
 *   - spawn_branches / save_artifact / update_artifact: BOTH (Kiro via mcpServer slot
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
    | "save_artifact"
    | "update_artifact"
    | "show_image"
    | "list_threads"
    | "search_messages"
    | "read_node"
    | "read_node_overview"
    | "inspect_pane"
    | "read_pane_output"
    | "list_panes"
    | "wait_pane"
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
        name: "save_artifact",
        description:
            "Save a named artifact referenceable as @name. Use when user asks, or when you produced a reusable artifact (spec/summary/API/code/links). Artifacts are project-level files that persist across conversations. " +
            "Artifacts are stored as `.contexts/<name>.md` in the workspace. " +
            "If you already wrote the file directly (via write/edit tools), the artifact is already saved — do NOT call this tool redundantly.",
        parameters: {
            object: {
                name: f("string"),
                body: f("string", {
                    description: "The full artifact content as text. Must be the actual document text, NOT a file path.",
                }),
            },
        },
    },
    {
        name: "update_artifact",
        description:
            "Update an existing named artifact @name with a full replacement body. Use only when revising an artifact that already exists; use save_artifact for new artifacts. " +
            "Artifacts are stored as `.contexts/<name>.md` in the workspace. " +
            "If you already edited the file directly (via write/edit tools), the artifact is already updated — do NOT call this tool redundantly.",
        parameters: {
            object: {
                name: f("string"),
                body: f("string", {
                    description: "The complete new content of the artifact as text. Must be the actual document text, NOT a file path.",
                }),
            },
        },
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
            "Read a node's transcript. Supports pagination via from/offset/limit and role filtering. " +
            "Without options, returns the most recent messages within a 12KB cap (tail-biased). " +
            "Use AFTER list_threads/search_messages identified a relevant nodeId.",
        parameters: {
            object: {
                nodeId: f("string"),
                role: f("string", {
                    optional: true,
                    enum: ["user", "assistant"],
                    description: "Filter to only user or assistant messages.",
                }),
                from: f("string", {
                    optional: true,
                    enum: ["head", "tail"],
                    description: "Read direction. 'head' starts from oldest, 'tail' (default) from newest.",
                }),
                offset: f("number", {
                    optional: true,
                    description: "1-based offset from the 'from' direction. Default 1.",
                }),
                limit: f("number", {
                    optional: true,
                    description: "Max messages to return. Default: 12KB size cap.",
                }),
            },
        },
    },
    {
        name: "read_node_overview",
        description:
            "Read a node's branch overview journal — a chronological summary of each turn, plus message count. " +
            "Much lighter than read_node; use to decide whether and what to read in detail. " +
            "Use AFTER list_threads identified a relevant nodeId.",
        parameters: { object: { nodeId: f("string") } },
    },
    {
        name: "inspect_pane",
        description:
            "Inspect one pane (a chat thread, digest, artifact, or Agent Run) by its paneId/nodeId/runId — exactly one " +
            "of those three locates it. Returns identity, current activity, message/turn counts, lineage, runtime " +
            "binding, and a short latest-output preview. Read-only; does not load full conversation history — use " +
            "read_pane_output for that. Optionally pass executionRef to inspect a specific historical turn/run " +
            "instead of the most recent one.",
        parameters: {
            object: {
                paneId: f("string", { optional: true, description: "Opaque pane id from a prior inspect/list result." }),
                nodeId: f("string", { optional: true, description: "A chat/digest/artifact node id (mutually exclusive with paneId/runId)." }),
                runId: f("string", { optional: true, description: "An Agent Run id (mutually exclusive with paneId/nodeId)." }),
                executionRef: f({
                    object: {
                        kind: f("string", { enum: ["chat_turn", "agent_run"] }),
                        nodeId: f("string", { optional: true, description: "Required when kind is chat_turn." }),
                        turnId: f("string", { optional: true, description: "Required when kind is chat_turn." }),
                        runId: f("string", { optional: true, description: "Required when kind is agent_run." }),
                    },
                }, { optional: true, description: "Inspect this specific historical execution instead of the latest one." }),
            },
        },
    },
    {
        name: "read_pane_output",
        description:
            "Read the (possibly paginated) output text of one pane's chat turn or Agent Run — the content behind " +
            "inspect_pane's short preview. selection picks 'latest' (default, may be partial/streaming), " +
            "'last_completed' (only a successfully committed execution), or 'execution' (a specific historical " +
            "execution named by executionRef). Use pageCursor from a prior call's nextPageCursor to continue " +
            "reading; a changed nextPageCursor means the underlying output moved on and must be re-read fresh.",
        parameters: {
            object: {
                paneId: f("string", { optional: true, description: "Opaque pane id from a prior inspect/list result." }),
                nodeId: f("string", { optional: true, description: "A chat node id (mutually exclusive with paneId/runId)." }),
                runId: f("string", { optional: true, description: "An Agent Run id (mutually exclusive with paneId/nodeId)." }),
                selection: f("string", { optional: true, enum: ["latest", "last_completed", "execution"], description: "Default 'latest'." }),
                executionRef: f({
                    object: {
                        kind: f("string", { enum: ["chat_turn", "agent_run"] }),
                        nodeId: f("string", { optional: true, description: "Required when kind is chat_turn." }),
                        turnId: f("string", { optional: true, description: "Required when kind is chat_turn." }),
                        runId: f("string", { optional: true, description: "Required when kind is agent_run." }),
                    },
                }, { optional: true, description: "Required when selection is 'execution'." }),
                outputId: f("string", { optional: true, description: "Re-request this specific prior output identity." }),
                pageCursor: f("string", { optional: true, description: "Continue a prior paginated read." }),
                limitBytes: f("number", { optional: true, description: "Max UTF-8 bytes per page. Default 16384, max 65536." }),
            },
        },
    },
    {
        name: "list_panes",
        description:
            "List panes (chat threads, digests, artifacts, Agent Runs, and open UI surfaces) in the caller's own " +
            "workspace — never another workspace or backend. scope='open' (default) lists only panes a renderer " +
            "currently reports as open; scope='all' lists every permitted persistent object plus still-open " +
            "surfaces. Returns compact summaries (title, activity, latest execution outcome, how many views have " +
            "it open) — NOT output content; use inspect_pane/read_pane_output for that. includeArchived defaults " +
            "false. Use cursor from a prior call's nextCursor to page through the rest.",
        parameters: {
            object: {
                treeId: f("string", { optional: true, description: "Only panes in this tree." }),
                kind: f("string", {
                    optional: true,
                    enum: ["chat", "agent-run", "digest", "artifact", "launcher", "files", "review", "file", "diff", "terminal", "browser"],
                    description: "Only panes of this kind.",
                }),
                parentNodeId: f("string", { optional: true, description: "Only chat panes whose parent node is this id." }),
                scope: f("string", { optional: true, enum: ["open", "all"], description: "Default 'open'." }),
                includeArchived: f("boolean", { optional: true, description: "Default false." }),
                limit: f("number", { optional: true, description: "Page size. Default 20, max 100." }),
                cursor: f("string", { optional: true, description: "Continue a prior paginated list." }),
            },
        },
    },
    {
        name: "wait_pane",
        description:
            "Block, up to timeoutMs, until a pane changes or a specific execution reaches a terminal state — use " +
            "instead of polling inspect_pane in a loop. until='changed' requires cursor (from a prior " +
            "inspect_pane/list_panes/wait_pane result) and returns as soon as anything about the pane differs from " +
            "that cursor's snapshot, immediately if it already has. until='terminal' requires executionRef naming " +
            "a turn/run that has already started (a still-queued chat has no turnId yet and can only use " +
            "'changed') and returns once THAT execution completes/fails/is cancelled — a later execution starting " +
            "on the same pane does not satisfy it. timeoutMs defaults to 20000ms, max 30000ms; on timeout, reason " +
            "is 'timed_out' and nothing is cancelled — call again to keep waiting. At most 8 concurrent waits are " +
            "allowed per caller.",
        parameters: {
            object: {
                paneId: f("string", { optional: true, description: "Opaque pane id from a prior inspect/list result." }),
                nodeId: f("string", { optional: true, description: "A chat/digest/artifact node id (mutually exclusive with paneId/runId)." }),
                runId: f("string", { optional: true, description: "An Agent Run id (mutually exclusive with paneId/nodeId)." }),
                until: f("string", { enum: ["changed", "terminal"], description: "Which condition ends the wait." }),
                cursor: f("string", { optional: true, description: "Required when until is 'changed'." }),
                executionRef: f({
                    object: {
                        kind: f("string", { enum: ["chat_turn", "agent_run"] }),
                        nodeId: f("string", { optional: true, description: "Required when kind is chat_turn." }),
                        turnId: f("string", { optional: true, description: "Required when kind is chat_turn." }),
                        runId: f("string", { optional: true, description: "Required when kind is agent_run." }),
                    },
                }, { optional: true, description: "Required when until is 'terminal'; names the execution to wait for." }),
                timeoutMs: f("number", { optional: true, description: "Max wait, ms. Default 20000, max 30000." }),
            },
        },
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
