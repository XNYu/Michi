import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { closeDb, getDb, initDb } from '../src/services/db';
import { getNode, saveNode, saveTree, saveWorkspace } from '../src/services/dbRepository';
import { decodePaneId, encodePaneId, PaneInspectionError } from 'michi-shared';
import {
  MAX_SURFACE_REGISTRATIONS_PER_SCOPE,
  PanePresenceRegistry,
  resolvePresenceOwnerUserId,
  type PresenceCaller,
} from '../src/services/panePresence';
import type { AgentRunsRepository } from '../src/services/agentRunsRepository';

const OWNER = 'local-user';
const WORKSPACE_ID = 'ws-1';
const OTHER_WORKSPACE_ID = 'ws-2';

function seedWorkspace(id: string, ownerUserId: string | null = null): void {
  saveWorkspace({
    id,
    name: 'Workspace',
    created_at: 1,
    updated_at: 1,
    active_tree_id: null,
    cwd: null,
    settings: null,
    owner_user_id: ownerUserId,
  });
}

function seedNode(nodeId: string, workspaceId: string): void {
  saveTree({
    id: `${nodeId}-tree`,
    workspace_id: workspaceId,
    root_node_id: nodeId,
    name: null,
    archived_at: null,
    pinned_at: null,
    last_active_at: 1,
    created_at: 1,
  });
  saveNode({
    id: nodeId,
    workspace_id: workspaceId,
    tree_id: `${nodeId}-tree`,
    parent_node_id: null,
    kind: 'chat',
    title: null,
    branch_overview: null,
    status: 'idle',
    position_x: null,
    position_y: null,
    minimized: 0,
    deleted_at: null,
    deletion_group_id: null,
    spawned_by_agent: 0,
    current_mode_id: null,
    pane_width: null,
    digest: null,
    follow_ups: null,
    follow_ups_source_message_id: null,
    acp_session_id: null,
    runtime_id: null,
    provider_id: null,
    model_id: null,
    reasoning: null,
    resume_fingerprint: null,
    composer_draft: null,
    external_session_id: null,
    trim_snapshot: null,
    created_at: 1,
  });
}

/** Fake AgentRunsRepository — panePresence only ever calls getRun(ownerUserId, runId). */
function fakeRuns(runs: Record<string, { workspaceId: string; ownerUserId: string }>): AgentRunsRepository {
  return {
    getRun(ownerUserId: string, runId: string) {
      const run = runs[runId];
      if (!run || run.ownerUserId !== ownerUserId) return null;
      return { workspaceId: run.workspaceId } as unknown as ReturnType<AgentRunsRepository['getRun']>;
    },
  } as unknown as AgentRunsRepository;
}

let tmpDir: string;
let clockNow = 0;
const clock = () => clockNow;

function freshRegistry(runs: AgentRunsRepository = fakeRuns({})): PanePresenceRegistry {
  return new PanePresenceRegistry(runs, { now: clock });
}

