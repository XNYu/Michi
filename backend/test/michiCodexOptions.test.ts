/**
 * Michi's wording for the Codex adapter (michiCodexOptions.ts): each member
 * reads hostText/codex.ts at every call, with the arguments the adapter
 * passes, and the factory's options carry it.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { michiCodexHostText } from '../src/agents/michiCodexOptions';
import { codexAdapterOptions } from '../src/agents/runtimeFactories';
import * as codexText from '../src/agents/hostText/codex';
import { michiTestHost } from './helpers/michiTestHost';

/** Stubs `target[name]`, calls `invoke`, and checks the stub got exactly `args` and its value came back. */
function expectDelegation(t: TestContext, target: object, name: string, invoke: () => unknown, args: unknown[]): void {
  const result = Symbol(name);
  const stub = t.mock.method(target as Record<string, (...a: any[]) => any>, name, () => result);
  assert.equal(invoke(), result);
  assert.equal(stub.mock.callCount(), 1);
  assert.deepEqual(stub.mock.calls[0].arguments, args);
}

/** Temporarily replaces an exported constant; the module object holds it as a plain property. */
function withExport<T>(target: object, name: string, value: unknown, run: () => T): T {
  const holder = target as Record<string, unknown>;
  const original = holder[name];
  holder[name] = value;
  try { return run(); } finally { holder[name] = original; }
}

test('turnMetadataInstruction → hostText/codex buildCodexTurnMetadataInstruction', (t) => {
  const text = michiCodexHostText();
  expectDelegation(t, codexText, 'buildCodexTurnMetadataInstruction',
    () => text.turnMetadataInstruction!('hook-tool', false), ['hook-tool', false]);
  t.mock.restoreAll();
  expectDelegation(t, codexText, 'buildCodexTurnMetadataInstruction',
    () => text.turnMetadataInstruction!('sentinel'), ['sentinel']);
});

test('followUpsHookPocInstruction → hostText/codex buildCodexFollowUpsHookPocInstruction', (t) => {
  expectDelegation(t, codexText, 'buildCodexFollowUpsHookPocInstruction',
    () => michiCodexHostText().followUpsHookPocInstruction!('sentinel', true), ['sentinel', true]);
});

test('the turn-metadata protocol text matches the direct calls', () => {
  const text = michiCodexHostText();
  for (const mode of ['sentinel', 'hook-tool'] as const) {
    for (const enableFollowUps of [true, false]) {
      assert.equal(text.turnMetadataInstruction!(mode, enableFollowUps), codexText.buildCodexTurnMetadataInstruction(mode, enableFollowUps));
      assert.equal(text.followUpsHookPocInstruction!(mode, enableFollowUps), codexText.buildCodexFollowUpsHookPocInstruction(mode, enableFollowUps));
    }
  }
});

test('titleInstructions → hostText/codex TITLE_INSTRUCTIONS, read at each call', () => {
  const text = michiCodexHostText();
  assert.equal(text.titleInstructions!(), codexText.TITLE_INSTRUCTIONS);
  assert.match(text.titleInstructions!(), /^Create a concise title for the user's request/);
  withExport(codexText, 'TITLE_INSTRUCTIONS', 'swapped', () => {
    assert.equal(text.titleInstructions!(), 'swapped');
  });
});

test("the factory's Codex options carry Michi's wording", () => {
  const { hostText } = codexAdapterOptions({ host: michiTestHost() }, {});
  assert.deepEqual(Object.keys(hostText ?? {}).sort(), ['followUpsHookPocInstruction', 'titleInstructions', 'turnMetadataInstruction']);
  assert.equal(hostText!.titleInstructions!(), codexText.TITLE_INSTRUCTIONS);
  assert.equal(hostText!.turnMetadataInstruction!('sentinel', true), codexText.buildCodexTurnMetadataInstruction('sentinel', true));
});
