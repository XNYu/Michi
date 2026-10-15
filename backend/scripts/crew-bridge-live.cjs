/** Opt-in official Crew approval + broker acceptance. Only disposable App slots/files. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
if (process.env.MICHI_CREW_LIVE_TEST !== '1') throw new Error('Set MICHI_CREW_LIVE_TEST=1 to run real disposable model calls');
const root = path.resolve(__dirname, '../..');
process.env.TS_NODE_PROJECT = path.join(root, 'backend/tsconfig.json');
require('ts-node/register');
const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { AcpClient } = require('../src/services/acpClient');
const { CrewGatewayClient } = require('../src/agents/crew/acp/gatewayClient');
const { parseCrewAcpConfig } = require('../src/agents/crew/acp/main');
const gateway = new CrewGatewayClient(parseCrewAcpConfig([], process.env).gateway);
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-crew-bridge-'));
const clients = [], slots = [], hits = [];
const report = { startedAt: new Date().toISOString(), checks: [] };
const record = (name, detail = {}) => { const row = { name, ...detail }; report.checks.push(row); console.log(JSON.stringify(row)); };
const resultPath = process.env.MICHI_CREW_LIVE_RESULT || path.join(os.tmpdir(), 'michi-crew-bridge-result.json');
const endpoints = new Map();
let http, port, reloadProbe;
const config = id => [{ name: 'michi', type: 'http', url: `http://127.0.0.1:${port}/api/mcp/${id}`, headers: [] }];
async function client() {
    const previous = process.env.MICHI_CREW_MEMORY_MODE;
    process.env.MICHI_CREW_MEMORY_MODE = 'temporary';
    const c = new AcpClient(undefined, cwd, undefined, 'v2', { bin: process.execPath,
        args: () => [path.join(root, 'backend/dist/crewAcp.js'), '--model', process.env.MICHI_CREW_LIVE_MODEL || 'claude-sonnet-4.6'],
        standardFork: true, cancelTimeoutMs: 15000 });
    clients.push(c);
    try { c.start(); } finally { if (previous === undefined) delete process.env.MICHI_CREW_MEMORY_MODE; else process.env.MICHI_CREW_MEMORY_MODE = previous; }
    await c.initialize(); return c;
}
async function session(mcp = []) {
    const c = await client(); const info = await c.newSession(mcp);
    slots.push(info.sessionId);
    await c.setMode(info.sessionId, `template:${process.env.MICHI_CREW_LIVE_AGENT || 'kirocrew'}`);
    return { c, sid: info.sessionId };
}
async function turn({c, sid}, message, decision = 'allow_once') {
    const controller = new AbortController(), events = [];
    let timedOut = false, approvals = 0;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); void c.cancel(sid); }, 150000);
    try {
        for await (const event of c.prompt(sid, message, [], controller.signal)) {
            events.push(event);
            if (event.sessionUpdate === 'permission_request') {
                approvals++;
                record('observed official approval request', { decision, title: event.toolCall?.title });
                if (decision === 'cancel') { controller.abort(); await c.cancel(sid); }
                else c.respondToPermissionKind(event.requestId, decision);
            }
        }
        assert.equal(timedOut, false, 'Live check exceeded 150 seconds');
        if (decision !== 'cancel') assert.equal(events.at(-1)?.stopReason, 'end_turn');
        return { events, approvals, text: events.filter(e=>e.sessionUpdate==='agent_message_chunk').map(e=>e.content?.text||'').join('') };
    } finally { clearTimeout(timer); }
}
async function approvals() {
    assert.equal(await gateway.approvalsAvailable(), true);
    for (const decision of ['allow_once', 'reject_once', 'cancel']) {
        const s = await session();
        const file = path.join(cwd, decision + '.txt');
        const result = await turn(s, `Disposable permission integration test. Use the shell tool exactly once to run: printf 'BRIDGE_OK' > ${file} . If denied or cancelled, stop and do not retry or use another tool. Do not read other files, save memory, use network, or spawn agents. Then report success or denial.`, decision);
        if (!result.approvals) record('approval diagnostic', { decision, reply: result.text,
            fileCreated: fs.existsSync(file), tools: result.events.filter(e => e.sessionUpdate === 'tool_call').map(e => ({ title:e.title, status:e.status })) });
        assert.ok(result.approvals > 0, 'Crew native policy did not issue a permission request; cannot claim approval coverage');
        if (decision === 'allow_once') assert.equal(fs.readFileSync(file,'utf8'), 'BRIDGE_OK');
        else assert.equal(fs.existsSync(file), false);
        record('approval ' + decision, { approvals: result.approvals, expectedFileState: true });
        if (decision === 'cancel') {
            const next = await turn(s, 'Reply exactly CANCEL_RECOVERED. No tools.');
            assert.match(next.text, /CANCEL_RECOVERED/);
            record('cancelled approval followed by clean successor');
        }
    }
}
async function fixture() {
    const app = express(); app.use(express.json());
    app.post('/api/mcp/:id', async (req, res) => {
        const marker = endpoints.get(req.params.id);
        if (!marker) return res.sendStatus(404);
        const mcp = new McpServer({ name:'michi-diagnostic', version:'1' });
        mcp.registerTool('identify', { description:'Return this exact diagnostic conversation marker', inputSchema:{} }, async()=>{
            hits.push(req.params.id); if (reloadProbe && req.params.id === reloadProbe.id) reloadProbe.onIdentify();
            return {content:[{type:'text',text:marker}]};
        });
        const transport = new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
        res.on('close',()=>{void transport.close();void mcp.close();});
        await mcp.connect(transport); await transport.handleRequest(req,res,req.body);
    });
    http=app.listen(0,'127.0.0.1'); await once(http,'listening'); port=http.address().port;
}
function endpoint() { const id=randomUUID(), marker='MCP_'+randomUUID(); endpoints.set(id,marker); return {id,marker}; }
const mcpPrompt = 'Disposable Michi broker test. Call michi_list_tools from michi-crew-runtime:michi, then michi_call_tool with {"tool":"identify","arguments":{}}. Return the exact diagnostic marker from the tool result. Use no other tools, no files, no memory and no subagents. Do not infer or reuse a previous marker.';
async function checkEndpoint(s,e,name) {
    const before=hits.length; let result=await turn(s,mcpPrompt);
    if (/Execution memory is unavailable: session changed during privacy tightening/.test(result.text)) {
        record('official temporary Memory initialization race; one clean retry', { nameOfCheck: name });
        result = await turn(s,mcpPrompt);
    }
    if (!hits.slice(before).includes(e.id)) record('MCP routing diagnostic', { reply: result.text, outputs: result.events.filter(e => e.sessionUpdate === 'tool_call_update').map(e => ({ title: e.title, output: e.rawOutput })) });
    assert.ok(hits.slice(before).includes(e.id), 'No identify call reached the expected endpoint');
    assert.ok(result.text.includes(e.marker), 'Result did not contain this endpoint marker');
    for(const other of endpoints.values()) if(other!==e.marker) assert.ok(!result.text.includes(other),'Foreign marker leaked');
    record(name,{markerMatched:true,approvals:result.approvals});
}
async function mcp() {
    await fixture();
    const a=endpoint(), b=endpoint();
    const sa=await session(config(a.id)), sb=await session(config(b.id));
    const concurrent = await Promise.allSettled([checkEndpoint(sa,a,'official broker concurrent slot A'),checkEndpoint(sb,b,'official broker concurrent slot B')]);
    for (const result of concurrent) if (result.status === 'rejected') throw result.reason;
    if (process.argv.includes('--relay-update')) {
        const relay = path.join(root, 'backend/dist/crewMcp.js');
        const original = fs.readFileSync(relay, 'utf8');
        const marker = 'UPDATED_RELAY_' + randomUUID();
        const hostPids = () => execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
            .filter(line => line.includes(path.join(root, 'backend/dist/crewMcpHost.js')) && !line.includes('ps -axo'))
            .map(line => Number(line.trim().split(/\s+/)[0])).sort((a,b)=>a-b);
        let before, applied = false, secondObserved = false;
        try {
            const probe = `\nconst originalHandlers = module.exports.createCrewMcpHandlers;
module.exports = {...module.exports, createCrewMcpHandlers: (directory) => {
 const handlers = originalHandlers(directory);
 return {...handlers, callTool: async (...args) => {
  const result = await handlers.callTool(...args);
  return {...result, content:[...(result.content||[]),{type:'text',text:${JSON.stringify(marker)}}]};
 }};
}};\n`;
            reloadProbe = { id: a.id, onIdentify: () => {
                if (!applied) {
                    before = hostPids();
                    assert.ok(before.length > 0, 'No production MCP host process observed during tool call');
                    fs.writeFileSync(relay + '.probe', original + probe);
                    fs.renameSync(relay + '.probe', relay); applied = true;
                } else {
                    assert.deepEqual(hostPids(), before, 'MCP host was restarted within the model turn');
                    secondObserved = true;
                }
            }};
            const updated = await turn(sa, mcpPrompt + ' Perform this identify procedure twice in this same turn, making the second call only after the first returns. Also return any UPDATED_RELAY diagnostic marker from the second tool result.');
            assert.ok(applied && secondObserved, 'Both identify calls must reach the fixture in the same turn');
            if (!updated.text.includes(marker)) record('relay generation diagnostic', {reply: updated.text, outputs: updated.events.filter(e => e.sessionUpdate === 'tool_call_update').map(e => ({title:e.title, output:e.rawOutput}))});
            assert.ok(updated.text.includes(marker), 'Official model did not see new relay generation');
            record('official broker uses updated relay on its existing host connection', { markerMatched: true, hostProcessesRetained: true });
        } finally {
            reloadProbe = undefined;
            if (applied) { fs.writeFileSync(relay + '.probe', original); fs.renameSync(relay + '.probe', relay); }
        }
        await checkEndpoint(sa,a,'original relay restored without disconnect');
    }
    await sa.c.shutdown(); const resumed=await client(); const r=endpoint();
    await resumed.loadSession(sa.sid,cwd,config(r.id));
    await checkEndpoint({c:resumed,sid:sa.sid},r,'adapter restart resumes with fresh endpoint');
    const child=await resumed.forkSession(sa.sid); slots.push(child); const f=endpoint();
    await resumed.loadSession(child,cwd,config(f.id));
    await checkEndpoint({c:resumed,sid:child},f,'native fork binds independent endpoint');
    const unbound=await session(); const before=hits.length;
    const denied=await turn(unbound,mcpPrompt);
    assert.equal(hits.length,before,'Unbound slot reached a Michi endpoint');
    assert.ok(![...endpoints.values()].some(marker=>denied.text.includes(marker)));
    record('unbound official slot cannot borrow another endpoint');
}
(async()=>{
    try {
        if(!process.argv.includes('--mcp-only')) await approvals();
        if(!process.argv.includes('--approvals-only')) await mcp();
        report.ok=true;
    } catch(error) { report.ok=false; report.error=String(error); console.error(report.error); process.exitCode=1; }
    finally {
        for(const c of clients) await c.shutdown().catch(()=>{});
        for(const sid of slots) try { await gateway.stop(sid); await gateway.deleteSlot(sid); } catch(error) {record('cleanup failed',{sid,error:String(error)});report.ok=false;process.exitCode=1;}
        gateway.close();
        if(http){http.closeAllConnections();await new Promise(resolve=>http.close(resolve));}
        fs.rmSync(cwd,{recursive:true,force:true});
        report.finishedAt=new Date().toISOString(); record('cleanup',{slots:slots.length});
        fs.writeFileSync(resultPath,JSON.stringify(report,null,2)+'\n'); console.log('Result: '+resultPath);
    }
})();
