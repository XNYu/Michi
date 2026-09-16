/**
 * Pane Inspection API — `wait_pane`'s service (design §7.4; brief P3-5).
 *
 * One bounded, one-shot wait per call. This module owns:
 *  - the two mutually-exclusive modes (`until: 'changed'` / `until: 'terminal'`) and their
 *    argument validation (design §7.4; brief: reject the wrong combination as INVALID_ARGUMENT);
 *  - the check → subscribe → check-again sequence that closes the race between the first
 *    terminal-state read and the listener attach (design §8: "查询执行终态、注册等待 listener、
 *    再次查询终态的顺序由 service 封装，避免检查与订阅之间的竞态");
 *  - the per-owner concurrent-wait limit (design §11 / `PANE_INSPECTION_LIMITS.concurrentWaitsPerOwnerMax`);
 *  - releasing every listener/timer it armed on every exit path (change, terminal, timeout,
 *    unavailable, or an unexpected throw) — a leaked listener is a leak AND, in this campaign's
 *    own test suite, a hung process (see the test file's header comment).
 *
 * NOT owned here: the HTTP route (`POST /api/panes/wait`) and the `wait_pane` agent tool — those
 * are P3-5b, a deliberate follow-up split from the original four-deliverable task (see this
 * task's report). This file exports exactly the service function P3-5b mounts against.
 *
 * Built on P3-2/P3-4's `PaneFeed.oncePerObject` seam (`paneInspectionSubscribe.ts`), which this
 * task implements: a non-coalescing, ring-untouched one-shot change listener that reuses the
 * exact same ChatHub/AgentRunEventBus notification sources the SSE feed uses, so `wait_pane` and
 * `subscribePanes` can never disagree about what "changed" means for the same object.
 *
 * Design: docs/pane-inspection-api-design-2026-09-14.md §7.4, §11. COMMON.md decisions 8, 9, 10.
 */

import {
  PANE_INSPECTION_LIMITS,
  PaneInspectionError,
  type ExecutionRef,
  type PaneDescriptorV1,
  type PaneLocator,
  type WaitPaneResultV1,
  type WaitReason,
  type WaitUntil,
} from 'michi-shared';
import { authorizeCaller, inspect, resolvePaneTarget, scopeForCaller, type PaneInspectionCaller } from './paneInspection';
import { paneInspectionRing } from './paneInspectionRing';
import { PaneFeed, systemPaneSubscribeClock, type PaneSubscribeClock } from './paneInspectionSubscribe';
import type { AgentRunEventBus } from '../agents/runs/agentRunEventBus';

const SETTLED_EXECUTION_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export interface WaitPaneInput {
  signal?: AbortSignal;
  locator: PaneLocator;
  until: WaitUntil;
  /** Required and only meaningful for until: 'changed'. The observation cursor the caller last
   *  saw (e.g. from a prior inspect_pane/wait_pane/subscribePanes event). */
  cursor?: string;
  /** Required and only meaningful for until: 'terminal'. Must name a turn/run that has already
   *  started (COMMON.md / design §7.4: a `queued` chat has no turnId yet and may only use
   *  `changed`). */
  executionRef?: ExecutionRef;
  timeoutMs: number;
}

export interface WaitPaneDeps {
  clock: PaneSubscribeClock;
  agentRunEvents?: AgentRunEventBus;
}

const defaultDeps: WaitPaneDeps = { clock: systemPaneSubscribeClock };

/** Per-owner count of in-flight waits — design §11's `concurrentWaitsPerOwnerMax`. Module-level
 *  so it is shared across every call regardless of which `PaneFeed` instance a given call
 *  constructs (each call gets its own feed; this counter is what actually enforces the limit
 *  across them). */
const activeWaitsByOwner = new Map<string, number>();

function acquireWaitSlot(ownerUserId: string): boolean {
  const count = activeWaitsByOwner.get(ownerUserId) ?? 0;
  if (count >= PANE_INSPECTION_LIMITS.concurrentWaitsPerOwnerMax) return false;
  activeWaitsByOwner.set(ownerUserId, count + 1);
  return true;
}

function releaseWaitSlot(ownerUserId: string): void {
  const count = activeWaitsByOwner.get(ownerUserId) ?? 0;
  if (count <= 1) activeWaitsByOwner.delete(ownerUserId);
  else activeWaitsByOwner.set(ownerUserId, count - 1);
}

function toContentSnapshot(descriptor: PaneDescriptorV1): unknown {
  const { observation, presence, ...rest } = descriptor;
  return {
    ...rest,
    observation: { freshness: observation.freshness },
    presence: {
      coverage: presence.coverage,
      views: presence.views.map((view) => ({
        windowId: view.windowId, uiPaneId: view.uiPaneId, treeId: view.treeId,
        visible: view.visible, openedAtClient: view.openedAtClient,
      })),
    },
  };
}

