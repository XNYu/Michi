/**
 * Codex collaboration agents, replayed from a real (sanitized) app-server wire:
 * spawnAgent → child thread fails on provider capacity → wait reports the
 * errored state. The child never emits thread/started on this wire, so the
 * roster must come from the collab items themselves.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { applySubagentActivity, mergeSubagentRoster, SUBAGENT_SESSION_ENDED_ERROR, type SubagentInfo } from 'michi-shared';
import { CodexSession } from 'michi-runtime/internal/adapters/codex/CodexSession';
import { BackgroundSubagentRegistry, type EndedBackgroundSubagents } from '../src/services/backgroundSubagentRegistry';
import { subagentSink } from './helpers/hostSinks';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { codexCollabRoster } from 'michi-runtime/internal/adapters/codex/codexCollab';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { michiTestHost } from './helpers/michiTestHost';
import { michiCodexHostText } from '../src/agents/michiCodexOptions';

const WIRE = path.join(__dirname, 'fixtures', 'subagents', 'codex-collab-wire.jsonl');

/**
 * Sessions here never use the process-wide background registry: with no
 * workspace it would look the node up in the real data directory's SQLite.
 */
function testRegistry(): BackgroundSubagentRegistry {
  return new BackgroundSubagentRegistry({ resolveWorkspace: () => 'ws-test' });
}

