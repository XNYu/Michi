import fs from "fs";
import path from "path";
import type { AgentSession, ChatMessage, ExtraContext } from "./types";

const TOOL_CAPABILITIES_SECTION = `
Capabilities — you have these tools available and should use them proactively:
- Workspace files: \`read\` (view file contents), \`ls\` (list directory), \`grep\` (search file contents), \`find\` (locate files by pattern). \`write\`, \`edit\`, \`bash\` — modify files or run commands (require user approval).
- Thread graph: \`list_threads\` — see all conversation threads in this workspace. \`search_messages\` — keyword search across workspace messages. \`read_node\` — read a specific node's full transcript.
- Artifacts: \`save_artifact\` — save a named reusable document (referenced as @name). \`update_artifact\` — revise an existing artifact.
- Branching: \`spawn_branches\` — fan out parallel child threads (only when user explicitly asks to branch/split).
- Media: \`show_image\` — display an image inline in the conversation.

Use tools proactively when the user's question relates to workspace content, prior conversations, or file-based tasks. If answering requires reading a file or checking thread history, just do it — don't wait to be told.`;

const PREAMBLE_TEMPLATE = `You are a knowledge-exploration assistant inside a visual "workspace" app.
The user is diving deep into topics and wants thoughtful, structured answers.

Style:
- Markdown with short #### section headers. Substantive but concise. Let the content choose its own shape — prose for analysis and reasoning, bullets only when listing discrete items.
- Don't invent tool calls for trivia you already know — only when lookup is genuinely needed.
${TOOL_CAPABILITIES_SECTION}

Required final answer metadata:
- In your final answer only, after all tool use and intermediate commentary is complete,
  write the first line before any prose as a single line of the form:
      [TITLE: 4-8 word summary]
  on its own line. The UI strips this line and renders it as the thread title.
{{BRANCH_OVERVIEW_INSTRUCTIONS}}
{{METADATA_SCOPE_INSTRUCTIONS}}
{{FOLLOW_UPS_INSTRUCTIONS}}`;

const BRANCH_OVERVIEW_SENTINEL_INSTRUCTION = `- Near the end of the final answer, immediately before any follow-up sentinels,
  write one single-line journal entry for this turn in this form:
      [BRANCH-OVERVIEW: 1-3 concise sentences describing what this turn did — what was explored, decided, or discovered]
  Entries accumulate into a chronological journal of the branch, so cover only
  this turn's contribution; do not restate earlier turns. Keep it factual and
  useful when read later without the conversation. Match the user's language.
  Use inline Markdown if helpful, but no headings, lists, or closing square bracket.
  The UI strips this line and appends it to the branch's journal in the Branches document.`;

const SENTINEL_METADATA_SCOPE_INSTRUCTION = `- Do not emit [TITLE:], [BRANCH-OVERVIEW:], or [FOLLOW-UP n/3:] sentinel lines in commentary,
  progress/status updates, tool plans, or any message before you are ready to
  deliver the final answer.`;

const HYBRID_METADATA_SCOPE_INSTRUCTION = `- Do not emit [TITLE:] or [FOLLOW-UP n/3:] sentinel lines in commentary,
  progress/status updates, tool plans, or any message before you are ready to
  deliver the final answer. Never emit a [BRANCH-OVERVIEW:] sentinel; the
  runtime supplies the overview through a hidden metadata tool.`;

const STRUCTURED_BRANCH_OVERVIEW_INSTRUCTION = `- Provide this turn's branch-journal entry (what this turn did — explored, decided, discovered)
  through the runtime's structured metadata tool. Entries accumulate into a chronological journal;
  do not restate earlier turns and do not duplicate the entry in the visible answer.`;

const STRUCTURED_METADATA_SCOPE_INSTRUCTION = `- Do not emit title metadata in commentary, progress/status updates, tool plans,
  or any message before you are ready to deliver the final answer.`;