/** Whether `ref` names a turn/run that has already started — the `until: 'terminal'` precondition
 *  (design §7.4: "要求 executionRef 中的 turn/run 已经开始"). `executionRef`'s own variants
 *  (`chat_turn` with a non-empty `turnId`, or `agent_run`) both satisfy this by construction once
 *  parsed by `parseExecutionRef` — a `queued` chat has no turnId to put in one at all, so this
 *  check is really "was an executionRef supplied", enforced by the caller-argument validation
 *  below rather than re-derived here.
 */
function outcomeFor(descriptor: PaneDescriptorV1): { outcome: WaitPaneResultV1['outcome']; settled: boolean } {
  if (descriptor.execution.status !== 'ready' || !descriptor.execution.value) return { outcome: null, settled: false };
  const status = descriptor.execution.value.status;
  return { outcome: status, settled: SETTLED_EXECUTION_STATUSES.has(status) };
}

function result(reason: WaitReason, descriptor: PaneDescriptorV1 | null, cursor: string): WaitPaneResultV1 {
  return { version: 1, reason, descriptor, outcome: descriptor ? outcomeFor(descriptor).outcome : null, cursor };
}

/**
 * Waits, bounded by `input.timeoutMs`, for `input.locator` to satisfy `input.until`:
 *
 *  - `until: 'changed'`: returns `reason: 'changed'` immediately if the object's current content
 *    already differs from `input.cursor`'s baseline (a stale cursor), otherwise waits for the
 *    first content change or the timeout.
 *  - `until: 'terminal'`: returns `reason: 'terminal'` immediately if `input.executionRef`'s own
 *    execution is already settled (completed/failed/cancelled), otherwise waits for THAT SAME
 *    executionRef to settle. Re-inspecting with an explicit `executionRef` always reports that
 *    ref's own status regardless of what a later attempt/turn on the same object is doing
 *    (`inspect`'s own `executionRef`-scoped read — see `paneInspection.ts`), which is what makes
 *    "T1's wait must not be satisfied by T2" true without this module tracking attempts itself.
 *
 * The timeout ends the WAIT only — it never cancels anything (no cancel call is made on any
 * path). Every exit path releases the listener/timer/wait-slot this call acquired.
 */
export async function waitPane(caller: PaneInspectionCaller, input: WaitPaneInput, deps: WaitPaneDeps = defaultDeps): Promise<WaitPaneResultV1> {
  if (input.until === 'changed' && input.cursor === undefined) {
    throw new PaneInspectionError('INVALID_ARGUMENT', 'cursor', 'is required when until is "changed"');
  }
  if (input.until === 'terminal' && input.executionRef === undefined) {
    throw new PaneInspectionError('INVALID_ARGUMENT', 'executionRef', 'is required when until is "terminal"');
  }

  const target = resolvePaneTarget(input.locator);
  authorizeCaller(caller, target);

  if (!acquireWaitSlot(caller.ownerUserId)) {
    throw new PaneInspectionError('RATE_LIMITED', 'wait_pane', `at most ${PANE_INSPECTION_LIMITS.concurrentWaitsPerOwnerMax} concurrent waits are allowed per owner`);
  }

  try {
    return await runWait(caller, target, input, deps);
  } finally {
    releaseWaitSlot(caller.ownerUserId);
  }
}

