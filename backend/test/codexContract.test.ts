import './contracts/codex/isolation';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { applyTurnEvent, createDurableTurn, parseChatStreamEvent } from 'michi-shared';
import { createCodexTranslator } from '../src/agents/codex/codexEventTranslator';
import { CODEX_SERVER_REQUESTS } from '../src/agents/codex/codexProtocol';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { toChatStreamEvent } from '../src/routes/chatStreamEvents';
import { baselineDir, manifest, schema, assertSchema, validator, discriminants, tsDiscriminants, variableStringLiterals } from './contracts/codex/schema';
import { notifications, requests, items, consumedEnums, responseTypes, tsOnlyNotifications } from './contracts/codex/dispositions';
import { activeWire, wireClient, tick, threadId, turnId, turnNotification } from './contracts/codex/wire';

const registeredCases = new Set<string>();
function contract(name: string, fn: (t: TestContext) => void | Promise<void>) {
  registeredCases.add(name);
  test(`Codex contract: ${name}`, fn);
}
const approvalParams = { threadId, turnId, itemId: 'tool-1', startedAtMs: 0 };
const question = (id: string, text = 'Same question?') => ({ id, header: 'Choice', question: text, isOther: false, isSecret: false,
  options: [{ label: 'Yes', description: 'Proceed' }, { label: 'No', description: 'Stop' }] });
const inputParams = { threadId, turnId, itemId: 'input-1', isBlocking: true, autoResolutionMs: null, questions: [question('q-1'), question('q-2')] };

contract('inventory and provenance', () => {
  assert.equal(manifest.experimental, true);
  assert.deepEqual(manifest.initializeCapabilities, { experimentalApi: true });
  assert.deepEqual(Object.keys(manifest.sha256).sort(), ['ServerNotification.ts.txt', 'ServerRequest.ts.txt', 'ThreadItem.ts.txt', 'protocol.schema.json'].sort());
  for (const [file, hash] of Object.entries(manifest.sha256)) {
    assert.equal(createHash('sha256').update(readFileSync(path.join(baselineDir, file))).digest('hex'), hash, `${file}: stale manifest`);
  }
  for (const [name, key, groups] of [
    ['ServerNotification', 'method', notifications], ['ServerRequest', 'method', requests], ['ThreadItem', 'type', items],
  ] as const) {
    const jsonNames = discriminants(name, key).sort();
    const actual = tsDiscriminants(name, key).sort();
    const exceptions = name === 'ServerNotification' ? tsOnlyNotifications[manifest.cliVersion] ?? [] : [];
    assert.deepEqual(actual.filter((value) => !jsonNames.includes(value)), exceptions, `${name}: unreviewed TS-only surface`);
    assert.deepEqual(jsonNames.filter((value) => !actual.includes(value)), [], `${name}: unreviewed JSON-only surface`);
    const classified = groups.flatMap((group) => {
      assert.ok(group.reason.trim().length > 0, `${name}: reason required`);
      if (group.disposition === 'handled' || group.disposition === 'compatibility' || name === 'ServerRequest') assert.ok(group.test, `${name}: tested behavior required`);
      if (group.test) assert.ok(registeredCases.has(group.test), `${name}: missing test ${group.test}`);
      return group.names;
    });
    assert.equal(new Set(classified).size, classified.length, `${name}: duplicate disposition`);
    assert.deepEqual(classified.sort(), actual, `${name}: unreviewed addition/removal/rename`);
  }
  for (const [name, mapping] of Object.entries(consumedEnums)) {
    assert.deepEqual(Object.keys(mapping).sort(), [...schema.definitions.v2[name].enum].sort(), `${name}: enum drift`);
  }
  const methods = discriminants('ServerRequest', 'method');
  assert.deepEqual(Object.keys(responseTypes).sort(), methods.sort());
  for (const type of Object.values(responseTypes)) assert.ok(validator(type));
  for (const method of Object.values(CODEX_SERVER_REQUESTS)) assert.ok(methods.includes(method), `unofficial runtime method: ${method}`);
  const translator = path.join(__dirname, '../src/agents/codex/codexEventTranslator.ts');
  const officialNotifications = tsDiscriminants('ServerNotification', 'method');
  for (const name of variableStringLiterals(translator, 'N')) assert.ok(officialNotifications.includes(name), `unofficial translator method: ${name}`);
  const acceptedItems = [...tsDiscriminants('ThreadItem', 'type'), 'compaction', 'context_compaction'];
  for (const group of ['TOOL_ITEM_TYPES', 'COMPACTION_ITEM_TYPES']) {
    for (const name of variableStringLiterals(translator, group)) assert.ok(acceptedItems.includes(name), `unofficial item: ${name}`);
  }
});

