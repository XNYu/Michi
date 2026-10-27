import { resolveAtMentions, resolveAtNodeMentions, buildNodeTranscriptBlock, stripNodeMentionTokens, rewriteNodeMentionsForDisplay } from './contextBudget';
import type { ChatNodeState, ArtifactEntry } from './chatTypes';
import { backendEntityId } from '../config/backendIdentity';
import { expandMentions, type MentionRecord } from '../components/mentions';

const mkCtx = (id: string, name: string, filePath: string, size?: number): ArtifactEntry => ({
    id, name, filePath, size, source: 'user', createdAt: 1000, updatedAt: 1000,
});

describe('resolveAtMentions', () => {
    const ctxs = [mkCtx('1', 'api-spec', 'docs/api.md'), mkCtx('2', 'conventions', 'docs/conv.md')];

    it('skips unresolved mentions', () => {
        const result = resolveAtMentions('@nonexistent @api-spec', ctxs);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('1');
    });
});

const mkNode = (nodeId: string, title: string, msgs: Array<{ role: 'user' | 'assistant'; text: string }>): ChatNodeState => ({
    nodeId,
    kind: 'chat',
    chatId: `chat-${nodeId}`,
    projectId: 'p1',
    messages: msgs.map((m, i) => ({ id: `m${i}`, role: m.role, text: m.text, toolCalls: [] })),
    followUps: [],
    title,
    status: 'idle',
});

describe('resolveAtNodeMentions', () => {
    const nodes: Record<string, ChatNodeState> = {
        'n1': mkNode('n1', 'Research', [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'world' }]),
        'n2': mkNode('n2', 'Design', [{ role: 'user', text: 'design q' }]),
    };

    it('skips unresolved node mentions', () => {
        const result = resolveAtNodeMentions('@node:nonexistent @node:n1', nodes);
        expect(result).toHaveLength(1);
        expect(result[0].nodeId).toBe('n1');
    });
});

describe('remote node mention flow', () => {
    it('expands a chip, resolves its transcript and rewrites its display without changing the stored refId', () => {
        const nodeId = backendEntityId('ssh:東京/a', 'n:1.file(draft)');
        const node = mkNode(nodeId, 'Remote research', [
            { role: 'user', text: 'Original question' },
            { role: 'assistant', text: 'Remote result' },
        ]);
        const nodes = { [nodeId]: node };
        const mention: MentionRecord = { start: 8, end: 15, kind: 'node', refId: nodeId, label: 'Remote' };
        const wire = expandMentions('Compare @Remote.\nNext', [mention]);

        expect(mention.refId).toBe(nodeId);
        const resolved = resolveAtNodeMentions(wire, nodes);
        expect(resolved).toEqual([node]);
        expect(buildNodeTranscriptBlock(resolved[0])).toContain('Assistant: Remote result');
        expect(stripNodeMentionTokens(wire)).toBe('Compare .\nNext');
        expect(rewriteNodeMentionsForDisplay(wire, nodes)).toBe('Compare @Remote research.\nNext');
    });

    it('deduplicates mixed local, encoded remote and legacy remote references in input order', () => {
        const nodeId = backendEntityId('ssh/a', 'n:1');
        const remote = mkNode(nodeId, 'Remote', []);
        const local = mkNode('n1', 'Local', []);
        const wire = expandMentions('@Remote @Local', [
            { start: 0, end: 7, kind: 'node', refId: nodeId, label: 'Remote' },
            { start: 8, end: 14, kind: 'node', refId: 'n1', label: 'Local' },
        ]);
        expect(resolveAtNodeMentions(`${wire} @node:${nodeId}`, { [nodeId]: remote, n1: local }))
            .toEqual([remote, local]);
    });

    it('keeps malformed escapes and non-reference phrases as ordinary text', () => {
        const text = 'plain @node text; @nodes:n1; @node:n1%ZZ; @node:%E0%A4';
        const nodes = { n1: mkNode('n1', 'Local', []) };
        expect(resolveAtNodeMentions(text, nodes)).toEqual([]);
        expect(stripNodeMentionTokens(text)).toBe(text);
        expect(rewriteNodeMentionsForDisplay(text, nodes)).toBe(text);
    });
});

