import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { KiroSession } from '../src/agents/kiro/KiroSession';
import type { KiroRuntime } from '../src/agents/kiro/KiroRuntime';
import {
    formatMcpToolOutput,
    isPlaceholderToolOutput,
    translateAcpToolCall,
} from '../src/services/acp/toolCallTranslate';

function runtimeWithUpdates(updates: Array<Record<string, unknown>>): KiroRuntime {
    const client = {
        async *prompt() {
            for (const update of updates) yield update;
        },
    };
    return {
        ensureClient: async () => client,
        getCurrentMode: () => null,
        getCurrentModel: () => null,
    } as unknown as KiroRuntime;
}

async function collect(session: KiroSession, text = 'hello') {
    const events = [];
    for await (const event of session.send(text)) events.push(event);
    return events;
}

describe('translateAcpToolCall', () => {
    it('uses content[] when rawOutput is only {success:true}', () => {
        const translated = translateAcpToolCall({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc-1',
            title: 'michi__list_threads',
            status: 'completed',
            rawOutput: { success: true },
            content: [{ type: 'text', text: '{"threads":[]}' }],
        });
        assert.equal(translated.output, '{"threads":[]}');
        assert.equal(translated.title, 'michi__list_threads');
    });

    it('uses rawInput.tool_name when title is the useless "MCP: tool"', () => {
        const translated = translateAcpToolCall({
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-2',
            title: 'MCP: tool',
            status: 'pending',
            rawInput: { tool_name: 'michi__list_threads', keyword: 'probe' },
        });
        assert.equal(translated.title, 'michi__list_threads');
        assert.equal(translated.inputJson, JSON.stringify({
            tool_name: 'michi__list_threads',
            keyword: 'probe',
        }));
    });

    it('uses _meta["x.ai/tool"].name when title is useless', () => {
        const translated = translateAcpToolCall({
            title: 'tool',
            toolCallId: 'tc-3',
            rawInput: { _meta: { 'x.ai/tool': { name: 'michi__search_messages' } } },
        });
        assert.equal(translated.title, 'michi__search_messages');
    });

    it('does not emit placeholder output so a later {success:true} cannot wipe a real result', () => {
        const translated = translateAcpToolCall({
            toolCallId: 'tc-4',
            title: 'MCP: tool',
            status: 'completed',
            rawOutput: { success: true },
        });
        assert.equal(translated.title, '');
        assert.equal(translated.output, undefined);
    });

    it('keeps a real Kiro title and stringifies a non-placeholder rawOutput', () => {
        const translated = translateAcpToolCall({
            toolCallId: 'tool-1',
            title: 'Running: @michi/set_branch_overview',
            status: 'completed',
            rawOutput: { items: [{ Json: { content: [{ type: 'text', text: 'ok' }] } }] },
        });
        assert.equal(translated.title, 'Running: @michi/set_branch_overview');
        assert.match(translated.output ?? '', /items/);
    });
});

describe('KiroSession permission enrichment', () => {
    it('emits tool_call_update from permission.toolCall title + fenced JSON content', async () => {
        const session = new KiroSession('node-1', 'sid-1', runtimeWithUpdates([
            {
                sessionUpdate: 'tool_call',
                toolCallId: 'call-cursor-1',
                title: 'MCP: tool',
                kind: 'other',
                status: 'pending',
                rawInput: {},
            },
            {
                sessionUpdate: 'permission_request',
                requestId: 7,
                toolCall: {
                    toolCallId: 'call-cursor-1',
                    title: 'michi-list_threads: list_threads',
                    kind: 'other',
                    status: 'pending',
                    content: [{
                        type: 'content',
                        content: {
                            type: 'text',
                            text: '```json\n{\n  "keyword": "probe"\n}\n```',
                        },
                    }],
                },
                options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
            },
            { sessionUpdate: 'turn_end', stopReason: 'end_turn' },
        ]), '/tmp');

        const events = await collect(session);
        const tools = events.filter((e) => e.kind === 'tool_call' || e.kind === 'tool_call_update');
        assert.equal(tools[0].kind, 'tool_call');
        assert.equal(tools[0].title, '');
        assert.equal(tools[0].inputJson, undefined);

        const enriched = tools.find((e) => e.kind === 'tool_call_update');
        assert.ok(enriched && enriched.kind === 'tool_call_update');
        assert.equal(enriched.toolCallId, 'call-cursor-1');
        assert.equal(enriched.title, 'michi-list_threads: list_threads');
        assert.equal(enriched.status, 'pending');
        assert.equal(enriched.inputJson, '{\n  "keyword": "probe"\n}');

        const perm = events.find((e) => e.kind === 'permission_request');
        assert.ok(perm && perm.kind === 'permission_request');
        assert.equal(perm.toolCallId, 'call-cursor-1');
        assert.equal(perm.title, 'michi-list_threads: list_threads');
    });

    it('uses content[] as output when rawOutput is {success:true}', async () => {
        const session = new KiroSession('node-2', 'sid-2', runtimeWithUpdates([
            {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'call-grok-1',
                title: 'michi__list_threads',
                status: 'completed',
                rawInput: { tool_name: 'michi__list_threads' },
                rawOutput: { success: true },
                content: [{ type: 'text', text: '{"hits":1}' }],
            },
            { sessionUpdate: 'turn_end', stopReason: 'end_turn' },
        ]), '/tmp');

        const events = await collect(session);
        const update = events.find((e) => e.kind === 'tool_call_update');
        assert.ok(update && update.kind === 'tool_call_update');
        assert.equal(update.title, 'michi__list_threads');
        assert.equal(update.output, '{"hits":1}');
    });

    it('uses rawInput.tool_name when ACP title is "MCP: tool"', async () => {
        const session = new KiroSession('node-3', 'sid-3', runtimeWithUpdates([
            {
                sessionUpdate: 'tool_call',
                toolCallId: 'call-3',
                title: 'MCP: tool',
                status: 'in_progress',
                rawInput: { tool_name: 'michi__list_threads', query: 'x' },
            },
            { sessionUpdate: 'turn_end', stopReason: 'end_turn' },
        ]), '/tmp');

        const events = await collect(session);
        const call = events.find((e) => e.kind === 'tool_call');
        assert.ok(call && call.kind === 'tool_call');
        assert.equal(call.title, 'michi__list_threads');
        assert.match(call.inputJson ?? '', /michi__list_threads/);
    });
});

describe('MCP result formatting', () => {
    it('extracts text from a standard MCP tools/call result', () => {
        assert.equal(
            formatMcpToolOutput({ content: [{ type: 'text', text: '{"n":1}' }] }),
            '{"n":1}',
        );
    });

    it('treats {success:true} as a placeholder', () => {
        assert.equal(isPlaceholderToolOutput({ success: true }), true);
        assert.equal(isPlaceholderToolOutput('{"success":true}'), true);
        assert.equal(isPlaceholderToolOutput({ items: [] }), false);
    });
});
