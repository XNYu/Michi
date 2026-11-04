/**
 * Tool calls whose outcome Michi cannot know. A Stop, a disposed session or a
 * backend that died can cut a tool off after it began: a file may be partly
 * written, a command partly run. The model must treat such a call neither as
 * never started nor as finished, so it is told the outcome is unknown and to
 * check before running the call again. Michi itself never reruns one.
 */

const CHECK_FIRST = 'Its outcome is unknown: it may have partly or fully taken effect. '
    + 'Check the current state before running it again.';

export const PI_STOPPED_TOOL_NOTE = `The user stopped this turn while this tool call was running, so it was interrupted. ${CHECK_FIRST}`;
export const PI_CLOSED_TOOL_NOTE = 'Michi closed this session (for example to restart) while this tool call was running, '
    + `so it was interrupted; the user did not stop it. ${CHECK_FIRST}`;

/** Who cut the call off: the user's Stop, or Michi closing the session (restart, shutdown, release). */
export type PiInterruptionCause = 'user' | 'session';
export const PI_UNFINISHED_TOOL_NOTE = 'Michi stopped (a restart or crash) while this tool call was running, '
    + `so no result was recorded. ${CHECK_FIRST}`;

type TextBlock = { type: 'text'; text: string };

function textOf(content: unknown): string {
    if (!Array.isArray(content)) return '';
    return content.map((block) => block && typeof block === 'object' && (block as TextBlock).type === 'text'
        ? (block as TextBlock).text : '').join('').trim();
}

/**
 * afterToolCall: a call that failed after the turn's stop was requested was
 * cut off mid-run (an aborted command, a cancelled request). A call that
 * finished first keeps its own result: its outcome is known.
 */
export function interruptedToolResult(
    context: { result: unknown; isError: boolean },
    signal?: AbortSignal,
    cause: PiInterruptionCause = 'user',
): { content: TextBlock[]; isError: true } | undefined {
    if (!signal?.aborted) return undefined;
    const result = context.result as { content?: unknown; isError?: unknown } | undefined;
    if (!context.isError && result?.isError !== true) return undefined;
    const output = textOf(result?.content);
    const note = cause === 'session' ? PI_CLOSED_TOOL_NOTE : PI_STOPPED_TOOL_NOTE;
    return {
        isError: true,
        content: [{ type: 'text', text: output ? `${note}\n\nOutput before the stop:\n${output}` : note }],
    };
}

/**
 * Results for the tool calls a restored transcript's last reply left
 * unanswered: the calls that were running when the process ended. Without
 * them the provider adapter fills in "No result provided", which reads as
 * "not run". A reply that ended aborted or in error is never sent to the
 * model, so its calls need no result.
 */
export function unfinishedToolResults(messages: readonly any[]): any[] {
    let last = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === 'assistant') { last = index; break; }
    }
    if (last < 0) return [];
    const reply = messages[last];
    if (reply.stopReason === 'aborted' || reply.stopReason === 'error' || !Array.isArray(reply.content)) return [];
    const answered = new Set(messages.slice(last + 1)
        .filter((message) => message?.role === 'toolResult')
        .map((message) => message.toolCallId));
    return reply.content
        .filter((block: any) => block?.type === 'toolCall' && typeof block.id === 'string' && !answered.has(block.id))
        .map((call: any) => ({
            role: 'toolResult',
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: 'text', text: PI_UNFINISHED_TOOL_NOTE }],
            isError: true,
            timestamp: Date.now(),
        }));
}