function caller(overrides: Partial<PresenceCaller> = {}): PresenceCaller {
  return { ownerUserId: OWNER, workspaceId: WORKSPACE_ID, connectionId: 'conn-1', ...overrides };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-pane-presence-'));
  process.env.MICHI_DATA_DIR = tmpDir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  seedWorkspace(WORKSPACE_ID);
  seedWorkspace(OTHER_WORKSPACE_ID);
  seedNode('node-1', WORKSPACE_ID);
  seedNode('node-other-ws', OTHER_WORKSPACE_ID);
  clockNow = 0;
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('panePresence: lease allocation and identity', () => {
  test('first PUT allocates a lease; a second window for the same pane gets a different lease and both views appear', () => {
    const registry = freshRegistry();
    const paneId = encodePaneId({ kind: 'node', nodeId: 'node-1' });

    const first = registry.submitPresence(caller(), {
      viewRevision: 1,
      windowId: 'window-a',
      views: [{ paneId, windowId: 'window-a', uiPaneId: 'ui-1', treeId: 'node-1-tree', visible: true, openedAtClient: 100 }],
    });
    assert.equal(first.ok, true);
    const leaseA = first.ok ? first.rendererLeaseId : '';
    assert.ok(leaseA.length > 0);

    const second = registry.submitPresence(caller(), {
      viewRevision: 1,
      windowId: 'window-b',
      views: [{ paneId, windowId: 'window-b', uiPaneId: 'ui-2', treeId: 'node-1-tree', visible: true, openedAtClient: 200 }],
    });
    assert.equal(second.ok, true);
    const leaseB = second.ok ? second.rendererLeaseId : '';
    assert.notEqual(leaseA, leaseB);

    const presence = registry.getPresence({ kind: 'node', nodeId: 'node-1' });
    assert.equal(presence.coverage, 'reported');
    assert.equal(presence.views.length, 2);
    const windowIds = presence.views.map((v) => v.windowId).sort();
    assert.deepEqual(windowIds, ['window-a', 'window-b']);
  });

  test('windowId cannot be used to modify another window\'s registration', () => {
    const registry = freshRegistry();
    const paneId = encodePaneId({ kind: 'node', nodeId: 'node-1' });

    const first = registry.submitPresence(caller(), {
      viewRevision: 1,
      windowId: 'window-a',
      views: [{ paneId, windowId: 'window-a', uiPaneId: 'ui-1', treeId: null, visible: true, openedAtClient: null }],
    });
    assert.equal(first.ok, true);
    const leaseA = (first as { rendererLeaseId: string }).rendererLeaseId;

    // Attacker/buggy renderer reuses window-a's lease id but claims to be window-b.
    const spoofed = registry.submitPresence(caller(), {
      rendererLeaseId: leaseA,
      viewRevision: 2,
      windowId: 'window-b',
      views: [{ paneId, windowId: 'window-b', uiPaneId: 'ui-hacked', treeId: null, visible: true, openedAtClient: null }],
    });
    assert.equal(spoofed.ok, false);
    assert.equal((spoofed as { code: string }).code, 'WRONG_WINDOW');

    // window-a's own registration must be untouched.
    const presence = registry.getPresence({ kind: 'node', nodeId: 'node-1' });
    assert.equal(presence.views.length, 1);
    assert.equal(presence.views[0].uiPaneId, 'ui-1');
  });

  test('a lease bound to a different owner/workspace/connection is rejected as WRONG_WINDOW', () => {
    const registry = freshRegistry();
    const paneId = encodePaneId({ kind: 'node', nodeId: 'node-1' });
    const first = registry.submitPresence(caller(), {
      viewRevision: 1,
      windowId: 'window-a',
      views: [{ paneId, windowId: 'window-a', uiPaneId: 'ui-1', treeId: null, visible: true, openedAtClient: null }],
    });
    const leaseA = (first as { rendererLeaseId: string }).rendererLeaseId;

    const result = registry.submitPresence(caller({ connectionId: 'conn-2' }), {
      rendererLeaseId: leaseA,
      viewRevision: 2,
      windowId: 'window-a',
      views: [],
    });
    assert.equal(result.ok, false);
    assert.equal((result as { code: string }).code, 'WRONG_WINDOW');
  });
});

describe('panePresence: viewRevision monotonicity', () => {
  test('a stale/equal viewRevision is rejected and does not mutate stored state', () => {
    const registry = freshRegistry();
    const paneId = encodePaneId({ kind: 'node', nodeId: 'node-1' });
    const first = registry.submitPresence(caller(), {
      viewRevision: 5,
      windowId: 'window-a',
      views: [{ paneId, windowId: 'window-a', uiPaneId: 'ui-1', treeId: null, visible: true, openedAtClient: null }],
    });
    const leaseA = (first as { rendererLeaseId: string }).rendererLeaseId;

    const equalRevision = registry.submitPresence(caller(), {
      rendererLeaseId: leaseA,
      viewRevision: 5,
      windowId: 'window-a',
      views: [{ paneId, windowId: 'window-a', uiPaneId: 'ui-CORRUPTED', treeId: null, visible: false, openedAtClient: null }],
    });
    assert.equal(equalRevision.ok, false);
    assert.equal((equalRevision as { code: string }).code, 'STALE_REVISION');

    const staleRevision = registry.submitPresence(caller(), {
      rendererLeaseId: leaseA,
      viewRevision: 3,
      windowId: 'window-a',
      views: [{ paneId, windowId: 'window-a', uiPaneId: 'ui-CORRUPTED-2', treeId: null, visible: false, openedAtClient: null }],
    });
    assert.equal(staleRevision.ok, false);
    assert.equal((staleRevision as { code: string }).code, 'STALE_REVISION');

    const presence = registry.getPresence({ kind: 'node', nodeId: 'node-1' });
    assert.equal(presence.views.length, 1);
    assert.equal(presence.views[0].uiPaneId, 'ui-1');
    assert.equal(presence.views[0].visible, true);
  });
});

describe('panePresence: TTL and expiry', () => {
  test('keepalive renews; crossing the 60s expiry marks the view expired, not closed', () => {
    const registry = freshRegistry();
    const paneId = encodePaneId({ kind: 'node', nodeId: 'node-1' });
    const first = registry.submitPresence(caller(), {
      viewRevision: 1,
      windowId: 'window-a',
      views: [{ paneId, windowId: 'window-a', uiPaneId: 'ui-1', treeId: null, visible: true, openedAtClient: null }],
    });
    const leaseA = (first as { rendererLeaseId: string }).rendererLeaseId;

    clockNow += 20_000;
    const keepalive1 = registry.keepalive(caller(), { rendererLeaseId: leaseA });
    assert.equal(keepalive1.ok, true);

    clockNow += 20_000;
    const keepalive2 = registry.keepalive(caller(), { rendererLeaseId: leaseA });
    assert.equal(keepalive2.ok, true);

    // 40s elapsed total, under the 60s TTL — still live.
    assert.equal(registry.hasLiveLease(leaseA), true);
    assert.equal(registry.getPresence({ kind: 'node', nodeId: 'node-1' }).coverage, 'reported');

    // Cross 60s past the LAST keepalive with no further renewal.
    clockNow += 61_000;
    assert.equal(registry.hasLiveLease(leaseA), false);

    const presence = registry.getPresence({ kind: 'node', nodeId: 'node-1' });
    // Expired -> unknown, never "closed" (there is no separate closed/removed signal here; the
    // key acceptance property is that expiry does NOT surface as coverage: 'reported' with an
    // explicit closed marker asserting the user ended anything).
    assert.equal(presence.coverage, 'unknown');
    assert.equal(presence.views.length, 0);
  });

  test('an expired view leaves a tombstone, and the tombstone is released later', () => {
    const registry = freshRegistry();
    const paneId = encodePaneId({ kind: 'node', nodeId: 'node-1' });
    const first = registry.submitPresence(caller(), {
      viewRevision: 1,
      windowId: 'window-a',
      views: [{ paneId, windowId: 'window-a', uiPaneId: 'ui-1', treeId: null, visible: true, openedAtClient: null }],
    });
    const leaseA = (first as { rendererLeaseId: string }).rendererLeaseId;

    clockNow += 61_000; // past TTL, no keepalive
    assert.equal(registry.hasLiveLease(leaseA), false);
    assert.equal(registry.hasTombstone(leaseA), true);

    // Tombstone retention defaults to the keepalive interval (20s).
    clockNow += 21_000;
    assert.equal(registry.hasTombstone(leaseA), false);
  });
});

describe('panePresence: empty-snapshot protection', () => {
  test('an empty snapshot from a renderer does NOT erase existing views', () => {
    const registry = freshRegistry();
    const paneId = encodePaneId({ kind: 'node', nodeId: 'node-1' });
    const first = registry.submitPresence(caller(), {
      viewRevision: 1,
      windowId: 'window-a',
      views: [{ paneId, windowId: 'window-a', uiPaneId: 'ui-1', treeId: null, visible: true, openedAtClient: null }],
    });
    const leaseA = (first as { rendererLeaseId: string }).rendererLeaseId;
    assert.equal(first.ok, true);

    const emptySubmission = registry.submitPresence(caller(), {
      rendererLeaseId: leaseA,
      viewRevision: 2,
      windowId: 'window-a',
      views: [],
    });
    assert.equal(emptySubmission.ok, false);
    assert.equal((emptySubmission as { code: string }).code, 'EMPTY_SNAPSHOT_IGNORED');

    // Views must still be present, AND the lease's revision must not have advanced — so the
    // renderer's next real submission (at revision 2 or later) is not rejected as stale.
    const presence = registry.getPresence({ kind: 'node', nodeId: 'node-1' });
    assert.equal(presence.views.length, 1);

    const recover = registry.submitPresence(caller(), {
      rendererLeaseId: leaseA,
      viewRevision: 2,
      windowId: 'window-a',
      views: [{ paneId, windowId: 'window-a', uiPaneId: 'ui-1-recovered', treeId: null, visible: true, openedAtClient: null }],
    });
    assert.equal(recover.ok, true);
  });

  test('a genuinely new lease may legitimately start empty (freshly opened window)', () => {
    const registry = freshRegistry();
    const result = registry.submitPresence(caller(), {
      viewRevision: 1,
      windowId: 'window-a',
      views: [],
    });
    assert.equal(result.ok, true);
  });
});

describe('panePresence: server-side ownership validation', () => {
  test('a nodeId belonging to a different workspace/owner is rejected', () => {
    const registry = freshRegistry();
    const paneId = encodePaneId({ kind: 'node', nodeId: 'node-other-ws' });
    const result = registry.submitPresence(caller(), {
      viewRevision: 1,
      windowId: 'window-a',
      views: [{ paneId, windowId: 'window-a', uiPaneId: 'ui-1', treeId: null, visible: true, openedAtClient: null }],
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.accepted, 0);
      assert.equal(result.rejectedTargets.length, 1);
      assert.equal(result.rejectedTargets[0].paneId, paneId);
      assert.equal(result.rejectedTargets[0].reason, 'NOT_FOUND');
    }
    assert.equal(registry.getPresence({ kind: 'node', nodeId: 'node-other-ws' }).coverage, 'unknown');
  });

  test('a runId not owned by the caller is rejected; one owned by the caller is accepted', () => {
    const runs = fakeRuns({
      'run-mine': { workspaceId: WORKSPACE_ID, ownerUserId: OWNER },
      'run-not-mine': { workspaceId: WORKSPACE_ID, ownerUserId: 'someone-else' },
    });
    const registry = freshRegistry(runs);
    const mine = encodePaneId({ kind: 'agent_run', runId: 'run-mine' });
    const notMine = encodePaneId({ kind: 'agent_run', runId: 'run-not-mine' });

    const result = registry.submitPresence(caller(), {
      viewRevision: 1,
      windowId: 'window-a',
      views: [
        { paneId: mine, windowId: 'window-a', uiPaneId: 'ui-1', treeId: null, visible: true, openedAtClient: null },
        { paneId: notMine, windowId: 'window-a', uiPaneId: 'ui-2', treeId: null, visible: true, openedAtClient: null },
      ],
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.accepted, 1);
      assert.equal(result.rejectedTargets.length, 1);
      assert.equal(result.rejectedTargets[0].paneId, notMine);
    }
    assert.equal(registry.getPresence({ kind: 'agent_run', runId: 'run-mine' }).coverage, 'reported');
    assert.equal(registry.getPresence({ kind: 'agent_run', runId: 'run-not-mine' }).coverage, 'unknown');
  });

  test('a run owned by the caller but scoped to a different workspace is rejected', () => {
    const runs = fakeRuns({ 'run-x': { workspaceId: OTHER_WORKSPACE_ID, ownerUserId: OWNER } });
    const registry = freshRegistry(runs);
    const paneId = encodePaneId({ kind: 'agent_run', runId: 'run-x' });
    const result = registry.submitPresence(caller(), {
      viewRevision: 1,
      windowId: 'window-a',
      views: [{ paneId, windowId: 'window-a', uiPaneId: 'ui-1', treeId: null, visible: true, openedAtClient: null }],
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.accepted, 0);
  });
});

describe('panePresence: surface registrations', () => {
  test('a surface registration produces a surface:{registrationId} paneId that round-trips through decodePaneId', () => {
    const registry = freshRegistry();
    const { registrationId, paneId } = registry.allocateSurfaceRegistration(caller(), 'terminal');
    assert.equal(paneId, `surface:${registrationId}`);
    const decoded = decodePaneId(paneId);
    assert.deepEqual(decoded, { kind: 'surface', registrationId });

    const result = registry.submitPresence(caller(), {
      viewRevision: 1,
      windowId: 'window-a',
      views: [{ paneId, windowId: 'window-a', uiPaneId: 'ui-terminal', treeId: null, visible: true, openedAtClient: null, surfaceTitle: 'my terminal' }],
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.accepted, 1);
    assert.equal(registry.getPresence({ kind: 'surface', registrationId }).coverage, 'reported');
  });

  test('submitting a fabricated registrationId is rejected as NOT_FOUND (not accepted)', () => {
    const registry = freshRegistry();
    const paneId = `surface:${randomUUID()}`;
    const result = registry.submitPresence(caller(), {
      viewRevision: 1,
      windowId: 'window-a',
      views: [{ paneId, windowId: 'window-a', uiPaneId: 'ui-fake', treeId: null, visible: true, openedAtClient: null }],
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.accepted, 0);
      assert.equal(result.rejectedTargets.length, 1);
      assert.equal(result.rejectedTargets[0].reason, 'NOT_FOUND');
    }
  });

  test('a registration bound to a different owner/workspace/connection is rejected as NOT_FOUND', () => {
    const registry = freshRegistry();
    const { paneId } = registry.allocateSurfaceRegistration(caller(), 'terminal');

    const byOtherOwner = registry.submitPresence(caller({ ownerUserId: 'other-owner' }), {
      viewRevision: 1,
      windowId: 'window-a',
      views: [{ paneId, windowId: 'window-a', uiPaneId: 'ui-1', treeId: null, visible: true, openedAtClient: null }],
    });
    assert.equal(byOtherOwner.ok, true);
    if (byOtherOwner.ok) assert.equal(byOtherOwner.accepted, 0);

    const byOtherWorkspace = registry.submitPresence(caller({ workspaceId: OTHER_WORKSPACE_ID }), {
      viewRevision: 1,
      windowId: 'window-a',
      views: [{ paneId, windowId: 'window-a', uiPaneId: 'ui-1', treeId: null, visible: true, openedAtClient: null }],
    });
    assert.equal(byOtherWorkspace.ok, true);
    if (byOtherWorkspace.ok) assert.equal(byOtherWorkspace.accepted, 0);

    const byOtherConnection = registry.submitPresence(caller({ connectionId: 'conn-other' }), {
      viewRevision: 1,
      windowId: 'window-a',
      views: [{ paneId, windowId: 'window-a', uiPaneId: 'ui-1', treeId: null, visible: true, openedAtClient: null }],
    });
    assert.equal(byOtherConnection.ok, true);
    if (byOtherConnection.ok) assert.equal(byOtherConnection.accepted, 0);

    // The owning caller can still submit it successfully.
    const byOwner = registry.submitPresence(caller(), {
      viewRevision: 1,
      windowId: 'window-a',
      views: [{ paneId, windowId: 'window-a', uiPaneId: 'ui-1', treeId: null, visible: true, openedAtClient: null }],
    });
    assert.equal(byOwner.ok, true);
    if (byOwner.ok) assert.equal(byOwner.accepted, 1);
  });

  test('an unclaimed registration is swept once older than the presence TTL', () => {
    const registry = freshRegistry();
    const { registrationId, paneId } = registry.allocateSurfaceRegistration(caller(), 'terminal');
    assert.equal(registry.hasRegistration(registrationId), true);

    clockNow += 61_000; // past the 60s TTL, still never submitted to presence.
    assert.equal(registry.hasRegistration(registrationId), false);

    // Confirms it is genuinely gone, not just untracked by the diagnostic helper: submitting it
    // now behaves exactly like a fabricated id.
    const result = registry.submitPresence(caller(), {
      viewRevision: 1,
      windowId: 'window-a',
      views: [{ paneId, windowId: 'window-a', uiPaneId: 'ui-1', treeId: null, visible: true, openedAtClient: null }],
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.accepted, 0);
  });

  test('a claimed registration survives past the allocation TTL as long as its lease stays alive', () => {
    const registry = freshRegistry();
    const { registrationId, paneId } = registry.allocateSurfaceRegistration(caller(), 'terminal');

    const submitted = registry.submitPresence(caller(), {
      viewRevision: 1,
      windowId: 'window-a',
      views: [{ paneId, windowId: 'window-a', uiPaneId: 'ui-terminal', treeId: null, visible: true, openedAtClient: null }],
    });
    assert.equal(submitted.ok, true);
    const leaseA = (submitted as { rendererLeaseId: string }).rendererLeaseId;

    // Past the registration's own allocation TTL, but the lease has been kept alive throughout.
    clockNow += 30_000;
    registry.keepalive(caller(), { rendererLeaseId: leaseA });
    clockNow += 30_000;
    registry.keepalive(caller(), { rendererLeaseId: leaseA });
    clockNow += 30_000; // 90s since allocation; well past ttlMs (60s).

    assert.equal(registry.hasRegistration(registrationId), true);
    assert.equal(registry.getPresence({ kind: 'surface', registrationId }).coverage, 'reported');
  });

  test('allocation refuses once a caller scope holds the per-scope cap, and does not affect another scope', () => {
    const registry = freshRegistry();
    for (let i = 0; i < MAX_SURFACE_REGISTRATIONS_PER_SCOPE; i += 1) {
      registry.allocateSurfaceRegistration(caller(), 'terminal');
    }

    assert.throws(
      () => registry.allocateSurfaceRegistration(caller(), 'terminal'),
      (err: unknown) => {
        assert.ok(err instanceof PaneInspectionError);
        assert.equal((err as PaneInspectionError).code, 'RATE_LIMITED');
        return true;
      },
    );

    // A different connection (different scope) is entirely unaffected by the first scope's cap.
    const other = registry.allocateSurfaceRegistration(caller({ connectionId: 'conn-other' }), 'terminal');
    assert.ok(other.registrationId.length > 0);

    // A different workspace is likewise unaffected.
    const otherWs = registry.allocateSurfaceRegistration(caller({ workspaceId: OTHER_WORKSPACE_ID }), 'terminal');
    assert.ok(otherWs.registrationId.length > 0);
  });

  test('sweeping an unclaimed registration below the cap allows allocation to succeed again', () => {
    const registry = freshRegistry();
    for (let i = 0; i < MAX_SURFACE_REGISTRATIONS_PER_SCOPE; i += 1) {
      registry.allocateSurfaceRegistration(caller(), 'terminal');
    }
    assert.throws(() => registry.allocateSurfaceRegistration(caller(), 'terminal'));

    clockNow += 61_000; // past ttlMs — every prior registration was unclaimed and is now swept.
    const result = registry.allocateSurfaceRegistration(caller(), 'terminal');
    assert.ok(result.registrationId.length > 0);
  });
});

describe('panePresence: coverage semantics', () => {
  test('coverage is unknown when nothing is registered, reported when something is', () => {
    const registry = freshRegistry();
    assert.equal(registry.getPresence({ kind: 'node', nodeId: 'node-1' }).coverage, 'unknown');

    const paneId = encodePaneId({ kind: 'node', nodeId: 'node-1' });
    registry.submitPresence(caller(), {
      viewRevision: 1,
      windowId: 'window-a',
      views: [{ paneId, windowId: 'window-a', uiPaneId: 'ui-1', treeId: null, visible: true, openedAtClient: null }],
    });
    assert.equal(registry.getPresence({ kind: 'node', nodeId: 'node-1' }).coverage, 'reported');
  });
});

describe('panePresence: DELETE performs no cancellation', () => {
  test('DELETE removes the view and performs no cancellation of any kind', () => {
    const registry = freshRegistry();
    const paneId = encodePaneId({ kind: 'node', nodeId: 'node-1' });
    const first = registry.submitPresence(caller(), {
      viewRevision: 1,
      windowId: 'window-a',
      views: [{ paneId, windowId: 'window-a', uiPaneId: 'ui-1', treeId: null, visible: true, openedAtClient: null }],
    });
    const leaseA = (first as { rendererLeaseId: string }).rendererLeaseId;

    const removed = registry.removePresence(caller(), { rendererLeaseId: leaseA, paneIds: [paneId] });
    assert.equal(removed.ok, true);
    if (removed.ok) assert.equal(removed.removed, 1);

    assert.equal(registry.getPresence({ kind: 'node', nodeId: 'node-1' }).coverage, 'unknown');

    // The node itself is completely untouched by this call — panePresence never writes to
    // dbRepository, never touches ChatHub, never calls anything cancel-shaped. Assert the
    // underlying node row is unaffected as the closest available proxy for "no side effects on
    // the object this pane represents".
    const node = getNode('node-1');
    assert.ok(node);
    assert.equal(node?.status, 'idle');
  });

  test('removePresence with no paneIds removes the whole lease (e.g. window close)', () => {
    const registry = freshRegistry();
    const paneIdA = encodePaneId({ kind: 'node', nodeId: 'node-1' });
    const first = registry.submitPresence(caller(), {
      viewRevision: 1,
      windowId: 'window-a',
      views: [{ paneId: paneIdA, windowId: 'window-a', uiPaneId: 'ui-1', treeId: null, visible: true, openedAtClient: null }],
    });
    const leaseA = (first as { rendererLeaseId: string }).rendererLeaseId;

    const removed = registry.removePresence(caller(), { rendererLeaseId: leaseA });
    assert.equal(removed.ok, true);
    if (removed.ok) assert.equal(removed.removed, 1);
    assert.equal(registry.hasLiveLease(leaseA), false);
  });
});

describe('resolvePresenceOwnerUserId', () => {
  test('desktop mode returns the fixed local owner id regardless of req.user', () => {
    const original = process.env.MICHI_CLOUD;
    delete process.env.MICHI_CLOUD;
    try {
      assert.equal(resolvePresenceOwnerUserId(undefined), 'local-user');
      assert.equal(resolvePresenceOwnerUserId('someone'), 'local-user');
    } finally {
      if (original !== undefined) process.env.MICHI_CLOUD = original;
    }
  });

  test('cloud mode returns req.user.id, or empty string when absent', () => {
    const original = process.env.MICHI_CLOUD;
    process.env.MICHI_CLOUD = '1';
    try {
      assert.equal(resolvePresenceOwnerUserId('alice'), 'alice');
      assert.equal(resolvePresenceOwnerUserId(undefined), '');
    } finally {
      if (original === undefined) delete process.env.MICHI_CLOUD;
      else process.env.MICHI_CLOUD = original;
    }
  });
});