describe('buildNodeTranscriptBlock', () => {
    it('falls back to first user message when no title', () => {
        const node = mkNode('n1', '', [{ role: 'user', text: 'My question' }]);
        const block = buildNodeTranscriptBlock(node);
        expect(block).toContain('=== Referenced node: My question ===');
    });

    it('emits a compact reference for long transcripts', () => {
        const longMsg = 'A'.repeat(2000);
        const node = mkNode('n1', 'Long thread', [
            { role: 'user', text: 'Start' },
            { role: 'assistant', text: longMsg },
        ]);
        const block = buildNodeTranscriptBlock(node);
        // Should NOT contain the full assistant text.
        expect(block).not.toContain(longMsg);
        // Should contain reference metadata.
        expect(block).toContain('=== Referenced node: Long thread (n1, 2 messages) ===');
        expect(block).toContain('Summary:');
        expect(block).toContain('read_node_overview("n1")');
        expect(block).toContain('read_node("n1")');
    });

    it('uses branchOverviewEntries for the summary when available', () => {
        const longMsg = 'B'.repeat(2000);
        const node: ChatNodeState = {
            ...mkNode('n1', 'Explored topic', [
                { role: 'user', text: 'Start' },
                { role: 'assistant', text: longMsg },
            ]),
            branchOverviewEntries: [
                { at: 1000, text: 'Investigated X and discovered Y.' },
                { at: 2000, text: 'Confirmed approach Z.' },
            ],
        };
        const block = buildNodeTranscriptBlock(node);
        expect(block).toContain('Summary: Investigated X and discovered Y. Confirmed approach Z.');
    });
});

describe('stripNodeMentionTokens', () => {
    it('preserves line breaks while stripping node tokens', () => {
        expect(stripNodeMentionTokens('Tasks\n\n@node:n1\n\nS size'))
            .toBe('Tasks\n\n\n\nS size');
    });
});

describe('rewriteNodeMentionsForDisplay', () => {
    const nodes: Record<string, ChatNodeState> = {
        'n1': mkNode('n1', 'Research', [{ role: 'user', text: 'hello' }]),
        'n2': mkNode('n2', 'Design', [{ role: 'user', text: 'q' }]),
    };

    it('falls back to first user message when title missing', () => {
        const fallback = { 'x': mkNode('x', '', [{ role: 'user', text: 'My question text' }]) };
        expect(rewriteNodeMentionsForDisplay('see @node:x', fallback))
            .toBe('see @My question text');
    });

    it('drops unresolved tokens', () => {
        expect(rewriteNodeMentionsForDisplay('@node:gone hi', nodes)).toBe('hi');
    });
});

it('limits manual references to the sending workspace and uses remote server IDs only in that scope', () => {
    const nodeId = backendEntityId('scope-a', 'same-server-node');
    const scope = { workspaceId: 'p1', backendConnectionId: 'scope-a' };
    const node = mkNode(nodeId, 'Long remote', [{ role: 'assistant', text: 'a'.repeat(3000) }]);
    const otherBackendId = backendEntityId('scope-b', 'same-server-node');
    const otherBackend = mkNode(otherBackendId, 'Other backend', []);
    const otherWorkspace = { ...mkNode(backendEntityId('scope-a', 'other'), 'Other workspace', []), projectId: 'p2' };
    const wire = [node, otherBackend, otherWorkspace].map((n) => `@node:${encodeURIComponent(n.nodeId)}`).join(' ');
    expect(resolveAtNodeMentions(wire, { [nodeId]: node, [otherBackendId]: otherBackend, [otherWorkspace.nodeId]: otherWorkspace }, scope)).toEqual([node]);
    const block = buildNodeTranscriptBlock(node, scope);
    expect(block).toContain('read_node("same-server-node")');
    expect(block).not.toContain(nodeId);
    expect(buildNodeTranscriptBlock(node)).toContain('a'.repeat(3000));
    expect(buildNodeTranscriptBlock(otherBackend, scope)).not.toContain('read_node');
});
