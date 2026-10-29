import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { initDb, closeDb } from '../src/services/db';
import { decideToolApproval, listToolApprovals, toolApprovalId } from '../src/services/metaAgent/toolApprovals';
before(() => { initDb(); });
after(() => { closeDb(); });
import { createMaintenanceAccessTools, isExternalReadOnlyTool, isMaintenanceInternalTool } from '../src/services/metaAgent/maintenanceAccess';
import type { MaintenanceExecutionContext } from '../src/services/pages/maintenanceWriter';
import type { McpToolInfo } from '../src/services/mcpClientManager';

const context = { workspaceId: 'w', ownerUserId: 'u', jobId: 'j', runId: 'r', claimedBy: 'worker', configRevision: 1,
  planId: 'p', sources: [], execution: { nodeId: 'n', turnId: 't', assistantId: 'a', runId: 'r' } } as MaintenanceExecutionContext;
const schema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false };
const read: McpToolInfo = { name: 'search', inputSchema: schema, annotations: { readOnlyHint: true } };
const json = (result: any) => JSON.parse(result.content[0].text);
function setup() {
  let current: MaintenanceExecutionContext | null = context;
  let tools = [read];
  let calls = 0, closed = 0, checked = 0, internalCalls = 0;
  let onConnect = () => {};
  const access = createMaintenanceAccessTools(() => current, {
    assertAuthority: () => { checked++; }, servers: () => [{ serverName: 'external', command: 'unused' }],
    manager: () => ({
      connect: async () => { onConnect(); return { tools }; },
      callTool: async () => { calls++; return { content: [{ type: 'text' as const, text: 'read result' }] }; },
      dispose: async () => { closed++; },
    }),
    internalTools: () => ['edit_page', 'create_database', 'save_page_component', 'bash', 'spawn_agent', 'send_to_thread'].map(name => ({
      name, inputSchema: schema, execute: async () => { internalCalls++; return { content: [{ type: 'text' as const, text: 'written' }] }; },
    })),
  });
  return { list: access[0].execute, call: access[1].execute,
    counters: () => ({ calls, closed, checked, internalCalls }),
    setTools: (value: McpToolInfo[]) => { tools = value; },
    expire: () => { current = null; }, onConnect: (fn: () => void) => { onConnect = fn; } };
}

test('read-only means explicit metadata, never a read-sounding name', () => {
  assert.equal(isExternalReadOnlyTool(read), true);
  for (const tool of [{ ...read, annotations: undefined }, { ...read, annotations: { readOnlyHint: false } },
    { ...read, annotations: { readOnlyHint: true, destructiveHint: true } }, { ...read, execution: { taskSupport: 'required' as const } }]) {
    assert.equal(isExternalReadOnlyTool(tool), false);
  }
  for (const name of ['edit_page', 'create_database', 'save_page_component', 'layout_rules']) assert.equal(isMaintenanceInternalTool(name), true);
  for (const name of ['bash', 'write', 'open_url', 'spawn_agent', 'send_to_thread', 'create_scheduled_job']) assert.equal(isMaintenanceInternalTool(name), false);
});

test('discovery and calls allow internal writes and external reads', async () => {
  const s = setup();
  assert.deepEqual(json(await s.list({})).tools.map((t: any) => t.name), ['edit_page', 'create_database', 'save_page_component']);
  assert.deepEqual(json(await s.list({ server: 'external' })).tools.map((t: any) => t.name), ['search']);
  assert.equal((await s.call({ tool: 'edit_page', arguments: { query: 'edit' } })).isError, undefined);
  assert.equal((await s.call({ server: 'external', tool: 'search', arguments: { query: 'read' } })).isError, undefined);
  assert.equal(s.counters().calls, 1);
  assert.equal(s.counters().internalCalls, 1);
  assert.equal(s.counters().closed, 2);
});

