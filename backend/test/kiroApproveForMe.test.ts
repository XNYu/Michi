import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AcpAgentSession } from 'michi-runtime/internal/adapters/kiro/AcpAgentSession';
import { AcpAgentRuntime as KiroRuntimeClass, type AcpAgentRuntime } from 'michi-runtime/internal/adapters/kiro/AcpAgentRuntime';
import type { ChatPermissionMode } from 'michi-shared';
import { michiTestHost } from './helpers/michiTestHost';
import { chatOwner, runOwner } from './helpers/owners';

/**
 * A runtime stand-in whose chat permission choice and native session presets
 * the test sets. The client records reopens and plays one turn.
 */
function harness(choice: { mode: ChatPermissionMode; approveForMe: boolean }, opened: string[], options: { reopen?: (presets: readonly string[]) => Promise<void>; recovery?: boolean; workflow?: boolean; approveForMe?: boolean } = {}) {
  const host = michiTestHost();
  let presets: readonly string[] = opened;
  const reopens: Array<readonly string[]> = [];
  const prompts: string[] = [];
  let closed = false;
  host.permissions.mode = () => choice.mode;
  host.permissions.approveForMe = () => choice.approveForMe;
  const client = {
    policyPresets: () => presets,
    // A failed reopen with `recovery` left the session closed (quarantined).
    needsSessionRecovery: () => closed,
    hasOpenWorkflowRuns: () => options.workflow === true,
    reopenWithPolicyPresets: async (_sid: string, next: readonly string[]) => {
      reopens.push(next);
      if (options.reopen) {
        try { await options.reopen(next); } catch (error) { closed = options.recovery === true; throw error; }
      }
      presets = next;
    },
    async *prompt(_sid: string, text: string) {
      prompts.push(text);
      yield { sessionUpdate: 'turn_end', stopReason: 'end_turn' };
    },
  };
  const runtime = {
    host,
    engine: 'v3',
    approveForMe: options.approveForMe ?? true,
    policyPresetsFor: () => choice.mode === 'ask' && choice.approveForMe ? ['approve-for-me'] : [],
    ensureClient: async () => client,
    getClient: () => client,
    getCurrentMode: () => null,
    getCurrentModel: () => null,
  } as unknown as AcpAgentRuntime;
  const session = new AcpAgentSession('node-1', 'sid-1', runtime, '/tmp', { owner: chatOwner('node-1') });
  return { session, reopens, prompts, presets: () => presets };
}

async function send(session: AcpAgentSession): Promise<void> {
  for await (const _event of session.send('hi')) { /* drain */ }
}

describe('AcpAgentSession Approve for me', () => {
  it('turns the preset on before the next prompt and leaves a matching session alone', async () => {
    const h = harness({ mode: 'ask', approveForMe: true }, []);
    await send(h.session);
    assert.deepEqual(h.reopens, [['approve-for-me']]);
    assert.equal(h.prompts.length, 1);
    await send(h.session);
    assert.equal(h.reopens.length, 1, 'already seeded');
  });

  it('turns the preset off when the chat goes back to Ask', async () => {
    const h = harness({ mode: 'ask', approveForMe: false }, ['approve-for-me']);
    await send(h.session);
    assert.deepEqual(h.reopens, [[]]);
    assert.equal(h.prompts.length, 1);
  });

  it('Trust and YOLO leave the session as it is; runtimes without it do nothing', async () => {
    for (const mode of ['trust', 'yolo'] as const) {
      const h = harness({ mode, approveForMe: false }, ['approve-for-me']);
      await send(h.session);
      assert.deepEqual(h.reopens, [], mode);
    }
    const v2 = harness({ mode: 'ask', approveForMe: true }, [], { approveForMe: false });
    await send(v2.session);
    assert.deepEqual(v2.reopens, []);
  });

  it('does not send the message when the preset cannot be removed', async () => {
    const h = harness({ mode: 'ask', approveForMe: false }, ['approve-for-me'], { workflow: true });
    await assert.rejects(send(h.session), /could not turn off Approve for me/);
    assert.equal(h.prompts.length, 0, 'the classifier must not approve work in plain Ask');
  });

  it('asks as in Ask when turning it on fails with the session intact', async () => {
    const h = harness({ mode: 'ask', approveForMe: true }, [], { reopen: async () => { throw new Error('Kiro did not advertise session/close'); } });
    await send(h.session);
    assert.equal(h.prompts.length, 1);
    assert.deepEqual(h.presets(), []);
  });

  it('fails the turn when a reopen left the session closed', async () => {
    const h = harness({ mode: 'ask', approveForMe: true }, [], { recovery: true, reopen: async () => { throw new Error('load failed'); } });
    await assert.rejects(send(h.session), /could not turn on Approve for me/);
    assert.equal(h.prompts.length, 0);
  });
});

describe('AcpAgentRuntime Approve for me eligibility', () => {
  const bridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null };
  function runtime(options: Record<string, unknown>, choice: { mode: ChatPermissionMode; approveForMe: boolean }) {
    const host = michiTestHost();
    host.permissions.mode = () => choice.mode;
    host.permissions.approveForMe = () => choice.approveForMe;
    return new KiroRuntimeClass({ bridge, host, defaultCwd: '/tmp', ...options } as any);
  }

  it('only Kiro V3 interactive chats in Ask with the flag get the preset', async (t) => {
    const on = { mode: 'ask' as const, approveForMe: true };
    const v3 = runtime({ engine: 'v3' }, on);
    const v2 = runtime({ engine: 'v2' }, on);
    const custom = runtime({ engine: 'v3', launch: { bin: '/bin/false', args: () => [] } }, on);
    t.after(() => Promise.all([v3, v2, custom].map((r) => r.shutdown())));
    assert.equal(v3.approveForMe, true);
    assert.equal(v2.approveForMe, false);
    assert.equal(custom.approveForMe, false, 'a launch override such as Crew is not kiro-cli');
    assert.deepEqual(v3.policyPresetsFor(chatOwner('n'), null), ['approve-for-me']);
    assert.deepEqual(v3.policyPresetsFor(runOwner('run-1', 'attempt-1'), null), [], 'Agent Runs keep Kiro defaults');
    assert.deepEqual(v3.policyPresetsFor(chatOwner('n'), null, { assistant: true }), [], 'tool-profile sessions keep Kiro defaults');
    assert.deepEqual(v3.policyPresetsFor(undefined, null), []);
    assert.deepEqual(v2.policyPresetsFor(chatOwner('n'), null), []);
    const trust = runtime({ engine: 'v3' }, { mode: 'trust', approveForMe: true });
    const ask = runtime({ engine: 'v3' }, { mode: 'ask', approveForMe: false });
    t.after(() => Promise.all([trust, ask].map((r) => r.shutdown())));
    assert.deepEqual(trust.policyPresetsFor(chatOwner('n'), null), []);
    assert.deepEqual(ask.policyPresetsFor(chatOwner('n'), null), []);
  });
});
