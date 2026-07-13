import fs from "fs";
import path from "path";
import type { AgentSession, ChatMessage, ExtraContext } from "./types";

const PREAMBLE_TEMPLATE = `You are a knowledge-exploration assistant inside a visual "workspace" app.
The user is diving deep into topics and wants thoughtful, structured answers.

Style:
- Markdown with short #### section headers. Substantive but concise. Let the content choose its own shape — prose for analysis and reasoning, bullets only when listing discrete items.
- Don't invent tool calls for trivia you already know — only when lookup is genuinely needed.

Required final answer metadata:
- In your final answer only, after all tool use and intermediate commentary is complete,
  write the first line before any prose as a single line of the form:
      [TITLE: 4-8 word summary]
  on its own line. The UI strips this line and renders it as the thread title.
- Do not emit [TITLE:] or [FOLLOW-UP n/3:] sentinel lines in commentary,
  progress/status updates, tool plans, or any message before you are ready to
  deliver the final answer.
{{FOLLOW_UPS_INSTRUCTIONS}}`;

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

const CONTEXT_MANIFEST_HEADER = `\nWorkspace context files available (read with your filesystem tools when relevant; the user can also @-mention to inject contents directly):`;

const USER_SPEAK_TAIL = `\nThe user will now speak.\n`;

function renderHead(enableFollowUps: boolean): string {
    const followUpsLine = enableFollowUps ? FOLLOW_UPS_INSTRUCTION : FOLLOW_UPS_DISABLED;
    return PREAMBLE_TEMPLATE.replace("{{FOLLOW_UPS_INSTRUCTIONS}}", followUpsLine);
}

/**
 * Stable system prompt — fed to claude via `--append-system-prompt` at spawn time.
 *
 * MUST be a pure constant so warm-pool entries share byte-identical spawn args
 * (otherwise the pool key `(cwd, model)` is not well-defined). Always includes
 * the FOLLOW_UPS_INSTRUCTION variant; chats that don't want follow-ups in the
 * UI gate at render time (frontend pref), not in the system prompt.
 */
export function buildStableSystemPrompt(): string {
    return buildMetadataSystemPrompt() + ASK_USER_INSTRUCTION;
}

/** Stable metadata-only prompt for runtimes whose custom-agent layer cannot
 * use Michi's structured ask_user tool. */
export function buildMetadataSystemPrompt(): string {
    return renderHead(true);
}

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
        const lines = input.contextManifest.map((m) => `- ${m.name} — ${m.filePath}`).join("\n");
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
        if (ctx.kind === "reference") {
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
