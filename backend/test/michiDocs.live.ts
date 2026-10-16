/** Optional real Kiro acceptance. Uses account quota; no user workspace/state.
 * MICHI_DOCS_LIVE=1 npm exec -w backend -- node --require ts-node/register test/michiDocs.live.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AcpClient } from '../src/services/acpClient';
import { michiMcpServer } from '../src/agents/kiro/kiroProtocol';
import { buildMcpServerForSlot, McpSlotRegistry } from '../src/services/mcpServer';
import { buildStableSystemPrompt } from '../src/agents/preamble';

if (process.env.MICHI_DOCS_LIVE !== '1') throw new Error('Set MICHI_DOCS_LIVE=1 to use the real Kiro CLI');

async function main() {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'michi-docs-live-')));
    const calls: unknown[] = [];
    const permissions: string[] = [];
    const updates: unknown[] = [];
    const slot = new McpSlotRegistry().create('docs-live', dir, null, {
        exposedToolNames: new Set(['michi_docs']), onSpawnBranches: async () => [],
        onSaveArtifact: () => null, onUpdateArtifact: () => null,
        onShowImage: () => ({ error: 'unavailable' }),
    });
    const app = express(); app.use(express.json());
    app.post('/mcp/docs', async (req, res) => {
        if (req.body.method === 'tools/call') calls.push(req.body.params);
        const server = buildMcpServerForSlot(slot);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => { void transport.close(); void server.close(); });
        await server.connect(transport); await transport.handleRequest(req, res, req.body);
    });
    const http = app.listen(0, '127.0.0.1'); await once(http, 'listening');
    const client = new AcpClient(undefined, dir, undefined, 'v3');
    const watchdog = setTimeout(() => { void client.shutdown(); }, 180_000);
    try {
        client.start(); await client.initialize();
        const baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
        const session = await client.newSession([michiMcpServer('v3', baseUrl, 'docs')], {
            modelId: process.env.MICHI_DOCS_LIVE_MODEL ?? 'claude-sonnet-4.6',
        });
        for await (const event of client.prompt(session.sessionId, buildStableSystemPrompt() + '\n\n'
            + 'Use Michi built-in documentation to answer in Chinese: where should I select Crew approvals, '
            + 'what if sessionApproval consent is missing, and what is the update/Sync workflow? '
            + 'Search the relevant documents and read the relevant lines before answering; cite document IDs and lines. '
            + 'Do not use tools other than Michi docs and tool discovery. Do not change any files or settings.')) {
            if (event.sessionUpdate === 'permission_request') {
                const title = event.toolCall?.title ?? 'unknown'; permissions.push(title);
                const allow = event.options?.find((option: any) => option.kind === 'allow_once');
                if (/michi_docs/.test(title) && allow) client.respondToPermission(event.requestId, allow.optionId);
                else client.cancelPermission(event.requestId);
            }
            if (event.sessionUpdate === 'agent_message_chunk') updates.push(event);
            if (event.sessionUpdate === 'runtime_error') throw new Error(event.error);
        }
        assert.ok(calls.some((call: any) => call.name === 'michi_docs' && call.arguments.action === 'search'), 'agent searched docs');
        assert.ok(calls.some((call: any) => call.name === 'michi_docs' && call.arguments.action === 'read'), 'agent read docs');
        assert.ok(calls.every((call: any) => call.name === 'michi_docs'), 'only docs invoked');
        assert.match(JSON.stringify(updates), /sessionApproval/);
        assert.match(JSON.stringify(updates), /Sync/);
        console.info('REAL KIRO DOCS ACCEPTANCE PASSED');
    } finally {
        clearTimeout(watchdog);
        await client.shutdown(); http.closeAllConnections();
        await new Promise<void>(resolve => http.close(() => resolve()));
        const evidence = path.join(dir, 'results.json');
        fs.writeFileSync(evidence, JSON.stringify({ calls, permissions, updates }, null, 2));
        console.info(`Evidence: ${evidence}`);
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
