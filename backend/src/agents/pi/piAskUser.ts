import type { UserInputAnswer, UserInputOption, UserInputQuestion } from "michi-shared";

/** Same name, schema and result text as the MCP ask_user other runtimes use. */
export const PI_ASK_USER_TOOL = "ask_user";

/**
 * Pi gets its system prompt from buildPreamble (like Kiro), not from
 * buildStableSystemPrompt, whose native-question line names Claude's own
 * AskUserQuestion tool. This is that line for Pi's single question tool.
 */
export const PI_ASK_USER_INSTRUCTION =
    "Use the ask_user tool for structured questions when you need the user to choose or clarify something before continuing. "
    + "It is connected to the user interface and waits for the user's answer; the user can also type their own answer.";

const NOT_ANSWERED = "The user did not answer the questions (skipped or timed out).";

/** Shows the questions and resolves the answers, or null when skipped, timed out or cancelled. */
export type PiUserInputRequester = (
    questions: UserInputQuestion[],
    signal?: AbortSignal,
) => Promise<UserInputAnswer[] | null>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalized questions, or an error message for the model. Mirrors the MCP host's validation. */
function parseQuestions(raw: unknown): UserInputQuestion[] | string {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) return "questions must be an array of 1-4 questions.";
    const questions: UserInputQuestion[] = [];
    for (const [i, entry] of raw.entries()) {
        if (!isRecord(entry) || typeof entry.question !== "string" || entry.question.trim() === "") {
            return `questions[${i}].question must be a non-empty string.`;
        }
        if (!Array.isArray(entry.options) || entry.options.length < 2 || entry.options.length > 4) {
            return `questions[${i}].options must list 2-4 options.`;
        }
        const options: UserInputOption[] = [];
        for (const [j, option] of entry.options.entries()) {
            if (!isRecord(option) || typeof option.label !== "string" || option.label.trim() === "") {
                return `questions[${i}].options[${j}].label must be a non-empty string.`;
            }
            options.push(typeof option.description === "string"
                ? { label: option.label, description: option.description }
                : { label: option.label });
        }
        questions.push({
            question: entry.question,
            ...(typeof entry.header === "string" ? { header: entry.header } : {}),
            options,
            multiSelect: entry.multiSelect === true,
        });
    }
    return questions;
}

/**
 * ask_user for pi-agent-core / the Pi SDK. Sequential so a batch never shows
 * two questions at once: the host tracks one pending question per turn.
 */
export function buildPiAskUserTool(Type: any, requestUserInput: PiUserInputRequester): any {
    const option = Type.Object({
        label: Type.String({ description: "Display text for this option (1-5 words)." }),
        description: Type.Optional(Type.String({ description: "Explanation of what this option means." })),
    });
    const question = Type.Object({
        question: Type.String({ description: "The question to ask the user." }),
        header: Type.Optional(Type.String({ description: "Short label (max 12 chars) displayed as a chip/tag." })),
        options: Type.Array(option, { minItems: 2, maxItems: 4, description: "Available choices (2-4 options)." }),
        multiSelect: Type.Optional(Type.Boolean({ description: "Allow multiple selections. Defaults to false." })),
    });
    return {
        name: PI_ASK_USER_TOOL,
        label: "Ask user",
        description:
            "Ask the user one or more structured questions with selectable options. "
            + "Use when you need the user to make a choice or provide input before proceeding. "
            + "Each question can be single-select or multi-select, and users can always type a custom answer.",
        parameters: Type.Object({
            questions: Type.Array(question, { minItems: 1, maxItems: 4, description: "Questions to ask (1-4)." }),
        }),
        executionMode: "sequential" as const,
        execute: async (_id: string, args: any, signal?: AbortSignal) => {
            const questions = parseQuestions(args?.questions);
            if (typeof questions === "string") {
                return { content: [{ type: "text", text: questions }], details: { error: questions }, isError: true };
            }
            const answers = await requestUserInput(questions, signal);
            // A stopped turn must not continue with an answer that arrived late.
            signal?.throwIfAborted();
            if (!answers) return { content: [{ type: "text", text: NOT_ANSWERED }], details: { answered: false } };
            const byQuestion: Record<string, string> = {};
            for (const answer of answers) byQuestion[answer.question] = answer.answer;
            return {
                content: [{ type: "text", text: JSON.stringify({ answers: byQuestion }) }],
                details: { answered: true, answers },
            };
        },
    };
}
