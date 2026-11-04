import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { buildPiTools } from '../src/agents/pi/piTools';
import { mapAgentEvent, type MapperContext } from '../src/agents/pi/eventMapper';
import { buildPiTodoTool, PiTodoList, PI_TODO_TOOL_NAME } from '../src/agents/pi/piTodoTool';
import { resolveChatPolicy } from '../src/agents/permissionPolicy';
import { restrictedChatProfile } from './helpers/restrictedChatProfile';
import { chatOwner } from './helpers/owners';

// Minimal typebox stand-in: every builder returns a plain object.
const Type: any = new Proxy({}, { get: () => (..._a: any[]) => ({}) });

function todoTool(seed?: ConstructorParameters<typeof PiTodoList>[0]) {
  const list = new PiTodoList(seed);
  return { list, tool: buildPiTodoTool(list, Type) };
}

function mapperContext(): MapperContext {
  return { cumulative: { inputTokens: 0, outputTokens: 0, totalCost: 0 }, runStartMs: Date.now() };
}

/** Run one call and map its end event the way PiSession does. */
async function call(tool: any, args: Record<string, unknown>) {
  const result = await tool.execute('call', { __tool_use_purpose: 'Track the work', ...args });
  const events = [...mapAgentEvent({ type: 'tool_execution_end', toolCallId: 'call', toolName: PI_TODO_TOOL_NAME,
    result, isError: result.isError === true }, mapperContext())];
  return { result, events, plan: events.find((event) => event.kind === 'plan') as { entries: unknown[] } | undefined };
}