contract('wire approvals', async (t) => {
  const wire = await activeWire(t);
  const initialize = wire.outgoing.find((message) => message.method === 'initialize')!;
  assertSchema('ClientRequest', initialize);
  assert.deepEqual(initialize.params.capabilities, manifest.initializeCapabilities);
  for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']) {
    for (const [answer, decision] of [['allow_once', 'accept'], ['reject_once', 'decline'], ['cancel', 'decline']]) {
      const id = `${method}:${answer}`;
      wire.send({ id, method, params: { ...approvalParams, command: 'echo fixture' } }, 'ServerRequest');
      await tick();
      const [localId] = wire.session.pendingPermissions.keys();
      assert.equal(typeof localId, 'number');
      if (answer === 'cancel') wire.session.cancelPermission(localId);
      else wire.session.respondToPermission(localId, answer);
      await tick();
      assert.deepEqual(wire.response(id, method).result, { decision });
    }
    wire.broker.decision = 'allow_always';
    wire.send({ id: `${method}:session`, method, params: approvalParams }, 'ServerRequest');
    await tick();
    assert.deepEqual(wire.response(`${method}:session`, method).result, { decision: 'acceptForSession' });
    wire.broker.decision = 'ask';
    wire.send({ id: `${method}:missing`, method, params: { ...approvalParams, threadId: 'missing' } }, 'ServerRequest');
    assert.deepEqual(wire.response(`${method}:missing`, method).result, { decision: 'decline' });
  }
});

contract('wire input', async (t) => {
  const wire = await activeWire(t);
  const method = 'item/tool/requestUserInput';
  wire.send({ id: 'input-duplicate-labels', method, params: inputParams }, 'ServerRequest');
  await tick();
  const prompt = wire.events.find((event) => event.kind === 'user_input_request');
  assert.ok(prompt?.kind === 'user_input_request');
  assert.deepEqual(prompt.questions.map((q) => q.id), ['q-1', 'q-2']);
  const stream = toChatStreamEvent(prompt);
  const parsed = parseChatStreamEvent(stream.event, JSON.stringify(stream.data));
  assert.ok(parsed?.event === 'user_input_request');
  assert.deepEqual(parsed.data.questions.map((q) => q.id), ['q-1', 'q-2']);
  wire.session.respondToUserInput(prompt.requestId, [
    { id: 'q-2', question: 'Same question?', answer: 'No' },
    { id: 'q-1', question: 'Same question?', answer: 'Yes' },
    { id: 'not-requested', question: 'Same question?', answer: 'do not forward' },
  ]);
  await tick();
  assert.deepEqual(wire.response('input-duplicate-labels', method).result, { answers: {
    'q-1': { answers: ['Yes'] }, 'q-2': { answers: ['No'] },
  } });

  for (const [id, params] of [
    ['missing', { ...inputParams, threadId: 'missing' }],
    ['stale', { ...inputParams, turnId: 'previous-turn' }],
    ['secret', { ...inputParams, questions: [{ ...question('password'), isSecret: true }] }],
  ] as const) {
    const before = wire.events.filter((event) => event.kind === 'user_input_request').length;
    wire.send({ id, method, params }, 'ServerRequest');
    await tick();
    assert.deepEqual(wire.response(id, method).result, { answers: {} });
    assert.equal(wire.events.filter((event) => event.kind === 'user_input_request').length, before);
  }
  for (const mode of ['skip', 'ambiguous-label', 'turn-completed']) {
    wire.send({ id: mode, method, params: inputParams }, 'ServerRequest');
    await tick();
    const latest = wire.events.filter((event) => event.kind === 'user_input_request').at(-1)!;
    if (mode === 'skip') wire.session.skipUserInput(latest.requestId);
    else if (mode === 'turn-completed') wire.send(turnNotification('completed'), 'ServerNotification');
    else wire.session.respondToUserInput(latest.requestId, [{ question: 'Same question?', answer: 'Yes' }]);
    await tick();
    assert.deepEqual(wire.response(mode, method).result, { answers: {} });
  }
});

