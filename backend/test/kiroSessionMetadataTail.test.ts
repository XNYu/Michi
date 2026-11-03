import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AcpAgentSession } from 'michi-runtime/internal/adapters/kiro/AcpAgentSession';
import type { AcpAgentRuntime } from 'michi-runtime/internal/adapters/kiro/AcpAgentRuntime';
import { michiTestHost } from './helpers/michiTestHost';

function runtimeWithUpdates(updates: Array<Record<string, unknown>>): AcpAgentRuntime {
    const client = {
        async *prompt() {
            for (const update of updates) yield update;
        },
    };
    return {
        host: michiTestHost(),
        ensureClient: async () => client,
        getCurrentMode: () => null,
        getCurrentModel: () => null,
    } as unknown as AcpAgentRuntime;
}

describe('AcpAgentSession metadata completion tail', () => {
    it('shows a set_branch_overview result without the instruction it gives Kiro', async () => {
        // The result Michi's MCP server returns for a Kiro slot (services/mcpServer.ts).
        const result = 'Branch overview recorded. This turn\'s user-facing response is already complete; emit [MICHI_METADATA_DONE] as the runtime end-of-turn marker (auto-stripped before display).';
        const session = new AcpAgentSession('node-5', 'session-5', runtimeWithUpdates([
            { sessionUpdate: 'tool_call_update', toolCallId: 'overview-1', title: 'set_branch_overview', status: 'completed', rawOutput: result },
            { sessionUpdate: 'tool_call_update', toolCallId: 'other-1', title: 'Read', status: 'completed', rawOutput: 'file contents' },
            { sessionUpdate: 'turn_end', stopReason: 'end_turn' },
        ]), '/tmp');
        const outputs: Array<string | undefined> = [];
        for await (const event of session.send('hello')) if (event.kind === 'tool_call_update') outputs.push(event.output);
        assert.deepEqual(outputs, ['Branch overview recorded.', 'file contents']);
    });

    it('strips a completion sentinel split across ACP chunks and keeps it out of history', async () => {
        const session = new AcpAgentSession('node-1', 'session-1', runtimeWithUpdates([
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

    it('extracts __tool_use_purpose from object and stringified rawInput', async () => {
        const purpose = 'Check the project manifest to understand the package definition';
        const rawInput = {
            __tool_use_purpose: purpose,
            operations: [{ mode: 'Line', path: '/workspace/example-app/package.json' }],
        };
        const session = new AcpAgentSession('node-4', 'session-4', runtimeWithUpdates([
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