const FOLLOW_UPS_INSTRUCTION = `- LAST, end your final answer with three lines of the form:
      [FOLLOW-UP 1/3: question 1]
      [FOLLOW-UP 2/3: question 2]
      [FOLLOW-UP 3/3: question 3]
  STRICT FORMAT RULES (the UI strips these lines and renders clickable buttons,
  so any deviation will leak raw "[FOLLOW-UP …" text into the user's view):
    1. Each sentinel MUST be on its OWN line, with nothing else on that line.
    2. Each sentinel MUST end with a literal closing "]" — do NOT omit it,
       even when the question itself ends with "?" or other punctuation.
    3. The question text MUST NOT contain "]" (or any other "[" / "]" pair).
    4. Emit exactly three sentinels, numbered 1/3, 2/3, 3/3 in that order.
  ✅ Correct:
      [FOLLOW-UP 1/3: How does X relate to Y?]
      [FOLLOW-UP 2/3: What would break if we removed Z?]
      [FOLLOW-UP 3/3: Is there a contrarian read on this?]
  ❌ Wrong (missing "]" — buttons will fail to render):
      [FOLLOW-UP 1/3: How does X relate to Y?
      [FOLLOW-UP 2/3: What would break if we removed Z?
  Content rules — these are FOLLOW-UPS THE USER WOULD ASK YOU NEXT, not
  questions you ask the user. Write them in the user's voice, addressed at
  you. The user is the curious one; you are the one being asked. Match the
  language of the user's last message (if they wrote in Chinese, the
  follow-ups must be in Chinese; same for any other language).

  ❌ NEVER (these are you asking the user — wrong direction):
       [FOLLOW-UP 1/3: Would you like me to expand section 2?]
       [FOLLOW-UP 2/3: Want me to save this as a file?]
       [FOLLOW-UP 3/3: Is there a 5th topic you'd like to add?]

  ✅ ALWAYS (user asking you — correct direction):
       [FOLLOW-UP 1/3: How does X actually relate to Y under the hood?]
       [FOLLOW-UP 2/3: What would break if we removed Z?]
       [FOLLOW-UP 3/3: Is there a contrarian read on this framing?]

  One question should drill deeper into the answer; the other two should come
  at the topic from unexpected or devil's-advocate angles. Never offer to
  perform actions ("save", "expand", "adjust"), never ask about the user's
  preferences or intentions — those belong in normal prose, not follow-ups.

  Perspective check: imagine the user is typing the question into the chat
  box to ask YOU something. "I" = the user, "you" = the assistant. If the
  question sounds like something an assistant would say to a user, flip it.`;

const FOLLOW_UPS_DISABLED = `- Follow-ups are DISABLED for this thread. Do NOT emit [FOLLOW-UP n/3:] or [FOLLOW-UPS:] sentinel lines.`;

const STRUCTURED_FOLLOW_UPS_INSTRUCTION = `- Provide exactly three concise follow-up questions through the runtime's structured metadata tool.
  Write them from the user's point of view and in the user's language. One question should drill deeper into the answer;
  the other two should approach it from unexpected or devil's-advocate angles. Do not duplicate them in the visible answer.`;

const CONTEXT_MANIFEST_HEADER = `\nWorkspace context files available (read with your filesystem tools when relevant; the user can also @-mention to inject contents directly):`;

const USER_SPEAK_TAIL = `\nThe user will now speak.\n`;

// After this many user turns, start reminding the model to produce follow-ups.
const FOLLOW_UPS_REMIND_AFTER_TURNS = 2;
// Repeat the reminder every N turns after the initial trigger.
const FOLLOW_UPS_REMIND_INTERVAL = 1;

const FOLLOW_UPS_REMINDER = `\n\n[Reminder: before the three follow-ups, include one [BRANCH-OVERVIEW: ...] line — 1-3 sentences on what this turn did or concluded (it appends to the branch's journal; do not restate earlier turns). Then end with [FOLLOW-UP 1/3: ...], [FOLLOW-UP 2/3: ...], [FOLLOW-UP 3/3: ...] — three user-voice questions on separate lines, each ending with "]".]`;

/**
 * Returns a short reminder suffix when the conversation is long enough that
 * the model may have lost attention on the system-prompt follow-up instructions.
 * Returns empty string when no reminder is needed.
 */
export function followUpReminder(userTurnCount: number, enableFollowUps: boolean): string {
    if (!enableFollowUps) return "";
    if (userTurnCount < FOLLOW_UPS_REMIND_AFTER_TURNS) return "";
    const turnsSinceThreshold = userTurnCount - FOLLOW_UPS_REMIND_AFTER_TURNS;
    if (turnsSinceThreshold % FOLLOW_UPS_REMIND_INTERVAL === 0) return FOLLOW_UPS_REMINDER;
    return "";
}

/**
 * Short restatement of the [TITLE:] / [FOLLOW-UP n/3:] sentinel rules, glued
 * onto the first user message as belt-and-suspenders for weaker providers
 * (DeepSeek etc.) whose instruction-following drifts when format guidance
 * only lives in the system prompt — Claude/Anthropic don't need this because
 * --append-system-prompt rides on top of Anthropic's own conditioning.
 */
