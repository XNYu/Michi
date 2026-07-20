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
 * Build a full transcript block from a node's messages for injection.
 */
export function buildNodeTranscriptBlock(node: ChatNodeState): string {
    const title = node.title || node.messages.find(m => m.role === 'user')?.text.slice(0, 80) || 'thread';
    const transcript = node.messages
        .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${visibleMessageText(m)}`)
        .join('\n\n');
    return `=== Referenced node: ${title} ===\n${transcript}`;
}

/**
 * Strip @node:xxx tokens from user text so the raw tokens don't appear
 * in the displayed message or get sent verbatim to kiro.
 */
export function stripNodeMentionTokens(text: string): string {
    return text.replace(/\s*@node:[\w-]+/g, '').replace(/^\s+/, '').replace(/\s{2,}/g, ' ');
}

/**
 * Rewrite @node:<id> tokens to @<title> for display in the user message.
 * Unresolved ids fall back to plain strip so stale tokens don't leak through.
 */
export function rewriteNodeMentionsForDisplay(
    text: string,
    nodes: Record<string, ChatNodeState>,
): string {
    return text.replace(/@node:([\w-]+)/g, (_match, id: string) => {
        const node = nodes[id];
        if (!node) return '';
        const title = node.title || node.messages.find(m => m.role === 'user')?.text.slice(0, 40) || 'thread';
        return `@${title}`;
    }).replace(/^\s+/, '').replace(/\s{2,}/g, ' ');
}
