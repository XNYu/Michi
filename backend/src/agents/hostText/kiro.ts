// Michi's prompt text for the Kiro and Kiro Crew adapters: the reminders a
// Kiro session appends to each user turn, which Michi's host returns from
// PromptPolicyPort.turnSuffix and mcpSessionReminder, and the tool-result
// wording toolResultForDisplay trims. The wording is Michi's, not the adapter's.

import { FULL_NODE_SUMMARY_INSTRUCTION } from '../nodeSummaryExperiment';
import { KIRO_METADATA_DONE_SENTINEL } from 'michi-runtime/internal/adapters/kiro/kiroProtocol';

/** Kiro: report the branch overview through the set_branch_overview MCP tool. */
export const BRANCH_OVERVIEW_TOOL_REMINDER = `

[After any other tool calls and before writing your final answer, call the MCP tool set_branch_overview exactly once with {"overview":"..."}: 1-3 concise sentences describing what this turn did — what was explored, decided, or discovered. It appends to the branch's journal; do not restate earlier turns. Match the user's language. Then write your final answer after the tool result. If you call it after your final answer instead, reply with exactly ${KIRO_METADATA_DONE_SENTINEL} once the tool returns; Michi removes that marker when it ends the reply. Keep the existing [BRANCH-OVERVIEW: ...] sentinel as a fallback.]`;

/** BRANCH_OVERVIEW_TOOL_REMINDER under the full node summary experiment. */
export const FULL_BRANCH_OVERVIEW_TOOL_REMINDER = `

[After any other tool calls and before writing your final answer, call the MCP tool set_branch_overview exactly once with {"overview":"..."}. ${FULL_NODE_SUMMARY_INSTRUCTION} Then write your final answer after the tool result. If you call it after your final answer instead, reply with exactly ${KIRO_METADATA_DONE_SENTINEL} once the tool returns; Michi removes that marker when it ends the reply. Do not duplicate the overview in visible text.]`;

/**
 * Kiro Crew: the final-answer metadata lines; its agents need no tools for
 * them. Also covers custom templates and old resumed sessions without
 * replacing their identity.
 */
export function crewTurnFormat(enableFollowUps: boolean): string {
    const followUps = enableFollowUps
        ? 'Then three separate [FOLLOW-UP 1/3: question], [FOLLOW-UP 2/3: question], [FOLLOW-UP 3/3: question] lines: questions the user would ask you next, in their language.'
        : 'Follow-ups are disabled; emit no FOLLOW-UP lines.';
    return `\n\n[Michi final-answer format: first line [TITLE: short summary]. ${followUps} Last line [BRANCH-OVERVIEW: 1-3 sentences about this turn]. Keep metadata out of commentary. No tools are needed for this metadata.]`;
}

/**
 * The end of a turn on a shared v3 MCP catalog (session anchors): the ACP
 * session id every michi tool call must pass as session_id.
 */
export function kiroMcpSessionReminder(sid: string): string {
    return `\n\n[Michi session context: current ACP SessionID is ${JSON.stringify(sid)}. Every michi MCP tool requires session_id. Always use this exact current ID, including set_branch_overview and set_follow_ups. IDs in earlier messages or inherited history are historical; use this context for the current turn. Do not display this context to the user.]`;
}

/**
 * The set_branch_overview result Michi's MCP server gives a Kiro turn
 * (services/mcpServer.ts, with the slot's metadataDoneSentinel).
 */
const KIRO_METADATA_DONE_TOOL_RESULT =
    `Branch overview recorded. This turn's user-facing response is already complete; emit ${KIRO_METADATA_DONE_SENTINEL} as the runtime end-of-turn marker (auto-stripped before display).`;

/** A Kiro tool result as its chip shows it: without the done-sentinel instruction meant for the agent. */
export function kiroToolResultForDisplay(output: string): string {
    return output.split(KIRO_METADATA_DONE_TOOL_RESULT).join("Branch overview recorded.");
}