export function buildFormatReminder(enableFollowUps: boolean): string {
    if (!enableFollowUps) {
        return `(Format reminder, restated from system instructions — do not skip in this reply.)
- FIRST line of your reply MUST be: [TITLE: 4-8 word summary]
- Do NOT emit any [FOLLOW-UP n/3:] or [FOLLOW-UPS:] lines.`;
    }
    return `(Format reminder, restated from system instructions — do not skip in this reply.)
- FIRST line MUST be: [TITLE: 4-8 word summary]
- LAST three lines MUST be these sentinels, each on its OWN line:
    [FOLLOW-UP 1/3: question 1]
    [FOLLOW-UP 2/3: question 2]
    [FOLLOW-UP 3/3: question 3]
- Every sentinel MUST start with the literal "[" and the literal text "FOLLOW-UP", and MUST end with the literal "]". Never abbreviate to "UP 2/3:" or drop the opening "[" / closing "]" — the UI parses lines verbatim and any deviation leaks raw text into the user's view.`;
}

export type MetadataOutputMode =
    | 'sentinel'
    | 'sentinel-followups-tool-overview'
    | 'structured-tool';

function renderHead(
    enableFollowUps: boolean,
    metadataOutputMode: MetadataOutputMode = 'sentinel',
): string {
    const structured = metadataOutputMode === 'structured-tool';
    const toolOverview = metadataOutputMode !== 'sentinel';
    const branchOverviewLine = toolOverview
        ? STRUCTURED_BRANCH_OVERVIEW_INSTRUCTION
        : BRANCH_OVERVIEW_SENTINEL_INSTRUCTION;
    const metadataScopeLine = structured
        ? STRUCTURED_METADATA_SCOPE_INSTRUCTION
        : toolOverview
            ? HYBRID_METADATA_SCOPE_INSTRUCTION
            : SENTINEL_METADATA_SCOPE_INSTRUCTION;
    const followUpsLine = enableFollowUps
        ? structured ? STRUCTURED_FOLLOW_UPS_INSTRUCTION : FOLLOW_UPS_INSTRUCTION
        : FOLLOW_UPS_DISABLED;
    return PREAMBLE_TEMPLATE
        .replace("{{BRANCH_OVERVIEW_INSTRUCTIONS}}", branchOverviewLine)
        .replace("{{METADATA_SCOPE_INSTRUCTIONS}}", metadataScopeLine)
        .replace("{{FOLLOW_UPS_INSTRUCTIONS}}", followUpsLine);
}

/**
 * Stable system prompt — fed to claude via `--append-system-prompt` at spawn time.
 *
 * MUST be pure for a given metadata mode so warm-pool entries share
 * byte-identical spawn args (otherwise the pool key `(cwd, model)` is not
 * well-defined). The mode is process-wide for the native runtime experiment.
 */
export function buildStableSystemPrompt(
    metadataOutputMode: MetadataOutputMode = 'sentinel',
    enableFollowUps: boolean = true,
): string {
    return buildMetadataSystemPrompt(metadataOutputMode, enableFollowUps) + ASK_USER_INSTRUCTION;
}

/** Stable metadata-only prompt for runtimes whose custom-agent layer cannot
 * use Michi's structured ask_user tool.
 *
 * `enableFollowUps` defaults to true so existing warm-pool callers (Claude)
 * keep byte-identical spawn args; runtimes without a warm pool (Codex) may
 * pass false to honor opts.enableFollowUps in the developer instructions. */
export function buildMetadataSystemPrompt(
    metadataOutputMode: MetadataOutputMode = 'sentinel',
    enableFollowUps: boolean = true,
): string {
    return renderHead(enableFollowUps, metadataOutputMode);
}

const ASK_USER_INSTRUCTION = `

Tool override — AskUserQuestion:
Do NOT use the built-in AskUserQuestion tool. It does not work in this environment.
Instead, use the MCP tool ____michi_internal____ask_user to ask the user structured
questions with selectable options. The schema is identical: questions[] with question,
header, options[{label, description}], and multiSelect. The tool blocks until the user
responds in the UI.`;


export interface FirstTurnPrefixInput {
    cwd: string;
    contextManifest?: ExtraContext[];
    extraContexts?: ExtraContext[];
    /** Oldest-first ancestor chain. Each entry exposes its history + pendingAssistant. */
    ancestors?: AgentSession[];
    mergeContexts?: string[];
    /** Per-workspace system-prompt addendum (Manage page → Instructions). Empty
     *  / undefined when the user hasn't set one. We inject via the first-turn
     *  prefix instead of `--append-system-prompt` so the Claude warm pool key
     *  (cwd, model) stays well-defined. */
    workspaceInstructions?: string | null;
}

/**
 * Variable per-chat preamble — prepended to the first real user message by
 * ClaudeSession.send (after the warm-init `shouldQuery:false` dummy).
 *
 * Returns the empty string when there is nothing variable to inject. Does NOT
 * include the stable head or the "user will now speak" tail; that's
 * buildPreamble's job for the Pi/Kiro legacy callers.
 */
