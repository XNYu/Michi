import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { JSON_BODY_LIMIT_BYTES } from '../src/core/constants';
import { createCrewMcpRelay, createCrewStdioTransport } from '../src/adapters/crew/crewMcpRelay';

const BYTES = 11 * 1024 * 1024;

/**
 * Writes initialize and an 11 MiB michi_call_tool to a relay over `transport`
 * in 64 KiB chunks, as a broker's pipe delivers it. The relay has no session
 * binding, so a call it reads comes back as its "unavailable" tool error.
 * Returns that answer, or undefined when the transport closed first.
 */
async function callThrough(make: (stdin: PassThrough, stdout: PassThrough) => StdioServerTransport) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'crew-stdio-'));
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const relay = createCrewMcpRelay(directory);
    let closed = false;
    relay.onclose = () => { closed = true; };
    relay.onerror = () => {};
    let output = '';
    stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    await relay.connect(make(stdin, stdout));
    const send = (message: unknown) => {
        const line = Buffer.from(`${JSON.stringify(message)}\n`);
        for (let at = 0; at < line.length; at += 64 * 1024) stdin.write(line.subarray(at, at + 64 * 1024));
    };
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'broker', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'michi_call_tool', arguments: { tool: 'save_artifact', arguments: { body: 'x'.repeat(BYTES) } } } });
    const answer = () => output.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((message) => message.id === 2);
    for (let i = 0; i < 200 && !answer() && !closed; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    const result = answer();
    const closedByCall = closed;
    await relay.close();
    await fs.rm(directory, { recursive: true, force: true });
    return { result, closed: closedByCall };
}

test('the Crew relay reads a tool call above the SDK default stdio buffer, up to the JSON body limit', async () => {
    assert.ok(BYTES > STDIO_DEFAULT_MAX_BUFFER_SIZE && BYTES < JSON_BODY_LIMIT_BYTES);
    const relayed = await callThrough((stdin, stdout) => createCrewStdioTransport(stdin, stdout));
    assert.equal(relayed.closed, false);
    assert.equal(relayed.result?.result?.isError, true);
    assert.match(relayed.result?.result?.content?.[0]?.text ?? '', /Michi MCP is unavailable for this conversation \(session binding:/);

    // The SDK's default closes the transport on the same call, and every Michi tool of the session with it.
    const defaulted = await callThrough((stdin, stdout) => new StdioServerTransport(stdin, stdout));
    assert.equal(defaulted.result, undefined);
    assert.equal(defaulted.closed, true);
});