function runWait(
  caller: PaneInspectionCaller,
  target: ReturnType<typeof resolvePaneTarget>,
  input: WaitPaneInput,
  deps: WaitPaneDeps,
): Promise<WaitPaneResultV1> {
  return new Promise<WaitPaneResultV1>((resolve, reject) => {
    if (input.signal?.aborted) { resolve(result('unavailable', null, '')); return; }
    // ---- check #1 -----------------------------------------------------------------------------
    let descriptor: PaneDescriptorV1;
    try {
      descriptor = inspect(caller, { locator: input.locator, executionRef: input.executionRef });
    } catch (err) {
      if (err instanceof PaneInspectionError && (err.code === 'NOT_FOUND' || err.code === 'NAVIGATION_DISABLED')) {
        resolve(result('unavailable', null, ''));
        return;
      }
      throw err;
    }

    const scope = scopeForCaller(caller);
    const baselineContent = toContentSnapshot(descriptor);

    if (input.until === 'terminal') {
      const { settled } = outcomeFor(descriptor);
      if (settled) { resolve(result('terminal', descriptor, mintCursor(descriptor, target, scope))); return; }
    } else {
      // until: 'changed' — a stale cursor (one that no longer resolves to the object's current
      // revision) means a change already happened before this call was even made.
      const resolution = paneInspectionRing.resolveCursor(input.cursor!, scope);
      if (!resolution.ok || resolution.paneId !== descriptor.ref.paneId || resolution.cursorRevision < resolution.revision) {
        resolve(result('changed', descriptor, mintCursor(descriptor, target, scope)));
        return;
      }
    }

    // ---- subscribe ------------------------------------------------------------------------------
    const feed = new PaneFeed({ clock: deps.clock, ring: paneInspectionRing, agentRunEvents: deps.agentRunEvents });
    const paneId = descriptor.ref.paneId;
    let settled = false;
    let timeoutHandle: unknown;
    let detach: (() => void) | undefined;
    let latestDescriptor = descriptor;

    const cleanup = (): void => {
      settled = true;
      if (timeoutHandle !== undefined) deps.clock.clearTimeout(timeoutHandle);
      detach?.();
      feed.stop();
      input.signal?.removeEventListener('abort', abort);
    };
    const finish = (out: WaitPaneResultV1): void => {
      if (settled) return;
      cleanup();
      resolve(out);
    };
    const abort = (): void => finish(result('unavailable', null, ''));
    input.signal?.addEventListener('abort', abort, { once: true });

    /** Arms exactly one `oncePerObject` listener against `sinceContent`. `oncePerObject` fires at
     *  most once per arm-call (P3-2's documented one-shot contract), so `until: 'terminal'`
     *  re-arms with the NEW content as its baseline whenever a change fires that turns out not to
     *  be T1's own settlement (e.g. a T2 start/attempt-switch) — this is what makes "T1's wait
     *  survives T2 starting" true without ever treating T2's own activity as the thing being
     *  waited for. `until: 'changed'` never re-arms: ANY change satisfies it, so its callback
     *  always calls `finish` on the first firing. Passing `input.executionRef` scopes
     *  `oncePerObject`'s own re-inspects to T1 for terminal mode, so `changedDescriptor` already
     *  reflects T1's own status — no second, separately-scoped inspect() call is needed here.
     */
    const arm = (sinceContent: unknown): void => {
      detach = feed.oncePerObject(
        caller,
        paneId,
        sinceContent,
        (changedDescriptor) => {
          latestDescriptor = changedDescriptor;
          if (input.until !== 'terminal') {
            finish(result('changed', changedDescriptor, mintCursor(changedDescriptor, target, scope)));
            return;
          }
          const { settled: nowSettled } = outcomeFor(changedDescriptor);
          if (nowSettled) { finish(result('terminal', changedDescriptor, mintCursor(changedDescriptor, target, scope))); return; }
          // Not T1's own settlement (e.g. T2 starting) — keep waiting, re-armed against the new
          // content so the next distinct change (not this same one) is what wakes us again.
          if (!settled) arm(toContentSnapshot(changedDescriptor));
        },
        () => finish(result('unavailable', null, '')),
        input.until === 'terminal' ? input.executionRef : undefined,
      );
    };

    try { arm(baselineContent); } catch (err) { cleanup(); reject(err); return; }
    if (settled) { detach?.(); return; }

    // ---- check #2 (closes the check-subscribe-check race) --------------------------------------
    // A change landing strictly between check #1 and the listener attach above is caught here:
    // re-inspect once more, right after arming, before the timeout clock starts. This does not
    // duplicate the listener's own future firing — `finish` is idempotent (guarded by `settled`),
    // so if the listener ALSO fires for the same change (it won't: the change already happened
    // and this synchronous re-check consumes it first), the second call is a no-op.
    let secondDescriptor: PaneDescriptorV1;
    try {
      secondDescriptor = inspect(caller, { locator: input.locator, executionRef: input.executionRef });
    } catch (err) {
      if (err instanceof PaneInspectionError && (err.code === 'NOT_FOUND' || err.code === 'NAVIGATION_DISABLED')) {
        finish(result('unavailable', null, ''));
        return;
      }
      cleanup();
      reject(err);
      return;
    }
    latestDescriptor = secondDescriptor;
    if (input.until === 'terminal') {
      const { settled: nowSettled } = outcomeFor(secondDescriptor);
      if (nowSettled) { finish(result('terminal', secondDescriptor, mintCursor(secondDescriptor, target, scope))); return; }
    } else if (!deepEqual(baselineContent, toContentSnapshot(secondDescriptor))) {
      finish(result('changed', secondDescriptor, mintCursor(secondDescriptor, target, scope)));
      return;
    }

    timeoutHandle = deps.clock.setTimeout(() => {
      try {
        latestDescriptor = inspect(caller, { locator: input.locator, executionRef: input.executionRef });
        const reason = input.until === 'terminal' && outcomeFor(latestDescriptor).settled ? 'terminal'
          : input.until === 'changed' && !deepEqual(baselineContent, toContentSnapshot(latestDescriptor)) ? 'changed' : 'timed_out';
        finish(result(reason, latestDescriptor, latestDescriptor.observation.cursor));
      } catch (err) {
        if (err instanceof PaneInspectionError && (err.code === 'NOT_FOUND' || err.code === 'NAVIGATION_DISABLED')) {
          finish(result('unavailable', null, ''));
        } else { cleanup(); reject(err); }
      }
    }, input.timeoutMs);
  });
}

function mintCursor(descriptor: PaneDescriptorV1, target: ReturnType<typeof resolvePaneTarget>, scope: ReturnType<typeof scopeForCaller>): string {
  void target;
  return descriptor.observation.cursor;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
