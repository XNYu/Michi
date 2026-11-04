import type { PlanEntry } from "michi-shared";

/**
 * Pi's todo/plan tool, in the spirit of the rpiv-todo Pi extension: the model
 * keeps one checklist for the session with add / update / remove / replace
 * actions. Every change returns the whole list, and `details.plan` carries the
 * PlanEntry snapshot that eventMapper turns into the normalized `plan` event.
 * From there the plan follows the same path as every runtime's: durable turn
 * projection, message metadata, replay and hydration.
 *
 * The list belongs to one PiSession and is never shared. A new or restored
 * session is seeded with the host's persisted plan (the node's own latest, else
 * its branch parent's at the cut), so a branch starts from a copy and cannot
 * change its parent.
 */

export const PI_TODO_TOOL_NAME = "todo";

const TODO_ACTIONS = ["list", "add", "update", "remove", "replace"] as const;
const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;

type TodoAction = typeof TODO_ACTIONS[number];
type TodoStatus = PlanEntry["status"];

const MAX_TODO_ITEMS = 50;
const MAX_TODO_CONTENT_LENGTH = 500;

interface TodoItem {
    id: number;
    content: string;
    status: TodoStatus;
    /** Kept from a seeded plan (another runtime may set it); new items are medium. */
    priority: PlanEntry["priority"];
}

interface TodoResultDetails {
    action: TodoAction;
    /** False for list and for a failed call: no plan event is emitted. */
    changed: boolean;
    todos: TodoItem[];
    plan: PlanEntry[];
}

/** An invalid call. The message is returned to the model as the tool error. */
class TodoInputError extends Error {}

function isStatus(value: unknown): value is TodoStatus {
    return typeof value === "string" && (TODO_STATUSES as readonly string[]).includes(value);
}

function isAction(value: unknown): value is TodoAction {
    return typeof value === "string" && (TODO_ACTIONS as readonly string[]).includes(value);
}

function parseContent(value: unknown, where: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new TodoInputError(`${where}: content must be a non-empty string.`);
    }
    const content = value.trim();
    if (content.length > MAX_TODO_CONTENT_LENGTH) {
        throw new TodoInputError(`${where}: content is longer than ${MAX_TODO_CONTENT_LENGTH} characters.`);
    }
    return content;
}

function parseStatus(value: unknown, where: string): TodoStatus {
    if (!isStatus(value)) {
        throw new TodoInputError(`${where}: status must be one of ${TODO_STATUSES.join(", ")}.`);
    }
    return value;
}

function parseItems(value: unknown, action: TodoAction): Array<{ content: string; status: TodoStatus }> {
    if (!Array.isArray(value)) {
        throw new TodoInputError(`${action} needs items: an array of { content, status? }.`);
    }
    return value.map((raw, index) => {
        const where = `items[${index}]`;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            throw new TodoInputError(`${where} must be an object with content and an optional status.`);
        }
        const item = raw as Record<string, unknown>;
        return {
            content: parseContent(item.content, where),
            status: item.status === undefined ? "pending" : parseStatus(item.status, where),
        };
    });
}

function assertBounds(items: readonly TodoItem[]): void {
    if (items.length > MAX_TODO_ITEMS) {
        throw new TodoInputError(`The todo list can hold at most ${MAX_TODO_ITEMS} items; it would have ${items.length}.`);
    }
    const active = items.filter((item) => item.status === "in_progress");
    if (active.length > 1) {
        throw new TodoInputError(
            `Only one item can be in_progress at a time (would be ${active.map((item) => `#${item.id}`).join(", ")}). `
            + "Mark the current item completed or pending first.",
        );
    }
}

/**
 * One session's todo list. Each call validates the whole next state before
 * committing it, so a rejected call leaves the list unchanged.
 */
export class PiTodoList {
    private items: TodoItem[] = [];
    private nextId = 1;

    /**
     * Seed from a persisted plan. Entries that no call could create are
     * dropped or clipped, and extra in_progress items become pending, so the
     * list starts within the same bounds every call enforces.
     */
    constructor(seed?: readonly PlanEntry[] | null) {
        let active = false;
        for (const entry of seed ?? []) {
            if (this.items.length >= MAX_TODO_ITEMS) break;
            const content = typeof entry?.content === "string" ? entry.content.trim().slice(0, MAX_TODO_CONTENT_LENGTH) : "";
            if (!content) continue;
            let status: TodoStatus = isStatus(entry.status) ? entry.status : "pending";
            if (status === "in_progress") {
                if (active) status = "pending";
                active = true;
            }
            const priority = entry.priority === "high" || entry.priority === "low" ? entry.priority : "medium";
            this.items.push({ id: this.nextId++, content, status, priority });
        }
    }

    todos(): TodoItem[] {
        return this.items.map((item) => ({ ...item }));
    }

    plan(): PlanEntry[] {
        return this.items.map(({ content, priority, status }) => ({ content, priority, status }));
    }

