/** Tests for the shared, ref-counted external store over subscribePanes (design §8; brief P3-6).
 *  See frontend/src/state/paneInspection.ts's module doc comment for the full contract. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneDescriptorV1, PaneFeedEventV1 } from 'michi-shared';
import * as paneInspectionApi from '../services/api/paneInspection';
import { PaneInspectionClientError } from '../services/api/paneInspection';
import {
  __resetPaneInspectionStoreForTests,
  attachPaneInspectionStore,
  selectPaneActivity,
  selectPaneExecutionStatus,
  selectPaneStatus,
  selectPaneTitle,
} from './paneInspection';

function descriptor(overrides: Partial<PaneDescriptorV1> = {}): PaneDescriptorV1 {
  return {
    version: 1,
    ref: { backendConnectionId: 'local', paneId: 'node:n1' },
    target: { kind: 'node', nodeId: 'n1' },
    kind: 'chat',
    title: 'Untitled',
    workspaceId: 'ws1',
    treeId: null,
    archived: false,
    truncatedFields: [],
    observation: { observedAt: 1_000, freshness: 'live', cursor: 'cursor-1' },
    capabilities: { readOutput: true, subscribe: true, waitForTerminal: true },
    activity: 'idle',
    execution: { status: 'unknown', reason: 'not started' },
    timeline: { resourceCreatedAt: null, firstExecutionStartedAt: null },
    presence: { coverage: 'unknown', views: [] },
    conversation: { status: 'unknown', reason: 'n/a' },
    lineage: { status: 'unknown', reason: 'n/a' },
    runtime: { status: 'unknown', reason: 'n/a' },
    latestOutput: { status: 'unknown', reason: 'n/a' },
    ...overrides,
  };
}

function snapshotEvent(paneId: string, cursor: string, patch: Partial<PaneDescriptorV1> = {}): PaneFeedEventV1 {
  return { version: 1, type: 'snapshot', paneId, cursor, emittedAt: 1_000, descriptor: descriptor({ ref: { backendConnectionId: 'local', paneId }, ...patch }) };
}

function heartbeatEvent(paneId: string, cursor: string): PaneFeedEventV1 {
  return { version: 1, type: 'heartbeat', paneId, cursor, emittedAt: 3_000 };
}

const BASE = 'http://localhost:3000/api';
const SCOPE = 'ws1';

/** Local test helper: the store's real API takes one options object
 *  `{ scopeKey, apiBase, paneIds }` (no default scopeKey — see paneInspection.ts). Most cases in
 *  this file only care about apiBase/paneIds, so this keeps call sites short while the
 *  "feed identity / scope key" describe block below exercises `scopeKey` explicitly. */
function attach(apiBase: string, paneIds: readonly string[], scopeKey: string = SCOPE) {
  return attachPaneInspectionStore({ scopeKey, apiBase, paneIds });
}

