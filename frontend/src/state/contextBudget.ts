import type { ChatNodeState, ArtifactEntry } from './chatTypes';
import { visibleMessageText } from './assistantBlocks';

/**
 * Extract @mentions from text and resolve them against project artifacts.
 * Returns deduped ArtifactEntry[] (by id). Unresolved mentions are ignored.
 */
export function resolveAtMentions(
    text: string,
    artifacts: ArtifactEntry[],
): ArtifactEntry[] {
    // Allow `.` so filenames like `report.md` are resolvable as `@report.md`.
    const re = /(?:^|\s)@([\p{L}\p{N}_.-]+)/gu;
    const seen = new Set<string>();
    const result: ArtifactEntry[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const name = m[1].toLowerCase();
        const entry = artifacts.find(c => c.name.toLowerCase() === name);
        if (entry && !seen.has(entry.id)) {
            seen.add(entry.id);
            result.push(entry);
        }
    }
    return result;
}

/**
 * Extract @node:nodeId mentions from text and resolve them against a set of nodes.
 * Returns deduped ChatNodeState[] (by nodeId). Unresolved mentions are ignored.
 */
export function resolveAtNodeMentions(
    text: string,
    nodes: Record<string, ChatNodeState>,
): ChatNodeState[] {
    const re = /(?:^|\s)@node:([\w-]+)/g;
    const seen = new Set<string>();
    const result: ChatNodeState[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const nodeId = m[1];
        const node = nodes[nodeId];
        if (node && !seen.has(nodeId)) {
            seen.add(nodeId);
            result.push(node);
        }
    }
    return result;
}

/**
 * Approximate character threshold below which a referenced node's full
 * transcript is inlined.  Above this, only a summary + tool-call hint is
 * injected so the agent can fetch details on demand.
 *
 * ~2 KB covers a typical 3-4 turn quick Q&A.  Anything bigger usually
 * contains tool output that bloats the prompt without proportional value.
 */
const INLINE_TRANSCRIPT_THRESHOLD = 2048;

/**
 * Build an injection block for a referenced node.
 *
 * Short conversations (≤ INLINE_TRANSCRIPT_THRESHOLD chars) are inlined in
 * full so the agent can use them without a tool call.  Longer conversations
 * are summarised from the branch-overview journal (or the first user message
 * as fallback) with a hint to call `read_node` / `read_node_overview`.
 */
export function buildNodeTranscriptBlock(node: ChatNodeState): string {
    const title = node.title || node.messages.find(m => m.role === 'user')?.text.slice(0, 80) || 'thread';
    const nodeId = node.nodeId;

    // Build the full transcript — we need it to measure length anyway.
    const transcript = node.messages
        .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${visibleMessageText(m)}`)
        .join('\n\n');
    const fullBlock = `=== Referenced node: ${title} ===\n${transcript}`;

    // Short conversation — inline everything.
    if (fullBlock.length <= INLINE_TRANSCRIPT_THRESHOLD) {
        return fullBlock;
    }

    // Long conversation — compact reference with summary.
    const msgCount = node.messages
        .filter(m => m.role === 'user' || m.role === 'assistant').length;
    const entries = node.branchOverviewEntries ?? [];
    const summary = entries.length > 0
        ? entries.map(e => e.text).join(' ')
        : node.messages.find(m => m.role === 'user')?.text.slice(0, 200) || '(no summary)';

    return [
        `=== Referenced node: ${title} (${nodeId}, ${msgCount} messages) ===`,
        `Summary: ${summary}`,
        `To read the full conversation, use: read_node_overview("${nodeId}") for the journal, or read_node("${nodeId}") for the transcript.`,
    ].join('\n');
}

/**
 * Strip @node:xxx tokens from user text so the raw tokens don't appear
 * in the displayed message or get sent verbatim to kiro.
 */
export function stripNodeMentionTokens(text: string): string {
    return text.replace(/@node:[\w-]+[ \t]*/g, '');
}

/**
 * Rewrite @node:<id> tokens to @<title> for display in the user message.
 * Unresolved ids fall back to plain strip so stale tokens don't leak through.
 */
export function rewriteNodeMentionsForDisplay(
    text: string,
    nodes: Record<string, ChatNodeState>,
): string {
    return text.replace(/@node:([\w-]+)([ \t]*)/g, (_match, id: string, trailing: string) => {
        const node = nodes[id];
        if (!node) return '';
        const title = node.title || node.messages.find(m => m.role === 'user')?.text.slice(0, 40) || 'thread';
        return `@${title}${trailing}`;
    });
}