function replay(): NormalizedEvent[] {
  const [head, ...frames] = fs.readFileSync(WIRE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const handlers = new Map<string, (method: string, params: Record<string, unknown>) => void>();
  let global: ((method: string, params: Record<string, unknown>) => void) | undefined;
  const client = {
    onNotification: (id: string, handler: (method: string, params: Record<string, unknown>) => void) => {
      handlers.set(id, handler);
      return () => handlers.delete(id);
    },
    onGlobalNotification: (handler: typeof global) => { global = handler; return () => {}; },
    onExit: () => () => {},
    request: async () => ({}),
  };
  const session = new CodexSession({
    nodeId: 'codex-replay', threadId: head.parentThreadId, cwd: '/tmp', workspaceId: null,
    client, mcpRegistry: {}, bridge: {}, host: michiTestHost(), hostText: michiCodexHostText(), enableFollowUps: false,
    backgroundSubagents: subagentSink(testRegistry()),
  } as never) as unknown as Record<string, any>;
  const events: NormalizedEvent[] = [];
  session.queue.dispose();
  session.queue = { push: (ev: NormalizedEvent) => events.push(ev), dispose: () => {} };
  session.nativeSettled = false;
  session.wireNotifications();
  session.markTranslatorTurnStart();
  for (const frame of frames) {
    global?.(frame.method, frame.params);
    handlers.get(frame.params.threadId)?.(frame.method, frame.params);
  }
  return events;
}

function fold(events: NormalizedEvent[]): SubagentInfo[] {
  let roster: SubagentInfo[] | undefined;
  for (const ev of events) {
    if (ev.kind === 'subagent_list_update') roster = mergeSubagentRoster(roster, ev.subagents);
    if (ev.kind === 'subagent_tool_activity') {
      const { kind: _kind, ...payload } = ev;
      roster = applySubagentActivity(roster, payload);
    }
  }
  return roster ?? [];
}

describe('Codex collaboration subagents', () => {
  it('renders spawnAgent as a delegation chip and builds the roster from receiverThreadIds', () => {
    const events = replay();
    const chips = events.filter((e) => e.kind === 'tool_call') as Array<{ toolCallId: string; title: string; kindType?: string }>;
    assert.deepEqual(chips.map((c) => [c.title, c.kindType]), [['Spawn agent', 'subagent'], ['Wait for agents', 'tool']]);

    const roster = fold(events);
    assert.equal(roster.length, 1);
    const [child] = roster;
    assert.equal(child.sessionId, '01a13922-817a-7bf1-9dff-5a293ace9cb7');
    assert.equal(child.parentToolCallId, 'call_GBp7LKK0Wu9nOwHcussXDRmk');
    assert.equal(child.source, 'codex');
    assert.match(child.prompt ?? '', /read-only observability probe/);
    assert.equal(child.model, 'gpt-6.1-sol');
    // The child turn failed on capacity; both the child stream and the wait
    // item report it.
    assert.equal(child.status, 'terminated');
    assert.equal(child.outcome, 'failed');
    assert.match(child.error ?? '', /at capacity/);
  });

  it('maps every documented agent state', () => {
    const roster = codexCollabRoster({
      id: 'w', tool: 'wait', status: 'completed', receiverThreadIds: ['a', 'b', 'c', 'd'],
      agentsStates: {
        a: { status: 'running', message: null },
        b: { status: 'completed', message: 'Found it in src/x.ts' },
        c: { status: 'errored', message: 'boom' },
        d: { status: 'shutdown', message: null },
      },
    });
    const byId = Object.fromEntries(roster.map((entry) => [entry.sessionId, entry]));
    assert.equal(byId.a.status, 'working');
    assert.equal(byId.b.outcome, 'completed');
    assert.equal(byId.b.result, 'Found it in src/x.ts');
    assert.equal(byId.c.outcome, 'failed');
    assert.equal(byId.c.error, 'boom');
    assert.equal(byId.d.status, 'terminated');
    assert.equal(byId.d.outcome, undefined);
    // wait is not a spawn: it must not claim the chip link.
    assert.equal(byId.b.parentToolCallId, undefined);
  });

  it('keeps the child nickname when the spawn patch arrives after thread/started', () => {
    let roster = mergeSubagentRoster(undefined, [{
      sessionId: 'child-1', sessionName: 'Ada', agentName: 'Ada', initialQuery: '', status: 'working', group: '', dependsOn: [], source: 'codex',
    }]);
    roster = mergeSubagentRoster(roster, codexCollabRoster({
      id: 'call_1', tool: 'spawnAgent', status: 'completed', prompt: 'Read fixture.txt', receiverThreadIds: ['child-1'], agentsStates: {},
    }));
    assert.equal(roster[0].agentName, 'Ada');
    assert.equal(roster[0].parentToolCallId, 'call_1');
    // A wait item with no state for a thread must not reopen or close it.
    const [waitPatch] = codexCollabRoster({ id: 'w', tool: 'wait', status: 'completed', receiverThreadIds: ['child-1'], agentsStates: {} });
    assert.equal(waitPatch.status, undefined);
  });

  it('carries a child the parent did not wait for into the next turn with its full entry', () => {
    const handlers = new Map<string, (method: string, params: Record<string, unknown>) => void>();
    const client = {
      onNotification: (id: string, handler: (method: string, params: Record<string, unknown>) => void) => { handlers.set(id, handler); return () => handlers.delete(id); },
      onGlobalNotification: () => () => {},
      onExit: () => () => {},
      request: async () => ({}),
    };
    const session = new CodexSession({
      nodeId: 'n', threadId: 'parent', cwd: '/tmp', workspaceId: null, client, mcpRegistry: {}, bridge: {}, host: michiTestHost(), hostText: michiCodexHostText(), enableFollowUps: false,
      backgroundSubagents: subagentSink(testRegistry()),
    } as never) as unknown as Record<string, any>;
    const events: NormalizedEvent[] = [];
    session.queue.dispose();
    session.queue = { push: (ev: NormalizedEvent) => events.push(ev), dispose: () => {} };
    session.wireNotifications();
    const parent = handlers.get('parent')!;
    const beginTurn = () => { session.parentTurnSeq += 1; session.nativeSettled = false; session.markTranslatorTurnStart(); };

    beginTurn();
    parent('item/completed', { threadId: 'parent', turnId: 't1', item: {
      type: 'collabAgentToolCall', id: 'call_1', tool: 'spawnAgent', status: 'completed', prompt: 'Audit docs',
      receiverThreadIds: ['child-1'], agentsStates: { 'child-1': { status: 'running', message: null } },
    } });
    parent('turn/completed', { threadId: 'parent', turn: { id: 't1', status: 'completed' } });
    const turn1 = fold(events);
    assert.equal(turn1[0].background, true, 'the spawning turn records it as running in the background');

    // Between turns the child's frames go nowhere.
    const idle = events.length;
    handlers.get('child-1')?.('item/started', { threadId: 'child-1', turnId: 'c1', item: { type: 'commandExecution', id: 'x', command: 'ls' } });
    assert.equal(events.length, idle);

    // Next parent turn: the child's completion arrives with its identity.
    beginTurn();
    const turn2Start = events.length;
    handlers.get('child-1')?.('turn/completed', { threadId: 'child-1', turn: { id: 'c1', status: 'completed' } });
    const turn2 = fold(events.slice(turn2Start));
    assert.equal(turn2.length, 1);
    assert.equal(turn2[0].prompt, 'Audit docs');
    assert.equal(turn2[0].parentToolCallId, 'call_1');
    assert.equal(turn2[0].outcome, 'completed');
  });

  describe('subAgentActivity items (codex-cli 0.156), replayed from a real wire', () => {
    const ACTIVITY_WIRE = path.join(__dirname, 'fixtures', 'subagents', 'codex-subagent-activity-wire.jsonl');
    const CHILD = '01a168ae-8a55-76e2-87a4-38aae4d2bcd0';
    const SPAWN_ITEM = 'call_0A2GHO81pCmlavviGnQhcxw5';

    /**
     * Replays the wire phase by phase: turn 1 spawns a background child and
     * ends; the child finishes while the parent is idle; turn 2 starts.
     * Turn starts mirror send(): new sequence, open stream, idle completions.
     */
    function replayActivityWire(): Record<'turn1' | 'idle' | 'turn2', NormalizedEvent[]> {
      const [head, ...frames] = fs.readFileSync(ACTIVITY_WIRE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const handlers = new Map<string, (method: string, params: Record<string, unknown>) => void>();
      let global: ((method: string, params: Record<string, unknown>) => void) | undefined;
      const client = {
        onNotification: (id: string, handler: (method: string, params: Record<string, unknown>) => void) => { handlers.set(id, handler); return () => handlers.delete(id); },
        onGlobalNotification: (handler: typeof global) => { global = handler; return () => {}; },
        onExit: () => () => {},
        request: async () => ({}),
      };
      const session = new CodexSession({
        nodeId: 'codex-activity-replay', threadId: head.parentThreadId, cwd: '/tmp', workspaceId: null,
        client, mcpRegistry: {}, bridge: {}, host: michiTestHost(), hostText: michiCodexHostText(), enableFollowUps: false,
        backgroundSubagents: subagentSink(testRegistry()),
      } as never) as unknown as Record<string, any>;
      const byPhase = { turn1: [] as NormalizedEvent[], idle: [] as NormalizedEvent[], turn2: [] as NormalizedEvent[] };
      let phase: keyof typeof byPhase = 'turn1';
      session.queue.dispose();
      session.queue = { push: (ev: NormalizedEvent) => byPhase[phase].push(ev), dispose: () => {} };
      session.wireNotifications();
      const beginTurn = () => {
        session.parentTurnSeq += 1;
        session.nativeSettled = false;
        session.markTranslatorTurnStart();
        session.publishIdleChildCompletions();
      };
      beginTurn();
      for (const frame of frames) {
        if (frame.phase !== phase) {
          phase = frame.phase;
          if (phase === 'turn2') beginTurn();
        }
        global?.(frame.method, frame.params);
        handlers.get(frame.params.threadId)?.(frame.method, frame.params);
      }
      return byPhase;
    }

    it('shows the spawn as a delegation chip and tracks the child it names', () => {
      const { turn1 } = replayActivityWire();
      const chips = turn1.filter((e) => e.kind === 'tool_call') as Array<{ toolCallId: string; title: string; kindType?: string }>;
      assert.deepEqual(chips.map((c) => [c.toolCallId, c.title, c.kindType]), [[SPAWN_ITEM, 'Spawn agent', 'subagent']]);
      const updates = turn1.filter((e) => e.kind === 'tool_call_update') as Array<{ toolCallId: string; status?: string }>;
      assert.deepEqual(updates.map((u) => [u.toolCallId, u.status]), [[SPAWN_ITEM, 'completed']]);

      const [child, ...others] = fold(turn1);
      assert.deepEqual(others, []);
      assert.equal(child.sessionId, CHILD);
      assert.equal(child.parentToolCallId, SPAWN_ITEM);
      assert.equal(child.source, 'codex');
      assert.equal(child.sessionName, 'probe', 'named after its agent path');
      assert.equal(child.status, 'working');
      assert.equal(child.background, true, 'the parent ended its turn while the child worked');
    });

    it('sends nothing while the parent is idle, then reports the outcome at the next turn', () => {
      const { idle, turn2 } = replayActivityWire();
      assert.deepEqual(idle, []);
      assert.equal(turn2[0]?.kind, 'subagent_list_update', 'the completion opens the next turn');
      const [child] = fold(turn2);
      assert.equal(child.sessionId, CHILD);
      assert.equal(child.status, 'terminated');
      assert.equal(child.outcome, 'completed');
      assert.equal(child.result, 'PROBE_MARKER=idle-child-7731');
      assert.equal(child.parentToolCallId, SPAWN_ITEM);
      assert.equal(child.background, true);
      assert.equal(turn2.filter((e) => e.kind === 'tool_call').length, 0, 'no chip for the parent\'s completion notice');
    });

    it('makes no chip for completion, interaction or interruption notices', () => {
      const handlers = new Map<string, (method: string, params: Record<string, unknown>) => void>();
      const client = {
        onNotification: (id: string, handler: (method: string, params: Record<string, unknown>) => void) => { handlers.set(id, handler); return () => handlers.delete(id); },
        onGlobalNotification: () => () => {},
        onExit: () => () => {},
        request: async () => ({}),
      };
      const session = new CodexSession({
        nodeId: 'n', threadId: 'parent', cwd: '/tmp', workspaceId: null, client, mcpRegistry: {}, bridge: {}, host: michiTestHost(), hostText: michiCodexHostText(), enableFollowUps: false,
        backgroundSubagents: subagentSink(testRegistry()),
      } as never) as unknown as Record<string, any>;
      const events: NormalizedEvent[] = [];
      session.queue.dispose();
      session.queue = { push: (ev: NormalizedEvent) => events.push(ev), dispose: () => {} };
      session.nativeSettled = false;
      session.wireNotifications();
      session.markTranslatorTurnStart();
      for (const kind of ['interacted', 'interrupted', 'completed']) {
        for (const method of ['item/started', 'item/completed']) {
          handlers.get('parent')!(method, { threadId: 'parent', turnId: 't1', item: {
            type: 'subAgentActivity', id: `subagent-${kind}-x`, kind, agentThreadId: 'child-9', agentPath: '/root/helper',
          } });
        }
      }
      assert.deepEqual(events, []);
    });
  });

  describe('a background child that finishes while the parent is idle', () => {
    /**
     * A CodexSession driven through send(), with per-thread notifications.
     * It reports into its own recording registry: the process-wide one would
     * look the node's workspace up in the real data directory's database.
     */
    function liveSession(opts: { holdTurnStart?: (n: number) => Promise<void> } = {}) {
      const registry = new BackgroundSubagentRegistry({ graceMs: 10, resolveWorkspace: () => 'ws-test' });
      const reports: string[][] = [];
      const reporters: string[] = [];
      const report = registry.report.bind(registry);
      registry.report = (context, source, ids) => {
        reporters.push(`${context.ownerUserId}|${context.workspaceId}|${context.nodeId}|${source}`);
        reports.push([...ids]);
        report(context, source, ids);
      };
      const handlers = new Map<string, (method: string, params: Record<string, unknown>) => void>();
      let turns = 0;
      const client = {
        onNotification: (id: string, handler: (method: string, params: Record<string, unknown>) => void) => { handlers.set(id, handler); return () => handlers.delete(id); },
        onGlobalNotification: () => () => {},
        onExit: () => () => {},
        request: async (method: string) => {
          if (method !== 'turn/start') return {};
          const n = ++turns;
          await opts.holdTurnStart?.(n);
          return { turn: { id: `t${n}` } };
        },
      };
      const mcpRegistry = { create: () => ({ slotId: 'slot' }), dispose: async () => {}, get: () => undefined };
      const session = new CodexSession({
        nodeId: 'n', threadId: 'parent', cwd: '/tmp', workspaceId: null, client, mcpRegistry, bridge: {}, host: michiTestHost(), hostText: michiCodexHostText(), enableFollowUps: false,
        backgroundSubagents: subagentSink(registry),
      } as never) as unknown as Record<string, any>;
      session.createMcpSlot();
      session.wireNotifications();
      const notify = (threadId: string, method: string, params: Record<string, unknown> = {}) =>
        handlers.get(threadId)?.(method, { threadId, ...params });
      /** One parent turn; `during` runs once turn/start was answered. */
      const turn = async (text: string, during: (turnId: string) => void = () => {}) => {
        const events: NormalizedEvent[] = [];
        const done = (async () => { for await (const ev of session.send(text)) events.push(ev); })();
        await new Promise((resolve) => setImmediate(resolve));
        const turnId = `t${turns}`;
        during(turnId);
        notify('parent', 'turn/completed', { turn: { id: turnId, status: 'completed' } });
        await done;
        return events;
      };
      const afterGrace = () => new Promise((resolve) => setTimeout(resolve, 30));
      // How the session said its children ended (no recorder: nothing is stored).
      const ended: EndedBackgroundSubagents[] = [];
      registry.subscribeEnded((update) => ended.push(update));
      return { session, notify, turn, registry, reports, reporters, ended, afterGrace };
    }

    const spawn = (notify: ReturnType<typeof liveSession>['notify']) => (turnId: string) => {
      notify('parent', 'item/completed', { turnId, item: {
        type: 'collabAgentToolCall', id: 'call_1', tool: 'spawnAgent', status: 'completed', prompt: 'Audit docs',
        receiverThreadIds: ['child-1'], agentsStates: { 'child-1': { status: 'running', message: null } },
      } });
    };

    const finishChild = (notify: ReturnType<typeof liveSession>['notify']) => {
      notify('child-1', 'item/agentMessage/delta', { turnId: 'c1', delta: 'Found 3 issues' });
      notify('child-1', 'turn/completed', { turn: { id: 'c1', status: 'completed' } });
    };

    const childUpdates = (events: NormalizedEvent[]) => events
      .filter((ev): ev is Extract<NormalizedEvent, { kind: 'subagent_list_update' }> => ev.kind === 'subagent_list_update')
      .flatMap((ev) => ev.subagents)
      .filter((entry) => entry.sessionId === 'child-1');

    it('reports its full entry at the start of the next parent turn, once', async () => {
      const { notify, turn } = liveSession();
      const turn1 = await turn('spawn', spawn(notify));
      assert.equal(fold(turn1)[0].background, true, 'the spawning turn records it as running in the background');

      finishChild(notify);

      const turn2 = await turn('next');
      const first = turn2.find((ev) => ev.kind === 'subagent_list_update');
      assert.ok(first, 'the next turn reports the child');
      assert.equal(turn2.indexOf(first), 0, 'before anything else in the turn');
      const [entry] = childUpdates(turn2);
      assert.equal(entry.status, 'terminated');
      assert.equal(entry.outcome, 'completed');
      assert.equal(entry.result, 'Found 3 issues');
      assert.equal(entry.background, true);
      assert.equal(entry.prompt, 'Audit docs');
      assert.equal(entry.parentToolCallId, 'call_1');

      const turn3 = await turn('later');
      assert.deepEqual(childUpdates(turn3), [], 'reported once');
    });

    it('keeps it for the turn after one cancelled before its stream', async () => {
      let release: (() => void) | undefined;
      let requested: (() => void) | undefined;
      const turnStartRequested = new Promise<void>((resolve) => { requested = resolve; });
      const { session, notify, turn } = liveSession({
        holdTurnStart: (n) => {
          if (n !== 2) return Promise.resolve();
          requested!();
          return new Promise<void>((resolve) => { release = resolve; });
        },
      });
      await turn('spawn', spawn(notify));
      finishChild(notify);

      // Turn 2 is cancelled while turn/start is in flight: its queued
      // events are drained, never yielded.
      const turn2: NormalizedEvent[] = [];
      const done = (async () => { for await (const ev of session.send('next')) turn2.push(ev); })();
      await turnStartRequested;
      await session.cancel();
      release!();
      await new Promise((resolve) => setImmediate(resolve));
      notify('parent', 'turn/completed', { turn: { id: 't2', status: 'interrupted' } });
      await done;
      assert.deepEqual(turn2.map((ev) => ev.kind), ['turn_end']);

      const turn3 = await turn('again');
      const [entry] = childUpdates(turn3);
      assert.equal(entry?.outcome, 'completed', 'the completion is not lost with the cancelled turn');
      assert.equal(entry?.result, 'Found 3 issues');
      assert.deepEqual(childUpdates(await turn('later')), []);
    });

    it('is not reported when it was not running in the background', async () => {
      const { notify, turn, reports } = liveSession();
      // The child ends inside the spawning turn: no carry-over.
      await turn('spawn', (turnId) => { spawn(notify)(turnId); finishChild(notify); });
      assert.deepEqual(childUpdates(await turn('next')), []);
      assert.deepEqual(reports, [], 'a foreground child never reaches the registry');
    });

    // ── The background registry ───────────────────────────────────────────

    it('registers it when the parent turn ends and ends it when it finishes while the parent is idle', async () => {
      const { session, notify, turn, registry, reports, reporters, ended, afterGrace } = liveSession();
      await turn('spawn', (turnId) => {
        spawn(notify)(turnId);
        assert.deepEqual(reports, [], 'a running child is not background work until its parent turn ends');
      });
      assert.deepEqual(reports, [['child-1']]);
      // Owner defaults to the local user; the workspace is resolved from the node.
      assert.match(reporters[0], new RegExp(`^${LOCAL_AGENT_OWNER_ID}\\|null\\|n\\|codex:[0-9a-f-]{36}$`));
      assert.deepEqual(registry.snapshot(LOCAL_AGENT_OWNER_ID, 'ws-test'), { n: ['child-1'] });
      assert.equal(session.hasBackgroundWork(), true);

      // Finished while the parent is idle: Codex starts no turn to report it,
      // so it ends now (the badge goes out) with its outcome.
      finishChild(notify);
      assert.deepEqual(reports, [['child-1'], []]);
      assert.equal(session.hasBackgroundWork(), false);
      assert.equal(ended.length, 1);
      assert.equal(ended[0].ends[0].sessionId, 'child-1');
      assert.equal(ended[0].ends[0].outcome, 'completed');
      assert.equal(ended[0].ends[0].result, 'Found 3 issues');
      await afterGrace();
      assert.deepEqual(registry.snapshot(LOCAL_AGENT_OWNER_ID, 'ws-test'), {});

      // The next turn still reports it into its message, and nothing more.
      const turn2 = await turn('next');
      assert.equal(childUpdates(turn2)[0]?.outcome, 'completed');
      assert.deepEqual(reports, [['child-1'], []]);
      assert.equal(ended.length, 1, 'ended once');

      await turn('later');
      assert.deepEqual(reports, [['child-1'], []], 'nothing more');
      assert.equal(new Set(reporters).size, 1, 'one source per session');
    });

    it('does not register an ended idle completion again through a turn cancelled before its stream', async () => {
      let release: (() => void) | undefined;
      let requested: (() => void) | undefined;
      const turnStartRequested = new Promise<void>((resolve) => { requested = resolve; });
      const { session, notify, turn, reports } = liveSession({
        holdTurnStart: (n) => {
          if (n !== 2) return Promise.resolve();
          requested!();
          return new Promise<void>((resolve) => { release = resolve; });
        },
      });
      await turn('spawn', spawn(notify));
      finishChild(notify);

      const done = (async () => { for await (const _ev of session.send('next')) void _ev; })();
      await turnStartRequested;
      await session.cancel();
      release!();
      await new Promise((resolve) => setImmediate(resolve));
      notify('parent', 'turn/completed', { turn: { id: 't2', status: 'interrupted' } });
      await done;
      assert.deepEqual(reports, [['child-1'], []], 'ended at its completion; the cancelled turn changes nothing');
      assert.equal(session.hasBackgroundWork(), false);

      await turn('again');
      assert.deepEqual(reports, [['child-1'], []]);
    });

    it('withdraws a child that finishes inside a later parent turn', async () => {
      const { session, notify, turn, reports } = liveSession();
      await turn('spawn', spawn(notify));
      const turn2 = await turn('next', () => finishChild(notify));
      assert.equal(childUpdates(turn2).at(-1)?.outcome, 'completed', 'reported live in the turn');
      assert.deepEqual(reports, [['child-1'], []]);
      assert.equal(session.hasBackgroundWork(), false);
    });

    it('withdraws it when the session crashes', async () => {
      const { session, notify, turn, reports } = liveSession();
      await turn('spawn', spawn(notify));
      session.markCrashed('app-server exited');
      assert.deepEqual(reports, [['child-1'], []]);
      assert.equal(session.hasBackgroundWork(), false);
      // A child frame after the crash reports nothing.
      finishChild(notify);
      assert.equal(reports.length, 2);
      await session.dispose();
      assert.equal(reports.length, 2, 'already withdrawn');
    });

    it('withdraws it when the session is disposed, idle completion included', async () => {
      const { session, notify, turn, reports } = liveSession();
      await turn('spawn', spawn(notify));
      finishChild(notify);
      await session.dispose();
      assert.deepEqual(reports, [['child-1'], []]);
      assert.equal(session.hasBackgroundWork(), false);
    });

    // ── Ends no turn will report ──────────────────────────────────────────

    it('records a running child as stopped when the daemon exits, once', async () => {
      const { session, notify, turn, ended } = liveSession();
      await turn('spawn', spawn(notify));
      const before = Date.now();
      session.markCrashed('app-server exited');
      assert.equal(ended.length, 1);
      assert.equal(ended[0].nodeId, 'n');
      assert.equal(ended[0].workspaceId, 'ws-test', 'the workspace the node was tracked under');
      assert.equal(ended[0].ends.length, 1);
      const [end] = ended[0].ends;
      assert.equal(end.sessionId, 'child-1');
      assert.equal(end.outcome, 'cancelled');
      assert.equal(end.error, SUBAGENT_SESSION_ENDED_ERROR);
      assert.ok(typeof end.endedAt === 'number' && end.endedAt >= before);
      await session.dispose();
      assert.equal(ended.length, 1, 'nothing left to end');
    });

    it('records a child that finished while idle with its outcome when the session is released first', async () => {
      const { session, notify, turn, ended } = liveSession();
      await turn('spawn', spawn(notify));
      finishChild(notify);
      await session.dispose();
      assert.equal(ended.length, 1);
      const [end] = ended[0].ends;
      assert.equal(end.sessionId, 'child-1');
      assert.equal(end.outcome, 'completed');
      assert.equal(end.result, 'Found 3 issues');
    });

    it('records an idle completion once, not again when the session is released', async () => {
      const { session, notify, turn, ended } = liveSession();
      await turn('spawn', spawn(notify));
      finishChild(notify);
      await turn('next');
      await session.dispose();
      assert.equal(ended.length, 1);
      assert.equal(ended[0].ends[0].outcome, 'completed');
    });

    it('records nothing for a child that finished inside a parent turn', async () => {
      const { session, notify, turn, ended } = liveSession();
      await turn('spawn', spawn(notify));
      await turn('next', () => finishChild(notify));
      await session.dispose();
      assert.deepEqual(ended, []);
    });

    it('waits for an outcome when the child thread goes idle before its turn completes', async () => {
      const { session, notify, turn, reports, ended } = liveSession();
      await turn('spawn', spawn(notify));
      // codex-cli 0.156 sends the child's idle status a frame before its turn/completed.
      notify('child-1', 'item/agentMessage/delta', { turnId: 'c1', delta: 'Found 3 issues' });
      session.handleChildThreadLifecycle('thread/status/changed', { threadId: 'child-1', status: { type: 'idle' } });
      assert.equal(ended.length, 0, 'no outcome yet: not ended as stopped');
      assert.deepEqual(reports, [['child-1']]);
      notify('child-1', 'turn/completed', { turn: { id: 'c1', status: 'completed' } });
      assert.equal(ended.length, 1);
      assert.equal(ended[0].ends[0].outcome, 'completed');
      assert.equal(ended[0].ends[0].result, 'Found 3 issues');
    });
  });
});