    /** Apply one tool call. Throws TodoInputError without changing the list. */
    apply(args: Record<string, unknown>): { action: TodoAction; changed: boolean } {
        const action = args.action;
        if (!isAction(action)) {
            throw new TodoInputError(`action must be one of ${TODO_ACTIONS.join(", ")}.`);
        }
        if (action === "list") return { action, changed: false };

        let next: TodoItem[];
        let nextId = this.nextId;
        if (action === "add") {
            const added = parseItems(args.items, action);
            if (added.length === 0) throw new TodoInputError("add needs at least one item.");
            next = [...this.todos(), ...added.map((item) => ({ ...item, id: nextId++, priority: "medium" as const }))];
        } else if (action === "replace") {
            // An empty array clears the list. Ids restart so they stay short.
            nextId = 1;
            next = parseItems(args.items, action).map((item) => ({ ...item, id: nextId++, priority: "medium" as const }));
        } else {
            const id = args.id;
            if (typeof id !== "number" || !Number.isInteger(id)) {
                throw new TodoInputError(`${action} needs id: the number of an item in the list.`);
            }
            const index = this.items.findIndex((item) => item.id === id);
            if (index < 0) {
                const ids = this.items.map((item) => `#${item.id}`).join(", ");
                throw new TodoInputError(`There is no item #${id}. ${ids ? `Current items: ${ids}.` : "The list is empty."}`);
            }
            next = this.todos();
            if (action === "remove") {
                next.splice(index, 1);
            } else {
                if (args.content === undefined && args.status === undefined) {
                    throw new TodoInputError("update needs content, status or both.");
                }
                const item = next[index];
                if (args.content !== undefined) item.content = parseContent(args.content, `item #${id}`);
                if (args.status !== undefined) item.status = parseStatus(args.status, `item #${id}`);
            }
        }
        assertBounds(next);
        this.items = next;
        this.nextId = nextId;
        return { action, changed: true };
    }
}

function renderTodos(todos: readonly TodoItem[]): string {
    if (todos.length === 0) return "The todo list is empty.";
    const done = todos.filter((item) => item.status === "completed").length;
    return [
        `Todo list (${done} of ${todos.length} completed):`,
        ...todos.map((item) => `#${item.id} [${item.status}] ${item.content}`),
    ].join("\n");
}

/** Execute one call against a list, in the result shape Pi's other tools use. */
function runPiTodoTool(list: PiTodoList, rawArgs: unknown): any {
    const { __tool_use_purpose: _purpose, ...args } = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
    try {
        const { action, changed } = list.apply(args);
        const details: TodoResultDetails = { action, changed, todos: list.todos(), plan: list.plan() };
        return { content: [{ type: "text", text: renderTodos(details.todos) }], details };
    } catch (error) {
        if (!(error instanceof TodoInputError)) throw error;
        const message = `${error.message} The todo list was not changed.\n\n${renderTodos(list.todos())}`;
        return { content: [{ type: "text", text: `Error: ${message}` }], details: { error: error.message }, isError: true };
    }
}

/** The plan a successful, state-changing todo result reports; null otherwise. */
export function todoPlanFromResult(result: unknown): PlanEntry[] | null {
    const details = (result as { details?: Partial<TodoResultDetails> } | null | undefined)?.details;
    if (!details || details.changed !== true || !Array.isArray(details.plan)) return null;
    return details.plan.map((entry) => ({ content: entry.content, priority: entry.priority, status: entry.status }));
}

const TODO_DESCRIPTION = [
    "Keep a todo list for multi-step work. Michi shows it to the user as the plan of this conversation.",
    "Use it when a task has several steps: add the steps, mark one in_progress when you start it,",
    "and mark it completed as soon as it is done. Keep at most one item in_progress.",
    "Actions: list (show the list), add (append items), update (change one item's content and/or status by id),",
    "remove (delete one item by id), replace (replace the whole list; an empty items array clears it).",
    "The list persists across turns and may already hold items from earlier in this conversation",
    "or from the conversation this branch came from. Every result shows the whole list with item ids.",
].join(" ");

/** The Pi AgentTool for one session's list. `Type` is pi-ai's typebox namespace. */
export function buildPiTodoTool(list: PiTodoList, Type: any): any {
    const status = () => Type.Union(TODO_STATUSES.map((value) => Type.Literal(value)));
    return {
        name: PI_TODO_TOOL_NAME,
        label: "Todo list",
        description: TODO_DESCRIPTION,
        parameters: Type.Object({
            __tool_use_purpose: Type.Optional(Type.String({
                description: "One short sentence stating why you're calling this tool, shown to the user as context.",
            })),
            action: Type.Union(TODO_ACTIONS.map((value) => Type.Literal(value)), {
                description: "list, add, update, remove or replace.",
            }),
            items: Type.Optional(Type.Array(Type.Object({
                content: Type.String({ description: "What the step is, in a short imperative sentence." }),
                status: Type.Optional(status()),
            }), { description: "For add and replace: the items, in order. status defaults to pending." })),
            id: Type.Optional(Type.Integer({ description: "For update and remove: the item id shown in the list." })),
            content: Type.Optional(Type.String({ description: "For update: the item's new text." })),
            status: Type.Optional(status()),
        }),
        // Calls in one response mutate the same list; keep their order.
        executionMode: "sequential" as const,
        execute: async (_id: string, args: unknown) => runPiTodoTool(list, args),
    };
}
