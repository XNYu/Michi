import { resolveAtMentions, resolveAtNodeMentions, buildNodeTranscriptBlock, stripNodeMentionTokens, rewriteNodeMentionsForDisplay } from './contextBudget';
import type { ChatNodeState, ArtifactEntry } from './chatTypes';

const mkCtx = (id: string, name: string, filePath: string, size?: number): ArtifactEntry => ({
    id, name, filePath, size, source: 'user', createdAt: 1000, updatedAt: 1000,
});

describe('resolveAtMentions', () => {
    const ctxs = [mkCtx('1', 'api-spec', 'docs/api.md'), mkCtx('2', 'conventions', 'docs/conv.md')];

    it('returns empty for text without mentions', () => {
        expect(resolveAtMentions('hello world', ctxs)).toEqual([]);
    });

    it('is case-insensitive', () => {
        const result = resolveAtMentions('@API-SPEC', ctxs);
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

    it('returns empty for text without node mentions', () => {
        expect(resolveAtNodeMentions('hello @api-spec', nodes)).toEqual([]);
    });

    it('resolves a single node mention', () => {
        const result = resolveAtNodeMentions('check @node:n1 please', nodes);
        expect(result).toHaveLength(1);
        expect(result[0].nodeId).toBe('n1');
    });
});

describe('buildNodeTranscriptBlock', () => {
    it('inlines a short transcript in full', () => {
        const node = mkNode('n1', 'Research', [
            { role: 'user', text: 'What is X?' },
            { role: 'assistant', text: 'X is Y.' },
        ]);
        const block = buildNodeTranscriptBlock(node);
        expect(block).toContain('=== Referenced node: Research ===');
        expect(block).toContain('User: What is X?');
        expect(block).toContain('Assistant: X is Y.');
        // Short transcript should NOT contain tool-call hints.
        expect(block).not.toContain('read_node');
    });

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
    it('strips @node:xxx tokens', () => {
        expect(stripNodeMentionTokens('check @node:n1 please')).toBe('check please');
    });

    it('strips multiple tokens', () => {
        expect(stripNodeMentionTokens('@node:n1 @node:n2 hello')).toBe('hello');
    });

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

    it('rewrites a node token to @<title>', () => {
        expect(rewriteNodeMentionsForDisplay('check @node:n1 please', nodes))
            .toBe('check @Research please');
    });

    it('rewrites multiple node tokens', () => {
        expect(rewriteNodeMentionsForDisplay('@node:n1 and @node:n2 done', nodes))
            .toBe('@Research and @Design done');
    });

    it('falls back to first user message when title missing', () => {
        const fallback = { 'x': mkNode('x', '', [{ role: 'user', text: 'My question text' }]) };
        expect(rewriteNodeMentionsForDisplay('see @node:x', fallback))
            .toBe('see @My question text');
    });

    it('preserves user-authored line breaks and spacing', () => {
        const text = 'Tasks with estimates\n\nS size = 1 point\n\nM size = 3 / 4 point';
        expect(rewriteNodeMentionsForDisplay(text, nodes)).toBe(text);
    });

    it('drops unresolved tokens', () => {
        expect(rewriteNodeMentionsForDisplay('@node:gone hi', nodes)).toBe('hi');
    });
});