describe('paneInspection external store', () => {
  let subscribeSpy: ReturnType<typeof vi.spyOn>;
  let handlersByCallIndex: Array<Parameters<typeof paneInspectionApi.subscribePanes>[1]>;
  let unsubscribeFns: Array<ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    __resetPaneInspectionStoreForTests();
    handlersByCallIndex = [];
    unsubscribeFns = [];
    subscribeSpy = vi.spyOn(paneInspectionApi, 'subscribePanes').mockImplementation((_apiBase, options) => {
      handlersByCallIndex.push(options);
      const unsub = vi.fn();
      unsubscribeFns.push(unsub);
      return unsub;
    });
  });

  afterEach(() => {
    subscribeSpy.mockRestore();
  });

  it('settlement replaces the complete descriptor, including final output and commit state', () => {
    const handle = attach(BASE, ['node:n1']);
    handlersByCallIndex[0].onEvent(snapshotEvent('node:n1', 'c1', { activity: 'running' }));
    const final = descriptor({ activity: 'idle', execution: { status: 'ready', value: {
      ref: { kind: 'chat_turn', nodeId: 'n1', turnId: 't1' }, assistantId: 'a1', attemptId: null, attemptIndex: null,
      status: 'completed', startedAt: 1, endedAt: 2, commitState: 'committed', waitingReason: null, error: null,
    } }, latestOutput: { status: 'ready', value: { outputId: 'chat_turn:t1', outputRevision: 'r2',
      execution: { kind: 'chat_turn', nodeId: 'n1', turnId: 't1' }, kind: 'answer', text: 'final answer', updatedAt: 2, partial: false, truncated: false } } });
    handlersByCallIndex[0].onEvent({ version: 1, type: 'execution_settled', paneId: 'node:n1', cursor: 'c2', emittedAt: 2,
      execution: { kind: 'chat_turn', nodeId: 'n1', turnId: 't1' }, outcome: 'completed', commitState: 'committed', descriptor: final });
    expect(handle.getSnapshot().panes['node:n1'].descriptor).toEqual(final);
    expect(handle.getSnapshot().panes['node:n1'].executionStatus).toBe('completed');
    handle.detach();
  });

  describe('ref-counted feed lifecycle', () => {
    it('detach is idempotent — calling it twice does not double-unsubscribe or throw', () => {
      const a = attach(BASE, ['node:n1']);
      a.detach();
      expect(() => a.detach()).not.toThrow();
      expect(unsubscribeFns[0]).toHaveBeenCalledTimes(1);
    });
  });

  describe('immutable updates and stable getSnapshot identity', () => {
    it('a heartbeat event does not change the snapshot reference (heartbeat proves liveness only, design §8)', () => {
      const handle = attach(BASE, ['node:n1']);
      const before = handle.getSnapshot();
      handlersByCallIndex[0].onEvent(heartbeatEvent('node:n1', 'cursor-1'));
      const after = handle.getSnapshot();
      expect(after).toBe(before);
      handle.detach();
    });
  });

  describe('paneId-keyed state with cursor/status', () => {
    it('access_revoked sets status access_revoked', () => {
      const handle = attach(BASE, ['node:n1']);
      handlersByCallIndex[0].onEvent(snapshotEvent('node:n1', 'cursor-1'));
      handlersByCallIndex[0].onEvent({ version: 1, type: 'access_revoked', paneId: 'node:n1', cursor: 'cursor-2', emittedAt: 6_000 });
      expect(handle.getSnapshot().panes['node:n1']?.status).toBe('access_revoked');
      handle.detach();
    });
  });

  describe('subscribe callback (useSyncExternalStore compatibility)', () => {
    it('unsubscribing a listener stops further callback invocations without affecting other listeners', () => {
      const handle = attach(BASE, ['node:n1']);
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      const unsub1 = handle.subscribe(cb1);
      handle.subscribe(cb2);
      unsub1();
      handlersByCallIndex[0].onEvent(snapshotEvent('node:n1', 'cursor-1'));
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).toHaveBeenCalledTimes(1);
      handle.detach();
    });

    it('two attach() handles to the same logical feed share notifications (one feed, many listeners)', () => {
      const a = attach(BASE, ['node:n1']);
      const b = attach(BASE, ['node:n1']);
      const cbA = vi.fn();
      const cbB = vi.fn();
      a.subscribe(cbA);
      b.subscribe(cbB);
      handlersByCallIndex[0].onEvent(snapshotEvent('node:n1', 'cursor-1'));
      expect(cbA).toHaveBeenCalledTimes(1);
      expect(cbB).toHaveBeenCalledTimes(1);
      expect(a.getSnapshot()).toBe(b.getSnapshot());
      a.detach();
      b.detach();
    });
  });

  describe('structural selectors must not read or copy output token text', () => {
    it('selectPaneStatus/selectPaneActivity/selectPaneTitle never reference latestOutput.text', () => {
      const handle = attach(BASE, ['node:n1']);
      handlersByCallIndex[0].onEvent(snapshotEvent('node:n1', 'cursor-1', {
        activity: 'running',
        title: 'My Chat',
        latestOutput: {
          status: 'ready',
          value: { outputId: 'o1', execution: null, kind: 'answer', text: 'SENTINEL_TOKEN_TEXT', outputRevision: 'r1', updatedAt: null, partial: false, truncated: false },
        },
      }));
      const snap = handle.getSnapshot();
      expect(selectPaneActivity(snap, 'node:n1')).toBe('running');
      expect(selectPaneTitle(snap, 'node:n1')).toBe('My Chat');
      expect(selectPaneStatus(snap, 'node:n1')).toBe('ready');
      // The selector's own return values must never embed the output text.
      expect(JSON.stringify(selectPaneActivity(snap, 'node:n1'))).not.toContain('SENTINEL_TOKEN_TEXT');
      expect(JSON.stringify(selectPaneTitle(snap, 'node:n1'))).not.toContain('SENTINEL_TOKEN_TEXT');
      handle.detach();
    });
  });

  describe('authoritative executionStatus (P3-6 fix 2)', () => {
    it('execution_settled updates executionStatus from event.outcome even though it carries no descriptor', () => {
      const handle = attach(BASE, ['node:n1']);
      handlersByCallIndex[0].onEvent(snapshotEvent('node:n1', 'c1', { execution: { status: 'ready', value: null } }));
      handlersByCallIndex[0].onEvent({
        version: 1, type: 'execution_settled', paneId: 'node:n1', cursor: 'c2', emittedAt: 8_000,
        execution: { kind: 'chat_turn', nodeId: 'n1', turnId: 't1' }, outcome: 'completed', commitState: 'committed',
      });
      expect(selectPaneExecutionStatus(handle.getSnapshot(), 'node:n1')).toBe('completed');
      handle.detach();
    });
  });

  describe('output_changed/execution_settled before the first snapshot must not fabricate ready (P3-6 fix 3)', () => {
    it('output_changed before any snapshot leaves the pane loading, not ready+descriptor:null', () => {
      const handle = attach(BASE, ['node:n1']);
      handlersByCallIndex[0].onEvent({
        version: 1, type: 'output_changed', paneId: 'node:n1', cursor: 'c1', emittedAt: 1_000,
        outputId: 'o1', outputRevision: 'r1',
        preview: { outputId: 'o1', execution: null, kind: 'answer', text: 'partial', outputRevision: 'r1', updatedAt: 1_000, partial: true, truncated: false },
      });
      const entry = handle.getSnapshot().panes['node:n1'];
      expect(entry?.status).toBe('loading');
      expect(entry?.descriptor).toBeNull();
      handle.detach();
    });

    it('execution_settled before any snapshot leaves the pane loading, not ready+descriptor:null', () => {
      const handle = attach(BASE, ['node:n1']);
      handlersByCallIndex[0].onEvent({
        version: 1, type: 'execution_settled', paneId: 'node:n1', cursor: 'c1', emittedAt: 1_000,
        execution: { kind: 'chat_turn', nodeId: 'n1', turnId: 't1' }, outcome: 'completed', commitState: 'committed',
      });
      const entry = handle.getSnapshot().panes['node:n1'];
      expect(entry?.status).toBe('loading');
      expect(entry?.descriptor).toBeNull();
      // executionStatus is still authoritative even while the pane is otherwise loading.
      expect(entry?.executionStatus).toBe('completed');
      handle.detach();
    });

    it('output_changed after a real snapshot keeps status ready (regression guard for fix 3)', () => {
      const handle = attach(BASE, ['node:n1']);
      handlersByCallIndex[0].onEvent(snapshotEvent('node:n1', 'c1'));
      handlersByCallIndex[0].onEvent({
        version: 1, type: 'output_changed', paneId: 'node:n1', cursor: 'c2', emittedAt: 2_000,
        outputId: 'o1', outputRevision: 'r1',
        preview: { outputId: 'o1', execution: null, kind: 'answer', text: 'partial', outputRevision: 'r1', updatedAt: 2_000, partial: true, truncated: false },
      });
      expect(handle.getSnapshot().panes['node:n1']?.status).toBe('ready');
      handle.detach();
    });
  });

  describe('identical repeated feed errors do not create a new snapshot/notification (P3-6 fix 6)', () => {
    it('the same error code+message reported twice notifies only once and keeps the same error object', () => {
      const handle = attach(BASE, ['node:n1']);
      const cb = vi.fn();
      handle.subscribe(cb);
      handlersByCallIndex[0].onError?.(new PaneInspectionClientError('RATE_LIMITED', 'too many'));
      const snapAfterFirst = handle.getSnapshot();
      handlersByCallIndex[0].onError?.(new PaneInspectionClientError('RATE_LIMITED', 'too many'));
      const snapAfterSecond = handle.getSnapshot();
      expect(cb).toHaveBeenCalledTimes(1);
      expect(snapAfterSecond).toBe(snapAfterFirst);
      handle.detach();
    });
  });

  describe('non-ready states require a fresh snapshot before incremental events apply', () => {
    it.each(['removed', 'access_revoked', 'resync_required'] as const)(
      '%s is not reactivated by late output or settlement events',
      (boundaryType) => {
        const handle = attach(BASE, ['node:n1']);
        handlersByCallIndex[0].onEvent(snapshotEvent('node:n1', 'c1', {
          execution: {
            status: 'ready',
            value: {
              ref: { kind: 'chat_turn', nodeId: 'n1', turnId: 't1' },
              assistantId: null,
              attemptId: null,
              attemptIndex: null,
              status: 'running',
              startedAt: 1,
              endedAt: null,
              commitState: 'pending',
              waitingReason: null,
              error: null,
            },
          },
        }));
        handlersByCallIndex[0].onEvent({
          version: 1,
          type: boundaryType,
          paneId: 'node:n1',
          cursor: 'c2',
          emittedAt: 2_000,
        });

        const boundarySnapshot = handle.getSnapshot();
        expect(boundarySnapshot.panes['node:n1']?.status).toBe(boundaryType);
        expect(selectPaneExecutionStatus(boundarySnapshot, 'node:n1')).toBe('unknown');

        handlersByCallIndex[0].onEvent({
          version: 1,
          type: 'output_changed',
          paneId: 'node:n1',
          cursor: 'c3',
          emittedAt: 3_000,
          outputId: 'o1',
          outputRevision: 'r2',
          preview: {
            outputId: 'o1',
            execution: null,
            kind: 'answer',
            text: 'late output',
            outputRevision: 'r2',
            updatedAt: 3_000,
            partial: false,
            truncated: false,
          },
        });
        handlersByCallIndex[0].onEvent({
          version: 1,
          type: 'execution_settled',
          paneId: 'node:n1',
          cursor: 'c4',
          emittedAt: 4_000,
          execution: { kind: 'chat_turn', nodeId: 'n1', turnId: 't1' },
          outcome: 'completed',
          commitState: 'committed',
        });

        expect(handle.getSnapshot()).toBe(boundarySnapshot);
        handle.detach();
      },
    );
  });
});
