/**
 * Michi's approval of a Pi SDK tool call covers exactly the arguments that run.
 *
 * The SDK hands one mutable `event.input` object to every extension's
 * tool_call handler in load order and then to the tool, with no re-validation
 * (ExtensionRunner.emitToolCall, agent-core prepareToolCall). An extension can
 * also keep that object and change it later: while Michi waits for the user,
 * or while the other calls of a parallel batch are prepared. So Michi decides
 * last, on a snapshot, refuses a call whose arguments changed during the
 * decision, and every guarded tool runs with a fresh copy of what was
 * approved, whatever happened to the live object.
 */

type ToolCallDecision = { block?: boolean; reason?: string } | undefined;

interface ToolCallEventLike {
    toolName: string;
    toolCallId: string;
    input: unknown;
}

interface ExecutableTool {
    name: string;
    execute: (toolCallId: string, args: any, ...rest: any[]) => unknown;
}

export const CHANGED_DURING_APPROVAL = 'The tool arguments changed while Michi was deciding whether to allow this call; it was not run.';
export const CHANGED_AFTER_APPROVAL = 'The tool arguments changed after Michi allowed this call; it was not run.';

/** The canonical form compared and replayed; undefined when it cannot be serialized (a cycle, a BigInt). */
function snapshot(value: unknown): string | undefined {
    try {
        const json = JSON.stringify(value ?? {});
        return typeof json === 'string' ? json : undefined;
    } catch {
        return undefined;
    }
}

export class PiToolApprovalLedger {
    /** Approved calls by toolCallId, consumed when the tool starts. */
    private readonly approved = new Map<string, { toolName: string; args: string }>();

    /**
     * Michi's tool_call handler, registered by the last extension so it sees
     * every earlier handler's changes. `decide` gets a copy of the arguments.
     */
    async decide(
        event: ToolCallEventLike,
        decide: (toolName: string, args: unknown) => Promise<ToolCallDecision> | ToolCallDecision,
    ): Promise<ToolCallDecision> {
        const { toolName, toolCallId } = event;
        const before = snapshot(event.input);
        if (before === undefined) {
            return { block: true, reason: 'The tool arguments could not be read for approval; the call was not run.' };
        }
        const result = await decide(toolName, JSON.parse(before));
        if (result?.block) return result;
        if (snapshot(event.input) !== before) return { block: true, reason: CHANGED_DURING_APPROVAL };
        this.approved.set(toolCallId, { toolName, args: before });
        return result;
    }

    /**
     * The tool as registered with the SDK: it runs only for a call Michi
     * approved under this name, with a copy of the approved arguments.
     */
    readonly guard = <T extends ExecutableTool>(tool: T): T => {
        const name = tool.name;
        const execute = async (toolCallId: string, args: unknown, ...rest: unknown[]) => {
            const approval = this.approved.get(toolCallId);
            this.approved.delete(toolCallId);
            if (!approval || approval.toolName !== name) throw new Error(`Michi did not allow this ${name} call; it was not run.`);
            if (snapshot(args) !== approval.args) throw new Error(CHANGED_AFTER_APPROVAL);
            return tool.execute(toolCallId, JSON.parse(approval.args), ...rest);
        };
        // A proxy keeps every other field (and any prototype) of the definition.
        return new Proxy(tool, {
            get: (target, key, receiver) => key === 'execute' ? execute : Reflect.get(target, key, receiver),
        });
    };

    /** Drops approvals whose calls never started (a stopped turn). */
    clear(): void {
        this.approved.clear();
    }
}
