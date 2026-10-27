import test from 'node:test';
import assert from 'node:assert/strict';
import {
  directNativePageTool,
  boundEvidence,
  findCompletedNativeToolCall,
  isOneTimePagePermissionAllowed,
  wrappedNativePageTool,
} from './pages-real-runtime-helpers.mjs';

test('recognizes canonical direct native Pages tool titles', () => {
  for (const title of ['read_page', '@michi/read_page', 'Running: @michi/read_page', 'michi/read_page']) {
    assert.equal(directNativePageTool(title), 'read_page', title);
  }
  assert.equal(directNativePageTool('shell'), null);
  assert.equal(directNativePageTool('unrelated/read_page_suffix'), null);
});

test('bounds large multi-turn evidence while retaining verdict, read call, stage readback and provenance', () => {
  const exactRead = { title: 'michi_call_tool', status: 'completed', toolCallId: 'native-read-7',
    turnId: 'turn-create', nativeTool: 'read_page', inputJson: JSON.stringify({
      tool: 'read_page', arguments: { pageId: 'page-created-1' },
    }) };
  const turn = (turnId, toolCalls) => ({ requestedTurnId: `request-${turnId}`, turnId,
    assistantId: `assistant-${turnId}`, terminal: 'completed', toolCalls });
  const huge = 'large-output-'.repeat(7000);
  const record = {
    result: 'core_api_and_ordinary_chat_checks_passed', runtimeId: 'crew',
    checks: { pageCreatedByTool: true, pageReadBackByTool: true, databaseEditAttributed: true },
    groups: { core: { passed: true, checks: { pageCreatedByTool: true, pageReadBackByTool: true } } },
    pageReadBackToolCall: exactRead,
    toolCreatedPage: { id: 'page-created-1', source: { nodeId: 'node-1', turnId: 'turn-create', assistantId: 'assistant-create' } },
    riskLifecycle: { sourceMessagePresent: true, source: { nodeId: 'node-1', turnId: 'turn-proposal' } },
    readback: { pageRevision: 9, risks: 'Owner-reviewed' },
    stageReadback: { pageAfterWrite: { revision: 7, progress: 'Disposable runtime smoke complete' },
      databaseAfterWrite: { revision: 4, row: { id: 'row-1', values: { status: 'doing' } } } },
    turns: [turn('turn-create', [{ ...exactRead, status: 'in_progress' }, exactRead]),
      ...Array.from({ length: 4 }, (_, index) => turn(`turn-${index}`, Array.from({ length: 30 }, (_, callIndex) => ({
        title: 'michi_call_tool', status: 'completed', toolCallId: `call-${index}-${callIndex}`,
        turnId: `turn-${index}`, nativeTool: 'edit_page', inputJson: huge,
      }))))],
    stageTurns: { pageWrite: turn('turn-page-write', [{ ...exactRead, nativeTool: 'edit_page', inputJson: huge }]) },
    turnTrace: Array.from({ length: 10 }, () => ({ toolCalls: Array.from({ length: 80 }, () => ({ output: huge })) })),
    events: Array.from({ length: 80 }, (_, index) => ({ event: 'tool_call_update', output: huge, index })),
  };
  const bounded = boundEvidence(record);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < 90_000);
  assert.equal(bounded.result, record.result);
  assert.equal(bounded.groups.core.passed, true);
  assert.deepEqual(bounded.checks, record.checks);
  assert.equal(bounded.pageReadBackToolCall.toolCallId, 'native-read-7');
  assert.equal(bounded.turns[0].toolCalls.find((call) => call.toolCallId === 'native-read-7').status, 'completed');
  assert.equal(bounded.stageReadback.databaseAfterWrite.row.values.status, 'doing');
  assert.equal(bounded.toolCreatedPage.source.turnId, 'turn-create');
  assert.equal(bounded.riskLifecycle.source.turnId, 'turn-proposal');
  assert.equal('turnTrace' in bounded, false);
  assert.ok(bounded.events.length < record.events.length);
});

test('extracts the exact native tool from the Crew wrapper envelope', () => {
  assert.equal(wrappedNativePageTool({ inputJson: JSON.stringify({
    tool: 'read_page', arguments: { pageId: 'page-1' },
  }) }), 'read_page');
  assert.equal(wrappedNativePageTool({ inputJson: {
    tool: '@michi/create_page', arguments: { title: 'child' },
  } }), 'create_page');
  assert.equal(wrappedNativePageTool({ inputJson: { arguments: { name: 'read_page' } } }), null);
  assert.equal(wrappedNativePageTool({ inputJson: { tool: 'michi_docs', arguments: {} } }), null);
});

test('rejects explicit non-Page and nested false-positive wrapper tools', () => {
  assert.equal(wrappedNativePageTool({ detail: JSON.stringify({ tool: 'michi_docs', arguments: {} }) }), null);
  assert.equal(wrappedNativePageTool({ detail: JSON.stringify({ arguments: { tool: 'read_page' } }) }), null);
});

test('page read evidence requires the exact completed call ID', () => {
  const calls = [
    { nativeTool: 'read_page', toolCallId: 'call-unidentified', status: 'completed' },
    { nativeTool: 'read_page', toolCallId: 'call-different', turnId: 'turn-2', status: 'completed' },
    { nativeTool: 'read_page', toolCallId: 'call-running', status: 'in_progress' },
    { nativeTool: 'read_page', toolCallId: 'call-completed', turnId: 'turn-1', status: 'completed' },
  ];
  assert.equal(findCompletedNativeToolCall(calls, 'read_page', 'turn-1'), calls[3]);
  assert.equal(findCompletedNativeToolCall(calls.slice(0, 2), 'read_page', 'turn-1'), null);
  assert.equal(findCompletedNativeToolCall(calls, 'read_page', 'turn-2'), calls[1]);
  assert.equal(findCompletedNativeToolCall(calls, 'read_page', 'turn-missing'), null);
  assert.equal(findCompletedNativeToolCall(calls, 'read_page', undefined), null);
});

test('auto-approves only the exact one-time tool allowlist', () => {
  assert.equal(isOneTimePagePermissionAllowed('read_page'), true);
  assert.equal(isOneTimePagePermissionAllowed('michi_list_tools'), true);
  assert.equal(isOneTimePagePermissionAllowed('michi_call_tool', 'read_page'), true);
  assert.equal(isOneTimePagePermissionAllowed('michi_call_tool', 'michi_docs'), false);
  assert.equal(isOneTimePagePermissionAllowed('michi_call_tool'), false);
  assert.equal(isOneTimePagePermissionAllowed('shell'), false);
});
