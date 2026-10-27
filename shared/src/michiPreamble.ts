// The exact lines that open and close the preamble Michi glues onto the
// first message of a Kiro conversation (backend/src/agents/preamble.ts,
// buildPreamble). Keep these stable for persisted runtime conversations.
// Backend tests pin the preamble to these lines.

/** The preamble's first line. */
export const MICHI_PREAMBLE_HEAD = 'You are a knowledge-exploration assistant inside a visual "workspace" app.';

/** The line that ends the preamble; the user's own words follow it. */
export const MICHI_PREAMBLE_TAIL = 'The user will now speak.';

/**
 * The exact opening of the Michi assistant's instructions
 * (backend/src/assistant/policy.ts ASSISTANT_INSTRUCTIONS), which Michi sends
 * at the start of every assistant conversation's first message. Keep this
 * marker stable for persisted sessions and provider conversation titles.
 * Backend tests pin the instructions to it.
 */
export const MICHI_ASSISTANT_MARKER = "You are the Michi assistant: the user's own assistant across every Michi workspace";
