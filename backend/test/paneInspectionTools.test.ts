/**
 * paneInspectionTools.test.ts — P3-5b: `waitPaneTool`'s own layer (arg shaping, identity
 * binding, INVALID_ARGUMENT surfacing, rendering). `waitPane` itself (the service P3-5 built —
 * check→subscribe→check race, terminal/changed semantics, rate limiting, timeout) is already
 * fully covered by `paneInspectionWait.test.ts`; this file does not re-test that.
 *
 * Reuses this codebase's established monkeypatch convention for a PaneFeed/waitPane-consuming
 * test (paneInspectionSubscribe.test.ts / paneInspectionWait.test.ts's own `stubService`): stub
 * `paneInspectionModule.inspect` and `.authorizeCaller` at the module level, since `waitPane`
 * imports both directly rather than taking them as constructor deps.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import type { ExecutionRef, PaneDescriptorV1, PaneTarget } from 'michi-shared';

import * as paneInspectionModule from '../src/services/paneInspection';
import type { PaneInspectionCaller } from '../src/services/paneInspection';
import { PaneInspectionRing } from '../src/services/paneInspectionRing';
import * as paneInspectionRingModule from '../src/services/paneInspectionRing';
import { waitPaneTool, type PaneInspectionToolBinding } from '../src/agents/paneInspectionTools';

// ---------------------------------------------------------------------------
// Fake inspect()/authorizeCaller() — same convention as paneInspectionWait.test.ts.
// ---------------------------------------------------------------------------

let inspectImpl: (caller: PaneInspectionCaller, input: unknown) => PaneDescriptorV1 = () => {
  throw new Error('inspectImpl not configured for this test');
};
let authorizeImpl: (caller: PaneInspectionCaller, target: PaneTarget) => void = () => {};

const originalInspect = paneInspectionModule.inspect;
const originalAuthorize = paneInspectionModule.authorizeCaller;

function stubService(): void {
  (paneInspectionModule as unknown as Record<string, unknown>).inspect = (caller: PaneInspectionCaller, input: unknown) => inspectImpl(caller, input);
  (paneInspectionModule as unknown as Record<string, unknown>).authorizeCaller = (caller: PaneInspectionCaller, target: PaneTarget) => authorizeImpl(caller, target);
}

afterEach(() => {
  (paneInspectionModule as unknown as Record<string, unknown>).inspect = originalInspect;
  (paneInspectionModule as unknown as Record<string, unknown>).authorizeCaller = originalAuthorize;
  inspectImpl = () => { throw new Error('inspectImpl not configured for this test'); };
  authorizeImpl = () => {};
  // Fresh ring per test — waitPane mints/resolves cursors against the module-level singleton.
  Object.assign(paneInspectionRingModule.paneInspectionRing, new PaneInspectionRing({ now: () => 0 }));
});

function baseDescriptor(overrides: Partial<PaneDescriptorV1> = {}): PaneDescriptorV1 {
  return {
    version: 1,
    ref: { backendConnectionId: 'local', paneId: 'node:n-1' },
    target: { kind: 'node', nodeId: 'n-1' },
    kind: 'chat',
    title: 'Sample',
    workspaceId: 'ws-1',
    treeId: null,
    archived: false,
    truncatedFields: [],
    observation: { observedAt: 0, freshness: 'live', cursor: 'ignored' },
    capabilities: { readOutput: true, subscribe: true, waitForTerminal: true },
    activity: 'idle',
    execution: { status: 'ready', value: null },
    timeline: { resourceCreatedAt: 0, firstExecutionStartedAt: null },
    presence: { coverage: 'unknown', views: [] },
    conversation: { status: 'ready', value: { messageCount: 1, userMessageCount: 1, assistantMessageCount: 0, completedTurnCount: 0, turnHistoryCoverage: 'complete' } },
    lineage: { status: 'ready', value: { parentNodeId: null, parentRunId: null, originMessageId: null, treeRootNodeId: 'n-1', childNodeIds: [], childrenTruncated: false } },
    runtime: { status: 'ready', value: { runtimeId: null, modelId: null, providerId: null, contextUsagePercentage: null } },
    latestOutput: { status: 'ready', value: null },
    ...overrides,
  };
}

const BINDING: PaneInspectionToolBinding = {
  ownerUserId: 'owner-a',
  workspaceId: 'ws-1',
  backendConnectionId: 'slot-1',
};

const EXECUTION_REF: ExecutionRef = { kind: 'chat_turn', nodeId: 'n-1', turnId: 't-1' };

// ---------------------------------------------------------------------------
// Commit #1's case: a stale cursor returns `changed` immediately, rendered correctly, with the
// caller built from the BINDING rather than any tool argument.
// ---------------------------------------------------------------------------

describe('waitPaneTool — until: changed', () => {
  test('a stale cursor returns reason=changed immediately and renders the result', async () => {
    stubService();
    let seenCaller: PaneInspectionCaller | null = null;
    authorizeImpl = (caller) => { seenCaller = caller; };
    const scope = { ownerUserId: BINDING.ownerUserId!, workspaceId: BINDING.workspaceId!, runOwnerId: null };
    const contentOf = (d: PaneDescriptorV1) => { const { observation, presence, ...rest } = d; return { ...rest, observation: { freshness: observation.freshness }, presence }; };
    const oldDescriptor = baseDescriptor({ title: 'Sample' });
    const newDescriptor = baseDescriptor({ title: 'Renamed' });

    const staleCursor = paneInspectionRingModule.paneInspectionRing.mintInspectionCursor('node:n-1', scope, contentOf(oldDescriptor));
    paneInspectionRingModule.paneInspectionRing.recordContentChange('node:n-1', scope, contentOf(newDescriptor), { kind: 'changed', payload: {}, sizeBytes: 1 });
    inspectImpl = () => newDescriptor;

    const result = await waitPaneTool(BINDING, {
      nodeId: 'n-1',
      until: 'changed',
      cursor: staleCursor,
      // A model-supplied identity override has nowhere to go — WaitPaneToolArgs has no such
      // field — so this is here only to document the invariant, mirroring
      // mcpServerAgentRunOwner.test.ts's own "ignores caller-identity override attempts" cases.
    });

    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.match(text, /^reason: changed$/m);
    assert.match(text, /^outcome: \(none\)$/m);
    assert.match(text, /title: Renamed/);
    assert.equal((seenCaller as PaneInspectionCaller | null)?.ownerUserId, BINDING.ownerUserId);
    assert.equal((seenCaller as PaneInspectionCaller | null)?.workspaceId, BINDING.workspaceId);
  });
});
