import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { KiroSession } from '../src/agents/kiro/KiroSession';
import type { KiroRuntime } from '../src/agents/kiro/KiroRuntime';

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

describe('KiroSession metadata completion tail', () => {
    it('strips a completion sentinel split across ACP chunks and keeps it out of history', async () => {
        const session = new KiroSession('node-1', 'session-1', runtimeWithUpdates([
            { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Visible answer.' } },
            { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '[MICHI_META' } },
            { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'DATA_DONE]' } },
            { sessionUpdate: 'turn_end', stopReason: 'end_turn' },
        ]), '/tmp');

        const events = [];
        for await (const event of session.send('hello')) events.push(event);

        assert.equal(
            events.filter((event) => event.kind === 'chunk').map((event) => event.text).join(''),
            'Visible answer.',
        );
        assert.deepEqual(events.at(-1), { kind: 'turn_end', stopReason: 'end_turn' });
        assert.deepEqual(session.getHistory(), [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'Visible answer.' },
        ]);
    });

    it('releases a held prefix when later text proves it is ordinary prose', async () => {
        const session = new KiroSession('node-2', 'session-2', runtimeWithUpdates([
            { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Literal [MICHI_META' } },
            { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'X remains visible.' } },
            { sessionUpdate: 'turn_end', stopReason: 'end_turn' },
        ]), '/tmp');

        const chunks: string[] = [];
        for await (const event of session.send('hello')) {
            if (event.kind === 'chunk') chunks.push(event.text);
        }

        assert.equal(chunks.join(''), 'Literal [MICHI_METAX remains visible.');
    });

    it('removes the hidden completion instruction from persisted tool output', async () => {
        const session = new KiroSession('node-3', 'session-3', runtimeWithUpdates([
            {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tool-1',
                title: 'Running: @michi/set_branch_overview',
                status: 'completed',
                rawOutput: {
                    items: [{
                        Json: {
                            content: [{
                                type: 'text',
                                text: 'Branch overview recorded. This turn\'s user-facing response is already complete; emit [MICHI_METADATA_DONE] as the runtime end-of-turn marker (auto-stripped before display).',
                            }],
                        },
                    }],
                },
            },
            { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '[MICHI_METADATA_DONE]' } },
            { sessionUpdate: 'turn_end', stopReason: 'end_turn' },
        ]), '/tmp');

        const events = [];
        for await (const event of session.send('hello')) events.push(event);

        const toolUpdate = events.find((event) => event.kind === 'tool_call_update');
        assert.ok(toolUpdate && toolUpdate.kind === 'tool_call_update');
        assert.equal(toolUpdate.output?.includes('[MICHI_METADATA_DONE]'), false);
        assert.equal(toolUpdate.output?.includes('Branch overview recorded.'), true);
    });

    it('extracts __tool_use_purpose from object and stringified rawInput', async () => {
        const purpose = 'Check the project manifest to understand the package definition';
        const rawInput = {
            __tool_use_purpose: purpose,
            operations: [{ mode: 'Line', path: '/workspace/example-app/package.json' }],
        };
        const session = new KiroSession('node-4', 'session-4', runtimeWithUpdates([
            {
                sessionUpdate: 'tool_call',
                toolCallId: 'read-1',
                title: 'Read',
                kind: 'read',
                status: 'pending',
                rawInput,
            },
            {
                sessionUpdate: 'tool_call',
                toolCallId: 'read-2',
                title: 'Read',
                kind: 'read',
                status: 'pending',
                rawInput: JSON.stringify(rawInput),
            },
            { sessionUpdate: 'turn_end', stopReason: 'end_turn' },
        ]), '/tmp');

        const events = [];
        for await (const event of session.send('hello')) events.push(event);
        const tools = events.filter((event) => event.kind === 'tool_call');
        assert.equal(tools.length, 2);
        assert.equal(tools[0]?.kind === 'tool_call' && tools[0].detail, purpose);
        assert.equal(tools[1]?.kind === 'tool_call' && tools[1].detail, purpose);
        assert.equal(
            tools[0]?.kind === 'tool_call' && JSON.parse(tools[0].inputJson ?? '{}').__tool_use_purpose,
            purpose,
        );
    });
});
