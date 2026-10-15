import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    test(`${signal} stops the owned native task and removes MCP leases before the adapter exits`, async t => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-crew-lifecycle-'));
        const appDir = path.join(home, 'apps/michi-crew-runtime');
        const bindings = path.join(home, 'mcp');
        fs.mkdirSync(appDir, { recursive: true });
        fs.writeFileSync(path.join(appDir, '.app_secret'), 'test-only-secret');
        fs.writeFileSync(path.join(appDir, 'app.json'), JSON.stringify({ permissions: { sessionApproval: true }, mcpServers: { michi: {} } }));
        fs.writeFileSync(path.join(appDir, 'installed.json'), JSON.stringify({ enabled: true }));
        fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ mcp_gateway: { stub_servers: ['michi-crew-runtime:michi'] } }));
        let slot = '', running = false, stopCompleted = false;
        const requests: string[] = [];
        let streaming!: () => void;
        const started = new Promise<void>(resolve => { streaming = resolve; });
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                const route = new URL(req.url!, 'http://localhost').pathname;
                requests.push(`${req.method} ${route}`);
                const json = (value: unknown) => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(value));
                };
                if (route.endsWith('/token')) return json({ token: 'test-only-token' });
                if (route === '/api/models') return json([]);
                if (route === '/api/agents/catalog') return json({ agents: [] });
                if (route === '/api/chat/slots' && req.method === 'GET') return json([{ key: slot, app: 'michi-crew-runtime' }]);
                if (route === '/api/chat/mode') return json({});
                if (route === '/api/chat/slots' && req.method === 'POST') {
                    slot = JSON.parse(body).name;
                    return json({ key: slot });
                }
                if (route.endsWith('/project')) return json({});
                if (route === `/api/chat/slots/${slot}`) return json({ key: slot, running, messages: [] });
                if (route.endsWith('/stop')) {
                    setTimeout(() => { running = false; stopCompleted = true; json({}); }, 30);
                    return;
                }
                if (route === '/api/chat') {
                    running = true;
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    res.write('data: {"type":"chunk","content":"working"}\n\n');
                    streaming();
                    return;
                }
                res.writeHead(404); res.end();
            });
        });
        const ws = new WebSocketServer({ server });
        ws.on('connection', socket => { socket.send(JSON.stringify({ type: 'slots', data: {} })); });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const port = (server.address() as AddressInfo).port;
        const child = spawn(process.execPath, ['--require', require.resolve('ts-node/register'),
            path.join(__dirname, '../src/agents/crew/acp/main.ts')], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, TS_NODE_PROJECT: path.join(__dirname, '../tsconfig.json'),
                KIROCREW_HOME: home, MICHI_CREW_APP: 'michi-crew-runtime',
                CREW_GATEWAY_URL: `http://127.0.0.1:${port}`, MICHI_CREW_AGENT: '', MICHI_CREW_MCP_DIR: bindings },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        t.after(async () => {
            if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
            for (const socket of ws.clients) socket.terminate();
            ws.close(); server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
            fs.rmSync(home, { recursive: true, force: true });
        });
        let seq = 0, buffer = '', stderr = '';
        const pending = new Map<number, (value: any) => void>();
        child.on('exit', (code, signal) => {
            for (const resolve of pending.values()) resolve({ error: { message: `Adapter exited: ${code ?? signal}; ${stderr}` } });
            pending.clear();
        });
        child.stderr.on('data', bytes => { stderr += bytes; });
        child.stdout.on('data', bytes => {
            buffer += bytes;
            let newline: number;
            while ((newline = buffer.indexOf('\n')) >= 0) {
                const message = JSON.parse(buffer.slice(0, newline));
                buffer = buffer.slice(newline + 1);
                if (pending.has(message.id)) { pending.get(message.id)!(message); pending.delete(message.id); }
            }
        });
        const rpc = (method: string, params: unknown) => new Promise<any>(resolve => {
            const id = ++seq; pending.set(id, resolve);
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
        const created = await rpc('session/new', { cwd: home, mcpServers: [
            { name: 'michi', type: 'http', url: `http://127.0.0.1:${port}/api/mcp/test-capability`, headers: [] },
        ] });
        assert.ok(created.result?.sessionId, stderr);
        const prompt = rpc('session/prompt', { sessionId: created.result.sessionId, prompt: [{ type: 'text', text: 'test' }] });
        await Promise.race([started, prompt.then(reply => { throw new Error(`Prompt ended before streaming: ${JSON.stringify(reply)}; ${stderr}`); })]);
        assert.ok(fs.readdirSync(bindings).some(name => name.startsWith('lease-')));
        const exited = once(child, 'exit');
        child.kill(signal);
        assert.deepEqual(await exited, [0, null], stderr);
        assert.equal(stopCompleted, true);
        assert.equal(running, false);
        assert.equal(requests.filter(route => route.endsWith('/stop')).length, 1);
        assert.equal(requests.some(route => route.startsWith('DELETE ')), false, 'shutdown preserves native history');
        assert.equal(fs.readdirSync(bindings).some(name => name.startsWith('lease-')), false);
    });
}