export function buildFirstTurnPrefix(input: FirstTurnPrefixInput): string {
    const parts: string[] = [];

    if (input.workspaceInstructions) {
        const trimmed = input.workspaceInstructions.trim();
        if (trimmed.length > 0) {
            parts.push(
                `Workspace instructions (these apply to every reply in this conversation — treat as if part of the system prompt):\n\n${trimmed}\n`,
            );
        }
    }

    if (input.contextManifest && input.contextManifest.length > 0) {
        // Link artifacts have `url` and no filePath; list them by URL so the
        // manifest never prints "— undefined".
        const lines = input.contextManifest
            .map((m) => `- ${m.name} — ${m.url ? m.url : m.filePath}`)
            .join("\n");
        parts.push(`${CONTEXT_MANIFEST_HEADER}\n${lines}\n`);
    }

    if (input.extraContexts && input.extraContexts.length > 0) {
        parts.push(renderExtraContexts(input.extraContexts, input.cwd));
    }

    const ancestors = input.ancestors ?? [];
    if (ancestors.length > 0) {
        const rendered = renderAncestors(ancestors);
        if (rendered) parts.push(rendered);
    }

    if (input.mergeContexts && input.mergeContexts.length > 0) {
        parts.push(`\nContext from previous explorations this user wants to synthesize:\n\n${input.mergeContexts.join("\n\n")}\n\nThe user is now opening a new branch to synthesize across these threads.`);
    }

    return parts.join("\n").trimEnd();
}

function renderExtraContexts(ctxs: ExtraContext[], cwd: string): string {
    const blocks = ctxs.map((ctx) => {
        // Link artifact: url-only, no file to read. The agent is NOT told to
        // fetch it — it reads the URL only if its own tools happen to reach it
        // (e.g. an internal-docs tool). The bare marker keeps that honest.
        if (ctx.url) {
            return `### @${ctx.name}\n\n[Link: ${ctx.url}]`;
        }
        if (ctx.kind === "reference" || ctx.kind === "symlink") {
            // reference = absolute external path; symlink = a cwd-relative path
            // under .artifacts/ that resolves through a symlink to an external
            // file. Both are read live by the agent's own filesystem tools
            // (which follow symlinks) rather than embedded as a stale snapshot.
            return `### @${ctx.name}\n\n[Referenced file at: ${ctx.filePath}]`;
        }
        let content: string;
        try {
            const resolved = path.resolve(cwd, ctx.filePath);
            if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
                content = `[access denied: ${ctx.filePath}]`;
            } else {
                const stat = fs.statSync(resolved);
                content = stat.isFile()
                    ? fs.readFileSync(resolved, "utf-8")
                    : `[not a file: ${ctx.filePath}]`;
            }
        } catch {
            content = `[file not found: ${ctx.filePath}]`;
        }
        return `### @${ctx.name}\n\n${content}`;
    }).join("\n\n---\n\n");
    return `\nReference context the user has pinned for this conversation:\n\n${blocks}\n`;
}

function renderAncestors(ancestors: AgentSession[]): string {
    const sections: string[] = [];
    for (let i = 0; i < ancestors.length; i++) {
        const a = ancestors[i];
        const isImmediate = i === ancestors.length - 1;
        const lines: string[] = a.getHistory().map(
            (m: ChatMessage) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`,
        );
        if (isImmediate) {
            const partial = a.getPendingAssistant();
            if (partial && partial.trim().length > 0) {
                lines.push(`Assistant (in progress): ${partial}`);
            }
        }
        if (lines.length === 0) continue;
        const label =
            ancestors.length === 1 ? "Parent thread"
                : i === 0 ? `Thread ${i + 1} (root)`
                : isImmediate ? `Thread ${i + 1} (immediate parent)`
                : `Thread ${i + 1}`;
        sections.push(`--- ${label} ---\n\n${lines.join("\n\n")}`);
    }
    if (sections.length === 0) return "";
    return `\nPrevious conversation chain leading to this branch (oldest first, for context only — do not repeat back):\n\n${sections.join("\n\n")}\n\nThe user is now drilling down from that chain.`;
}

export interface PreambleInput extends FirstTurnPrefixInput {
    enableFollowUps: boolean;
}

/**
 * Backward-compat composition for Pi/Kiro callers that glue the entire
 * preamble onto the first user turn as a wholesale wrapper.
 *
 * Claude runtime does NOT use this directly — it spawns with
 * buildStableSystemPrompt() as `--append-system-prompt` and prepends
 * buildFirstTurnPrefix() to the first real user message.
 */
export function buildPreamble(input: PreambleInput): string {
    const head = renderHead(input.enableFollowUps);
    const variable = buildFirstTurnPrefix(input);
    return variable
        ? `${head}\n${variable}${USER_SPEAK_TAIL}`
        : `${head}${USER_SPEAK_TAIL}`;
}