contract('wire fallback', async (t) => {
  const wire = await activeWire(t);
  const permissionMethod = 'item/permissions/requestApproval';
  for (const target of [threadId, 'missing']) {
    const params = { ...approvalParams, threadId: target, cwd: '/tmp', permissions: { network: { enabled: true }, fileSystem: { write: ['/tmp/example'] } } };
    wire.send({ id: `permission:${target}`, method: permissionMethod, params }, 'ServerRequest');
    assert.deepEqual(wire.response(`permission:${target}`, permissionMethod).result, { permissions: {}, scope: 'turn' });
    assert.equal(wire.session.pendingPermissions.size, 0, 'profile must not use generic tool approval');
  }
  for (const params of [
    { mode: 'form', message: 'Required project', requestedSchema: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'] } },
    { mode: 'form', message: 'Empty form', requestedSchema: { type: 'object', properties: {} } },
    { mode: 'url', message: 'Verify', url: 'https://example.invalid/verify', elicitationId: 'elicit-1' },
  ]) {
    const method = 'mcpServer/elicitation/request';
    const id = `elicitation:${params.message}`;
    wire.send({ id, method, params: { threadId, turnId, serverName: 'fixture-mcp', _meta: null, ...params } }, 'ServerRequest');
    assert.deepEqual(wire.response(id, method).result, { action: 'decline', content: null, _meta: null });
  }
  const now = Math.floor(Date.now() / 1000);
  wire.send({ id: 'clock', method: 'currentTime/read', params: { threadId } }, 'ServerRequest');
  const time = wire.response('clock', 'currentTime/read').result.currentTimeAt;
  assert.ok(time >= now && time <= Math.floor(Date.now() / 1000));
  const unsupported = {
    'item/tool/call': { threadId, turnId, callId: 'call', tool: 'not-registered', arguments: {} },
    'account/chatgptAuthTokens/refresh': { reason: 'unauthorized' },
    'attestation/generate': {},
    applyPatchApproval: { callId: 'patch', conversationId: threadId, fileChanges: {} },
    execCommandApproval: { callId: 'exec', conversationId: threadId, command: ['echo'], cwd: '/tmp', parsedCmd: [] },
  };
  for (const [method, params] of Object.entries(unsupported)) {
    wire.send({ id: method, method, params }, 'ServerRequest');
    assert.equal(wire.response(method, method).error.code, -32601);
  }
  wire.send({ id: 'future', method: 'future/request', params: { threadId } });
  assert.equal(wire.response('future', 'future/request').error.code, -32601);
});

contract('request identity', async (t) => {
  const wire = await wireClient(t);
  const method = 'item/commandExecution/requestApproval';
  wire.send({ id: 'no-handler', method, params: approvalParams }, 'ServerRequest');
  assert.equal(wire.response('no-handler', method).error.code, -32601);
  const callbacks = new Map<string | number, (result: unknown) => void>();
  wire.client.onServerRequest((_method, _params, respond, context) => callbacks.set(context.requestId, respond));
  for (const id of [42, '42']) wire.send({ id, method, params: approvalParams }, 'ServerRequest');
  const resolved = (requestId: string | number, target = threadId) => wire.send({ method: 'serverRequest/resolved', params: { threadId: target, requestId } }, 'ServerNotification');
  resolved(42, 'other-thread');
  callbacks.get(42)!({ decision: 'accept' });
  callbacks.get(42)!({ decision: 'decline' });
  assert.deepEqual(wire.response(42, method).result, { decision: 'accept' });
  resolved('42');
  resolved('42');
  callbacks.get('42')!({ decision: 'accept' });
  assert.equal(wire.responses('42').length, 0, 'a cleared request cannot be approved late');
  wire.client.onServerRequest(() => { throw new Error('private payload must not leak'); });
  wire.send({ id: 'throws', method, params: approvalParams }, 'ServerRequest');
  const error = wire.response('throws', method).error;
  assert.equal(error.code, -32603);
  assert.doesNotMatch(error.message, /private payload/);
});

contract('resolved session controls', async (t) => {
  const wire = await activeWire(t, true);
  let grants = 0;
  wire.session.onAlwaysAllow = () => { grants++; };
  const method = 'item/commandExecution/requestApproval';
  for (const order of ['revoke-first', 'answer-first']) {
    const id = `revoke:${order}`;
    wire.send({ id, method, params: { ...approvalParams, command: 'echo fixture' } }, 'ServerRequest');
    await tick();
    const [localId] = wire.session.pendingPermissions.keys();
    assert.equal(typeof localId, 'number');
    if (order === 'answer-first') wire.session.respondToPermission(localId, 'allow_always');
    wire.send({ method: 'serverRequest/resolved', params: { threadId, requestId: id } }, 'ServerNotification');
    wire.session.respondToPermission(localId, 'allow_always');
    await tick();
    assert.equal(wire.session.pendingPermissions.size, 0);
    assert.equal(wire.responses(id).length, 0);
    assert.equal(grants, 0, 'revoked approvals must not persist local grants');
  }
  wire.send({ id: 'revoked-input', method: 'item/tool/requestUserInput', params: inputParams }, 'ServerRequest');
  await tick();
  const prompt = wire.events.filter((event) => event.kind === 'user_input_request').at(-1)!;
  wire.send({ method: 'serverRequest/resolved', params: { threadId, requestId: 'revoked-input' } }, 'ServerNotification');
  await tick();
  wire.session.respondToUserInput(prompt.requestId, [{ id: 'q-1', question: 'Same question?', answer: 'late' }]);
  assert.equal(wire.responses('revoked-input').length, 0);
  assert.ok(wire.events.some((event) => event.kind === 'user_input_resolved' && event.requestId === prompt.requestId && event.answers.length === 0));
});

function itemNotification(method: string, item: object) {
  return { method, params: { threadId, turnId, item, startedAtMs: 0, completedAtMs: 1 } };
}
contract('compact lifecycle', async (t) => {
  const wire = await activeWire(t);
  const item = { type: 'contextCompaction', id: 'compact-1' };
  for (const method of ['item/started', 'item/completed']) wire.send(itemNotification(method, item), 'ServerNotification');
  await tick();
  assert.deepEqual(wire.events.filter((e) => e.kind.startsWith('compaction_')).map((e) => e.kind), ['compaction_start', 'compaction_end']);
  wire.send({ method: 'thread/compacted', params: { threadId, turnId } }, 'ServerNotification');
  await tick();
  assert.equal(wire.events.filter((e) => e.kind === 'compaction_end').length, 2);
  const legacy: NormalizedEvent[] = [];
  const translator = createCodexTranslator((e) => legacy.push(e));
  for (const type of ['compaction', 'context_compaction']) {
    const message = itemNotification('item/started', { id: 'legacy', type });
    assert.equal(validator('ServerNotification')(message), false, 'legacy aliases are not official-schema fixtures');
    translator.feed(message.method, message.params);
  }
  assert.equal(legacy.length, 2, 'legacy spelling support remains separate');
});

contract('terminal lifecycle', async (t) => {
  for (const status of ['completed', 'interrupted', 'failed']) await t.test(status, async (t) => {
    const wire = await activeWire(t);
    wire.send(turnNotification('inProgress'), 'ServerNotification');
    for (const type of ['commandExecution', 'fileChange']) {
      for (const endStatus of ['completed', 'failed', 'declined']) {
        const item = type === 'commandExecution'
          ? { type, id: `${type}:${endStatus}`, command: 'echo fixture', cwd: '/tmp', source: 'agent', commandActions: [] }
          : { type, id: `${type}:${endStatus}`, changes: [] };
        wire.send(itemNotification('item/started', { ...item, status: 'inProgress' }), 'ServerNotification');
        wire.send(itemNotification('item/completed', { ...item, status: endStatus }), 'ServerNotification');
      }
    }
    wire.send(turnNotification(status), 'ServerNotification');
    await wire.drain;
    let durable = createDurableTurn({ turnId, nodeId: 'contract-node', assistantId: 'contract-assistant', workspaceId: 'contract-workspace', displayUserText: 'fixture', startedAt: 0 });
    for (const event of wire.events) {
      if (event.kind === 'runtime_error') {
        assert.throws(() => toChatStreamEvent(event), /Fixture failure/);
        continue; // ChatHub catches this; the following turn_end preserves error status.
      }
      durable = applyTurnEvent(durable, toChatStreamEvent(event));
    }
    for (const type of ['commandExecution', 'fileChange']) for (const endStatus of ['completed', 'failed', 'declined']) {
      assert.equal(durable.assistantMessage.toolCalls.find((tool) => tool.id === `${type}:${endStatus}`)?.status, endStatus);
    }
    assert.equal(durable.status, status === 'interrupted' ? 'cancelled' : status === 'failed' ? 'error' : 'completed');
  });
});

contract('translator notifications', () => {
  const events: NormalizedEvent[] = [];
  const translator = createCodexTranslator((event) => events.push(event));
  const feed = (method: string, params: object) => {
    const message = { method, params: { threadId, turnId, itemId: 'item', ...params } };
    assertSchema('ServerNotification', message);
    translator.feed(method, message.params);
  };
  feed('item/agentMessage/delta', { delta: 'Answer' });
  feed('item/reasoning/textDelta', { delta: 'Reason', contentIndex: 0 });
  feed('item/reasoning/summaryTextDelta', { delta: 'Summary', summaryIndex: 0 });
  feed('item/commandExecution/outputDelta', { delta: 'out' });
  feed('item/fileChange/outputDelta', { delta: 'patch' });
  feed('item/mcpToolCall/progress', { message: 'Progress' });
  const usage = { totalTokens: 60_000, inputTokens: 59_000, cachedInputTokens: 1_000, outputTokens: 1_000, reasoningOutputTokens: 500 };
  feed('thread/tokenUsage/updated', { tokenUsage: { total: { ...usage, totalTokens: 999_999 }, last: usage, modelContextWindow: 120_000 } });
  feed('mcpServer/startupStatus/updated', { name: 'fixture-mcp', status: 'failed', error: 'Fixture MCP failure' });
  feed('error', { error: { message: 'Retryable' }, willRetry: true });
  assert.deepEqual(events.map((event) => event.kind), ['chunk', 'thought', 'thought', 'tool_call_update', 'tool_call_update', 'tool_call_update', 'context_usage', 'mcp_server_error']);
  const usageEvent = events.find((event) => event.kind === 'context_usage')!;
  assert.equal(usageEvent.contextUsagePercentage, (60_000 - 12_000) / (120_000 - 12_000) * 100);
});

contract('negative controls', () => {
  assert.equal(validator('ServerNotification')(itemNotification('item/started', { id: 'compact', type: 'contextCompacton' })), false);
  assert.equal(validator('ToolRequestUserInputResponse')({ answers: { 'q-1': 'Yes' } }), false);
  assert.equal(validator('ToolRequestUserInputResponse')({ answers: null }), false);
  assert.equal(validator('PermissionsRequestApprovalResponse')({ decision: 'accept' }), false);
  assert.equal(validator('CommandExecutionStatus')('success'), false);
  // This passes structural validation, demonstrating why wire input also asserts IDs.
  assertSchema('ToolRequestUserInputResponse', { answers: { 'wrong-question-id': { answers: ['Yes'] } } });
});