describe('Pi todo tool', () => {
  test('every change reports the whole list as one plan event in ACP plan entry shape', async () => {
    const { tool } = todoTool();
    assert.equal(tool.name, 'todo');
    assert.equal(tool.executionMode, 'sequential');

    const added = await call(tool, { action: 'add', items: [{ content: '  Write tests ' }, { content: 'Implement', status: 'in_progress' }] });
    assert.deepEqual(added.plan?.entries, [
      { content: 'Write tests', priority: 'medium', status: 'pending' },
      { content: 'Implement', priority: 'medium', status: 'in_progress' },
    ]);
    assert.match(added.result.content[0].text, /#1 \[pending\] Write tests\n#2 \[in_progress\] Implement/);
    // The plan comes before the chip update, like the other side-effect events.
    assert.deepEqual(added.events.map((event) => event.kind), ['plan', 'tool_call_update']);

    await call(tool, { action: 'update', id: 2, status: 'completed' });
    const updated = await call(tool, { action: 'update', id: 1, status: 'in_progress', content: 'Write more tests' });
    assert.deepEqual(updated.plan?.entries, [
      { content: 'Write more tests', priority: 'medium', status: 'in_progress' },
      { content: 'Implement', priority: 'medium', status: 'completed' },
    ]);
    assert.match(updated.result.content[0].text, /1 of 2 completed/);

    const removed = await call(tool, { action: 'remove', id: 1 });
    assert.deepEqual(removed.plan?.entries, [{ content: 'Implement', priority: 'medium', status: 'completed' }]);
    // Ids stay stable after a removal.
    assert.match(removed.result.content[0].text, /#2 \[completed\] Implement/);

    const replaced = await call(tool, { action: 'replace', items: [{ content: 'Fresh start' }] });
    assert.deepEqual(replaced.plan?.entries, [{ content: 'Fresh start', priority: 'medium', status: 'pending' }]);
    assert.match(replaced.result.content[0].text, /#1 \[pending\] Fresh start/);

    const cleared = await call(tool, { action: 'replace', items: [] });
    assert.deepEqual(cleared.plan?.entries, [], 'a cleared list is reported, not skipped');
    assert.match(cleared.result.content[0].text, /empty/);
  });

  test('list reads the list without a plan event', async () => {
    const { tool } = todoTool([{ content: 'Seeded', priority: 'high', status: 'pending' }]);
    const listed = await call(tool, { action: 'list' });
    assert.equal(listed.plan, undefined);
    assert.equal(listed.result.isError, undefined);
    assert.match(listed.result.content[0].text, /#1 \[pending\] Seeded/);
  });

  test('invalid input is a tool error that leaves the list unchanged', async () => {
    const { list, tool } = todoTool();
    await call(tool, { action: 'add', items: [{ content: 'One', status: 'in_progress' }, { content: 'Two' }] });
    const before = list.plan();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ action: 'rename' }, /action must be one of list, add, update, remove, replace/],
      [{}, /action must be one of/],
      [{ action: 'add' }, /add needs items/],
      [{ action: 'add', items: [] }, /at least one item/],
      [{ action: 'add', items: [{ content: '   ' }] }, /items\[0\]: content must be a non-empty string/],
      [{ action: 'add', items: ['text'] }, /items\[0\] must be an object/],
      [{ action: 'add', items: [{ content: 'x'.repeat(501) }] }, /longer than 500 characters/],
      [{ action: 'add', items: [{ content: 'Three', status: 'done' }] }, /status must be one of pending, in_progress, completed/],
      [{ action: 'add', items: [{ content: 'Three', status: 'in_progress' }] }, /Only one item can be in_progress at a time \(would be #1, #3\)/],
      [{ action: 'add', items: Array.from({ length: 49 }, (_, index) => ({ content: `Item ${index}` })) }, /at most 50 items/],
      [{ action: 'update', id: 2, status: 'in_progress' }, /Only one item can be in_progress/],
      [{ action: 'update', id: 2 }, /update needs content, status or both/],
      [{ action: 'update', status: 'completed' }, /update needs id/],
      [{ action: 'update', id: 1.5, status: 'completed' }, /update needs id/],
      [{ action: 'update', id: 9, status: 'completed' }, /There is no item #9\. Current items: #1, #2\./],
      [{ action: 'remove', id: 9 }, /There is no item #9/],
      [{ action: 'replace' }, /replace needs items/],
      [{ action: 'replace', items: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'in_progress' }] }, /Only one item can be in_progress/],
    ];
    for (const [args, message] of cases) {
      const { result, events, plan } = await call(tool, args);
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match(result.content[0].text, message, JSON.stringify(args));
      assert.match(result.content[0].text, /The todo list was not changed\./);
      assert.equal(plan, undefined, 'a failed call emits no plan');
      const update = events.find((event) => event.kind === 'tool_call_update') as { status: string; detail?: string };
      assert.equal(update.status, 'failed');
      assert.match(update.detail ?? '', message);
      assert.deepEqual(list.plan(), before, JSON.stringify(args));
    }
  });

  test('a seeded plan is copied, kept within bounds and keeps its priorities', async () => {
    const seed = [
      { content: 'Inherited A', priority: 'high' as const, status: 'in_progress' as const },
      { content: '   ', priority: 'medium' as const, status: 'pending' as const },
      { content: 'Inherited B', priority: 'low' as const, status: 'in_progress' as const },
      { content: 'y'.repeat(600), priority: 'medium' as const, status: 'completed' as const },
    ];
    const { list, tool } = todoTool(seed);
    assert.deepEqual(list.plan().map((entry) => [entry.content.length, entry.priority, entry.status]), [
      [11, 'high', 'in_progress'],
      [11, 'low', 'pending'],
      [500, 'medium', 'completed'],
    ]);
    const updated = await call(tool, { action: 'update', id: 1, status: 'completed' });
    assert.deepEqual(updated.plan?.entries[0], { content: 'Inherited A', priority: 'high', status: 'completed' });
    assert.equal(seed[0].status, 'in_progress', 'the seed array is never mutated');
    const many = new PiTodoList(Array.from({ length: 80 }, (_, index) => ({ content: `Item ${index}`, priority: 'medium' as const, status: 'pending' as const })));
    assert.equal(many.plan().length, 50);
  });

  test('the todo tool runs without an Ask-mode prompt in a chat', () => {
    assert.equal(resolveChatPolicy(chatOwner('node-a'), null, PI_TODO_TOOL_NAME, false, 'ask'), 'allow');
    assert.equal(resolveChatPolicy(chatOwner('node-a'), null, 'bash', false, 'ask'), 'ask');
  });
});

describe('buildPiTools todo registration', () => {
  afterEach(() => __resetRuntimeDeps());
  const store = { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null };
  const agentConfig = { getAgentConfig: () => ({ runtime: 'pi', provider: 'x', modelByRuntime: {}, reasoningByRuntime: {} }), resolveModel: () => '', resolveReasoning: () => undefined };
  function opts(extra: Record<string, unknown> = {}) {
    return { bridge: {} as any, cwd: '/tmp', parentChatId: 'node-a', workspaceId: 'ws', enableFollowUps: true,
      imageQuota: { usedBytes: 0, limitBytes: 1 } as any, seenPaths: new Set<string>(), Type,
      owner: chatOwner('node-a'), ...extra } as any;
  }

  test('an ordinary chat gets the todo tool for its session list; other catalogs do not', () => {
    configureRuntimeDeps({ historyStore: store as any, agentConfig, dataDir: '/tmp/agent-runtime-test' });
    const list = new PiTodoList();
    const names = (extra: Record<string, unknown>) => buildPiTools(opts(extra)).map((tool: any) => tool.name);
    assert.ok(names({ todoList: list }).includes('todo'));
    assert.ok(!names({}).includes('todo'), 'no session list, no tool');
    assert.ok(!names({ todoList: list, toolProfile: restrictedChatProfile() }).includes('todo'), 'restricted');
    assert.ok(!names({ todoList: list, toolProfile: { assistant: true } }).includes('todo'), 'assistant');
  });
});
