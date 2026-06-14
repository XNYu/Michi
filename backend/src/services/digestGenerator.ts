import { ChatManager } from "./chatManager";

export interface NodeSnapshot {
    nodeId: string;
    parentNodeId?: string;
    title?: string;
    depth: number;
    messages: Array<{ role: "user" | "assistant"; text: string }>;
}

export interface GenerationRequest {
    workspace: { name: string; cwd?: string; createdAt: number };
    rootTitle: string;
    nodes: NodeSnapshot[];
    cwd?: string;
    /** Prior digest content (if any) so the model can preserve structure on refresh. */
    previousContent?: string;
    /** Optional user-supplied prompt appended after the preamble. */
    customPrompt?: string;
}

/**
 * Strip the workspace's Title:/Follow-up Questions: scaffolding from the
 * kiro response. Same logic as before — shared here so both export and
 * digest output come out clean.
 */
export function stripScaffolding(markdown: string): string {
    let s = markdown;
    s = s.replace(/^\s*\**\s*title\s*[:：][^\n]*\n+/i, "");
    const fq = s.match(/(?:^|\n)[\s#*>_`-]*follow[-\s]?up\s+questions?\s*[:：][\s*_`]*/i);
    if (fq && fq.index !== undefined) s = s.slice(0, fq.index);
    return s.trim();
}

function composeTranscript(req: GenerationRequest): string {
    const parts: string[] = [];
    parts.push(`Workspace name: ${req.workspace.name}`);
    if (req.workspace.cwd) parts.push(`Workspace folder: ${req.workspace.cwd}`);
    parts.push(`Created: ${new Date(req.workspace.createdAt).toISOString()}`);
    parts.push(`Root topic title: ${req.rootTitle || "(untitled)"}`);
    parts.push("\n---\n");
    for (const n of req.nodes) {
        const label = n.title || n.messages.find((m) => m.role === "user")?.text.slice(0, 80) || "untitled";
        parts.push(
            `=== "${label}" (depth ${n.depth}) ===`
        );
        if (n.parentNodeId) {
            const parent = req.nodes.find((p) => p.nodeId === n.parentNodeId);
            const parentLabel = parent?.title || "root";
            parts.push(`branched from: "${parentLabel}"`);
        }
        parts.push("");
        parts.push("[Messages]");
        for (const m of n.messages) {
            const role = m.role === "user" ? "User" : "Assistant";
            parts.push(`${role}: ${m.text}`);
        }
        parts.push("");
    }
    return parts.join("\n");
}

const EXPORT_PREAMBLE = `You are summarizing a branching exploration the user conducted in a "workspace" app. The user explored a topic by asking questions and branching into sub-topics; you now see the full tree of conversation.

Produce a Markdown document with this structure:

# {Workspace name}

## Overview

Two to four paragraphs synthesizing the whole exploration: what the user was after, what they found, any surprising angles. Readable as a standalone writeup.

## Map

Then reproduce the tree structure using heading levels that match the depth of each node (depth 0 → ##, depth 1 → ###, depth 2 → ####, ...). For each node, write:
- A short italic line: the node's title (or first user message if no title).
- One paragraph summarizing the conversation at that node (not a transcript — a condensed takeaway).
- If the node had interesting follow-up questions, list 1–3 at the end.

Do not quote the raw transcript. Do not use the "Title:" / "Follow-up Questions:" markers from the workspace prompt — those are UI scaffolding. Output clean, publishable Markdown.`;

const DIGEST_PREAMBLE = `You are producing a living research document from a user's exploration workspace. The user explored a topic across multiple branching conversations, and this digest is their comprehensive reference document.

Write a coherent, well-structured document — NOT a collection of per-node summaries. Weave insights from all branches into a unified narrative. Reference source conversations by their title (e.g. "as explored in *Title of Conversation*") rather than by any internal ID.

Format your response EXACTLY as follows. Do NOT wrap in code fences.

# <A short, descriptive title for this digest — not "Overview" or "Digest", but a phrase capturing the core topic>

A concise paragraph (3-5 sentences) stating what was explored, why it matters, and the key takeaway.

## Discussion

A narrative account of the exploration, organized by logical flow — not by individual conversation node. Describe what questions were asked, what was discovered, how one line of inquiry led to another. Use subsections (###) if the exploration covered distinct phases or topics. Reference source conversations naturally by title in italics when attributing specific findings.

## Conclusions

Bullet points or short paragraphs summarizing the concrete findings, decisions, or insights reached. Be specific — state what was determined, not just what was discussed.

## Open Questions & Future Directions

- Unresolved questions that emerged from the exploration
- Promising directions that were identified but not yet pursued
- Tensions or contradictions that need further investigation

Do not quote raw transcripts. Do not use internal node IDs. Do not use the "Title:" / "Follow-up Questions:" markers. If a "Previous digest" section is provided below, you MAY preserve its structure where content is unchanged, but re-synthesize when new conversations add substance.`;

function composePrompt(req: GenerationRequest, preamble: string): string {
    const parts = [preamble];
    if (req.customPrompt) {
        parts.push("\n\nAdditional user instructions:\n" + req.customPrompt);
    }
    parts.push("\n---\n", composeTranscript(req));
    if (req.previousContent) {
        parts.push("\n---\n");
        parts.push("Previous digest (for incremental update):\n");
        parts.push(req.previousContent);
    }
    parts.push("\n---\n\nNow produce the Markdown output.");
    return parts.join("\n");
}

async function runGeneration(
    chatManager: ChatManager,
    req: GenerationRequest,
    preamble: string,
): Promise<string> {
    const chatId = await chatManager.newChat(undefined, req.cwd);
    const firstMessage = composePrompt(req, preamble);
    const chunks: string[] = [];
    for await (const ev of chatManager.sendMessage(chatId, firstMessage)) {
        if (ev.kind === "chunk") chunks.push(ev.text);
        else if (ev.kind === "turn_end") break;
    }
    return stripScaffolding(chunks.join(""));
}

/**
 * Stream digest generation chunk-by-chunk. Yields raw assistant chunks as
 * they arrive; the caller is responsible for stripping scaffolding from
 * the accumulated final text once streaming ends.
 */
export async function* streamDigestGeneration(
    chatManager: ChatManager,
    req: GenerationRequest,
): AsyncGenerator<{ kind: "chunk"; text: string } | { kind: "done"; finalMarkdown: string }> {
    const chatId = await chatManager.newChat(undefined, req.cwd);
    const firstMessage = composePrompt(req, DIGEST_PREAMBLE);
    const chunks: string[] = [];
    for await (const ev of chatManager.sendMessage(chatId, firstMessage)) {
        if (ev.kind === "chunk") {
            chunks.push(ev.text);
            yield { kind: "chunk", text: ev.text };
        } else if (ev.kind === "turn_end") {
            break;
        }
    }
    yield { kind: "done", finalMarkdown: stripScaffolding(chunks.join("")) };
}

export function runExportGeneration(
    chatManager: ChatManager,
    req: GenerationRequest,
): Promise<string> {
    return runGeneration(chatManager, req, EXPORT_PREAMBLE);
}

export function runDigestGeneration(
    chatManager: ChatManager,
    req: GenerationRequest,
): Promise<string> {
    return runGeneration(chatManager, req, DIGEST_PREAMBLE);
}