test('fresh discovery rejects a tool changed to write-capable, including direct guessed calls', async () => {
  const s = setup();
  await s.list({ server: 'external' });
  s.setTools([{ ...read, annotations: { readOnlyHint: false } }]);
  assert.equal(json(await s.call({ server: 'external', tool: 'search', arguments: { query: 'x' } })).status, 'approval_required');
  assert.equal(json(await s.call({ server: 'external', tool: 'invented', arguments: {} })).status, 'unavailable');
  assert.equal(json(await s.call({ tool: 'spawn_agent', arguments: { query: 'write externally' } })).status, 'unavailable');
  assert.equal(s.counters().calls, 0);
  assert.equal(s.counters().internalCalls, 0);
});

test('authority is checked after connection and revoked calls close the connection', async () => {
  const s = setup();
  s.onConnect(s.expire);
  assert.equal((await s.call({ server: 'external', tool: 'search', arguments: { query: 'x' } })).isError, true);
  assert.equal(s.counters().calls, 0);
  assert.equal(s.counters().closed, 1);
});

test('schemas and cancellation are enforced before dispatch', async () => {
  const s = setup();
  assert.equal((await s.call({ server: 'external', tool: 'search', arguments: { write: true } })).isError, true);
  assert.equal((await s.call({ tool: 'edit_page', arguments: {} })).isError, true);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(s.call({ tool: 'edit_page', arguments: { query: 'x' } }, controller.signal));
  assert.equal(s.counters().calls, 0);
  assert.equal(s.counters().internalCalls, 0);
  assert.equal(s.counters().closed, 1);
});

test('approval persists across gateways, deduplicates, and is invalidated by definition changes or revocation', async () => {
  const tool = { ...read, name: 'write_approved', annotations: { readOnlyHint: false } };
  const s = setup(); s.setTools([tool]);
  const args = { server: 'external', tool: tool.name, arguments: { query: 'x' } };
  const pending = json(await s.call(args));
  assert.equal(pending.status, 'approval_required');
  assert.equal(json(await s.call(args)).requestId, pending.requestId);
  assert.equal(s.counters().calls, 0);
  assert.equal(decideToolApproval(pending.requestId, 'approved', context.ownerUserId), true);
  const next = setup(); next.setTools([tool]);
  assert.equal((await next.call(args)).isError, undefined);
  assert.equal(next.counters().calls, 1);
  next.setTools([{ ...tool, description: 'changed behavior' }]);
  assert.equal(json(await next.call(args)).status, 'approval_required');
  assert.equal(next.counters().calls, 1);
  decideToolApproval(pending.requestId, 'revoked', context.ownerUserId);
  assert.equal(json(await s.call(args)).status, 'revoked');
  assert.equal(s.counters().calls, 0);
  assert.ok(listToolApprovals(context.ownerUserId).some(r => r.id === pending.requestId && r.state === 'revoked'));
});

test('approval fingerprint covers configuration secrets without storing them and ignores object key order', () => {
  const config = { serverName: 's', command: 'mcp', env: { SECRET: 'one', A: 'a' } };
  assert.equal(toolApprovalId(config, read), toolApprovalId({ ...config, env: { A: 'a', SECRET: 'one' } }, read));
  assert.notEqual(toolApprovalId(config, read), toolApprovalId({ ...config, env: { SECRET: 'two' } }, read));
  assert.ok(!JSON.stringify(listToolApprovals()).includes('SECRET'));
});

test('denial is durable across database reopen and does not generate another pending request', async () => {
  const s = setup(); s.setTools([{ ...read, name: 'denied_tool', annotations: {} }]);
  const args = { server: 'external', tool: 'denied_tool', arguments: { query: 'x' } };
  const pending = json(await s.call(args));
  decideToolApproval(pending.requestId, 'denied');
  closeDb(); initDb();
  const denied = json(await s.call(args));
  assert.equal(denied.status, 'denied');
  assert.equal(denied.requestId, pending.requestId);
  assert.equal(s.counters().calls, 0);
});
