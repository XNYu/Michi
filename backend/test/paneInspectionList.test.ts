/**
 * Tests for `list()` — the acceptance criteria from the P2-4c brief (design §7.1).
 *
 * Fixture pattern copied from `paneInspection.test.ts`: fresh temp-SQLite `MICHI_DATA_DIR` per
 * test, desktop-mode caller identity via `LOCAL_AGENT_OWNER_ID`. The shared
 * `panePresenceRegistry` singleton is used directly for `scope=open`/surface coverage, matching
 * `list()`'s own import (see paneInspectionList.ts's module doc comment on why there is exactly
 * one registry instance).
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AgentPolicyCategory,
  AgentPolicyDecision,
  PaneInspectionError,
  type EffectiveAgentDefinitionV1,
} from 'michi-shared';
import { closeDb, initDb, getDb } from '../src/services/db';
import {
  saveNode,
  saveTree,
  saveWorkspace,
  setAiGlobalContext,
  type NodeRow,
} from '../src/services/dbRepository';
import { AgentRunsRepository } from '../src/services/agentRunsRepository';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { list } from '../src/services/paneInspectionList';
import { type PaneInspectionCaller } from '../src/services/paneInspection';
import { panePresenceRegistry } from '../src/services/panePresence';
import type { ListPanesRequestV1 } from 'michi-shared';

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'michi-pane-inspection-list-'));
}

// Desktop-mode fixtures: saveWorkspace() leaves owner_user_id NULL (no MICHI_CLOUD set for these
// tests), so the caller's ownerUserId must be the fixed desktop identity — see
// paneInspection.test.ts's identical comment.
const OWNER = LOCAL_AGENT_OWNER_ID;
const WORKSPACE = 'ws-1';

function caller(overrides: Partial<PaneInspectionCaller> = {}): PaneInspectionCaller {
  return {
    ownerUserId: OWNER,
    workspaceId: WORKSPACE,
    backendConnectionId: 'conn-1',
    ...overrides,
  };
}

function seedTree(id: string, rootNodeId: string): void {
  saveTree({
    id, workspace_id: WORKSPACE, root_node_id: rootNodeId,
    name: null, archived_at: null, pinned_at: null, last_active_at: 1, created_at: 1,
  });
}

function seedWorkspace(id = WORKSPACE): void {
  saveWorkspace({
    id, name: 'Workspace', created_at: 1, updated_at: 1,
    active_tree_id: null, cwd: null, settings: null,
    deleted_at: null, archived_at: null,
  });
}

interface NodeOpts {
  parentNodeId?: string | null;
  treeId?: string | null;
  status?: string;
  kind?: string;
  title?: string | null;
  createdAt?: number;
}

function seedNode(id: string, opts: NodeOpts = {}): NodeRow {
  const row: NodeRow = {
    id, workspace_id: WORKSPACE,
    tree_id: opts.treeId ?? null,
    parent_node_id: opts.parentNodeId ?? null,
    kind: opts.kind ?? 'chat', title: opts.title ?? null, branch_overview: null,
    status: opts.status ?? 'idle',
    position_x: null, position_y: null, minimized: 0, deleted_at: null,
    deletion_group_id: null, spawned_by_agent: 0, current_mode_id: null,
    pane_width: null, digest: null, follow_ups: null, follow_ups_source_message_id: null,
    acp_session_id: null, runtime_id: null, provider_id: null,
    model_id: null, reasoning: null, resume_fingerprint: null,
    composer_draft: null, external_session_id: null, trim_snapshot: null,
    created_at: opts.createdAt ?? 1,
  };
  saveNode(row);
  return row;
}

function baseRequest(overrides: Partial<ListPanesRequestV1> = {}): ListPanesRequestV1 {
  return {
    version: 1,
    workspaceId: WORKSPACE,
    scope: 'all',
    includeArchived: false,
    limit: 20,
    ...overrides,
  } as ListPanesRequestV1;
}

const RUNTIME_PROFILE = { version: 1 as const, runtimeId: 'pi' };

function effectiveDefinition(overrides: Partial<EffectiveAgentDefinitionV1['permissionPolicy']['categories']> = {}): EffectiveAgentDefinitionV1 {
  return {
    version: 1, name: 'Worker', description: 'Works', instructions: 'Work',
    runtimeProfile: RUNTIME_PROFILE, fallbackChain: [],
    capabilitySnapshot: { version: 1, entries: [] },
    permissionPolicy: {
      version: 1, preset: 'research', categories: { [AgentPolicyCategory.Read]: AgentPolicyDecision.Allow, ...overrides },
      maxDelegationDepth: 1, maxConcurrentRuns: 1, maxWallTimeMs: 60_000, maxAttempts: 1,
    },
    contextPolicy: {
      version: 1, includeWorkspaceInstructions: false, allowMessageContext: true,
      allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 1_000,
    },
  };
}

function createRun(repo: AgentRunsRepository, id: string, overrides: Partial<EffectiveAgentDefinitionV1['permissionPolicy']['categories']> = {}) {
  return repo.createRun({
    operationId: `op-${id}`, ownerUserId: OWNER, workspaceId: WORKSPACE,
    definitionId: null, definitionRevision: null,
    effectiveDefinition: effectiveDefinition(overrides),
    invocationMode: 'manual', completionMode: 'detach' as any,
    parentRunId: null, parentAttemptId: null, parentNodeId: null, parentTurnId: null,
    parentMessageId: null, parentToolCallId: null,
    task: 'do the thing',
    contextManifest: { version: 1, entries: [], assembledAt: 1, estimatedChars: 0 },
    expectedResult: null,
    executionEnvironment: { version: 1, kind: 'shared_workspace', cwd: '/tmp', sourceWorkspaceId: WORKSPACE, snapshotHash: 'a'.repeat(64), createdAt: 1 },
    expiresAt: null,
    initialEvent: { type: 'run_status_changed' as any, payload: { version: 1, from: null, to: 'queued' as any } },
  });
}

/** Registers a live surface presence view against the shared registry — the only way for a
 *  surface pane to become visible under either scope (design §4.2; no persisted row exists). */
function registerSurface(kind: string, opts: { workspaceId?: string; treeId?: string | null } = {}): () => void {
  const presenceCaller = { ownerUserId: OWNER, workspaceId: opts.workspaceId ?? WORKSPACE, connectionId: 'conn-1' };
  const { registrationId, paneId } = panePresenceRegistry.allocateSurfaceRegistration(presenceCaller, kind);
  const result = panePresenceRegistry.submitPresence(
    presenceCaller,
    {
      viewRevision: 1,
      windowId: 'window-a',
      views: [{
        paneId, windowId: 'window-a', uiPaneId: `ui-${registrationId}`,
        treeId: opts.treeId ?? null, visible: true, openedAtClient: null,
        surfaceTitle: null,
      }],
    },
  );
  assert.equal(result.ok, true, 'test setup: surface presence submission must succeed');
  assert.ok(result.ok);
  return () => { panePresenceRegistry.removePresence(presenceCaller, { rendererLeaseId: result.rendererLeaseId }); };
}

describe('paneInspectionList.list', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = freshTmpDir();
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
    seedWorkspace();
  });

  afterEach(() => {
    closeDb();
    delete process.env.MICHI_CLOUD;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('caller policy gates reject even empty and surface-only lists', () => {
    const run = createRun(new AgentRunsRepository(), 'restricted-caller');
    const definition = { ...run.effectiveDefinition, contextPolicy: { ...run.effectiveDefinition.contextPolicy, allowMessageContext: false } };
    getDb().prepare('UPDATE agent_runs SET effective_definition = ? WHERE id = ?').run(JSON.stringify(definition), run.id);
    const restricted = caller({ runOwner: { runId: run.id } });
    assert.throws(() => list(restricted, baseRequest({ scope: 'open' })), /context policy/);
    const cleanup = registerSurface('terminal');
    try { assert.throws(() => list(restricted, baseRequest({ scope: 'open' })), /context policy/); }
    finally { cleanup(); }
  });

  test('a caller Run cannot inspect another workspace through list', () => {
    const run = createRun(new AgentRunsRepository(), 'other-workspace-caller');
    seedWorkspace('ws-other');
    getDb().prepare('UPDATE agent_runs SET workspace_id = ? WHERE id = ?').run('ws-other', run.id);
    assert.throws(() => list(caller({ runOwner: { runId: run.id } }), baseRequest({ scope: 'open' })), /caller run not found/);
  });

  // -------------------------------------------------------------------------
  // Commit #1 — the three priority cases from the brief.
  // -------------------------------------------------------------------------

  test('2. scope=open returns only presence-registered views', () => {
    seedNode('open-node');
    seedNode('closed-node');
    // Only 'open-node' gets a live surface-style... no: register presence for the NODE target by
    // going through the registry's node/agent_run presence path is not exposed publicly for
    // arbitrary targets in this registry (only surfaces are allocatable) — but list()'s
    // scope=open reads listOpenTargetsForWorkspace, which is populated by ANY submitPresence
    // call whose views[].paneId encodes a target, node included. Submit presence for the node
    // target directly using its encoded paneId.
    const result1 = panePresenceRegistry.submitPresence(
      { ownerUserId: OWNER, workspaceId: WORKSPACE, connectionId: 'conn-1' },
      {
        viewRevision: 1,
        windowId: 'window-a',
        views: [{
          paneId: 'node:open-node', windowId: 'window-a', uiPaneId: 'ui-open-node',
          treeId: null, visible: true, openedAtClient: null, surfaceTitle: null,
        }],
      },
    );
    assert.equal(result1.ok, true);

    const result = list(caller(), baseRequest({ scope: 'open' }));
    const paneIds = result.summaries.map((s) => s.ref.paneId);
    assert.deepEqual(paneIds, ['node:open-node']);
    assert.ok(!paneIds.includes('node:closed-node'));
  });

  test('3. no summary contains an output body', () => {
    seedNode('node-with-output');

    const result = list(caller(), baseRequest());
    const serialized = JSON.stringify(result.summaries);
    assert.ok(!/"text"\s*:/.test(serialized), 'summary must not contain a "text" field');
    assert.ok(!/"latestOutput"/.test(serialized), 'summary must not contain a "latestOutput" field');
    // Positive control: the fields the brief DOES expect are present, so this isn't vacuously
    // passing on an empty/malformed summary.
    assert.equal(result.summaries.length, 1);
    assert.ok('ref' in result.summaries[0]);
    assert.ok('activity' in result.summaries[0]);
    assert.ok('openedInViews' in result.summaries[0]);
  });

  // -------------------------------------------------------------------------
  // Commit #2 — remaining priority cases.
  // -------------------------------------------------------------------------

  test('4. includeArchived false excludes archived nodes, true includes them', () => {
    seedNode('normal-node');
    seedNode('archived-node', { status: 'archived' });

    const excluded = list(caller(), baseRequest({ includeArchived: false }));
    assert.deepEqual(excluded.summaries.map((s) => s.ref.paneId).sort(), ['node:normal-node']);

    const included = list(caller(), baseRequest({ includeArchived: true }));
    assert.deepEqual(included.summaries.map((s) => s.ref.paneId).sort(), ['node:archived-node', 'node:normal-node']);
  });

  test('6. kind, treeId, and parentNodeId filters each narrow correctly and compose', () => {
    // trees.root_node_id and nodes.tree_id are mutually FK'd — seed the root node first (with no
    // tree_id), then the tree, then attach the tree_id via a direct UPDATE (mirrors how a real
    // "create tree from node" flow would sequence it; saveNode's own INSERT cannot satisfy both
    // FKs in one row for a brand-new tree+root pair).
    seedNode('chat-a');
    seedTree('tree-x', 'chat-a');
    getDb().prepare('UPDATE nodes SET tree_id = ? WHERE id = ?').run('tree-x', 'chat-a');
    seedNode('digest-a', { kind: 'digest', treeId: 'tree-x' });
    seedNode('chat-b');
    seedTree('tree-y', 'chat-b');
    getDb().prepare('UPDATE nodes SET tree_id = ? WHERE id = ?').run('tree-y', 'chat-b');
    seedNode('child-of-a', { treeId: 'tree-x', parentNodeId: 'chat-a' });

    const byKind = list(caller(), baseRequest({ kind: 'digest' }));
    assert.deepEqual(byKind.summaries.map((s) => s.ref.paneId), ['node:digest-a']);

    const byTree = list(caller(), baseRequest({ treeId: 'tree-x' }));
    assert.deepEqual(
      byTree.summaries.map((s) => s.ref.paneId).sort(),
      ['node:chat-a', 'node:child-of-a', 'node:digest-a'],
    );

    const byParent = list(caller(), baseRequest({ parentNodeId: 'chat-a' }));
    assert.deepEqual(byParent.summaries.map((s) => s.ref.paneId), ['node:child-of-a']);

    // Composed: treeId + kind together narrow to the intersection.
    const composed = list(caller(), baseRequest({ treeId: 'tree-x', kind: 'digest' }));
    assert.deepEqual(composed.summaries.map((s) => s.ref.paneId), ['node:digest-a']);
  });

  test('7. pagination: limit is respected, nextCursor walks the full set exactly once, limit>100 clamps, non-integer limit is INVALID_ARGUMENT', () => {
    for (let i = 0; i < 5; i += 1) seedNode(`page-node-${i}`, { createdAt: i + 1 });

    const page1 = list(caller(), baseRequest({ limit: 2 }));
    assert.equal(page1.summaries.length, 2);
    assert.ok(page1.nextCursor);

    const page2 = list(caller(), baseRequest({ limit: 2, cursor: page1.nextCursor ?? undefined }));
    assert.equal(page2.summaries.length, 2);
    assert.ok(page2.nextCursor);

    const page3 = list(caller(), baseRequest({ limit: 2, cursor: page2.nextCursor ?? undefined }));
    assert.equal(page3.summaries.length, 1);
    assert.equal(page3.nextCursor, null);

    const allPaneIds = [...page1.summaries, ...page2.summaries, ...page3.summaries].map((s) => s.ref.paneId);
    assert.equal(new Set(allPaneIds).size, 5, 'every row must appear exactly once across pages');

    // limit > 100 clamps rather than erroring.
    const clamped = list(caller(), baseRequest({ limit: 500 }));
    assert.equal(clamped.summaries.length, 5);

    // Non-integer limit is INVALID_ARGUMENT.
    assert.throws(
      () => list(caller(), baseRequest({ limit: 1.5 })),
      (err: unknown) => {
        assert.ok(err instanceof PaneInspectionError);
        return (err as PaneInspectionError).code === 'INVALID_ARGUMENT';
      },
    );
  });

  test('8. navigation disabled returns NAVIGATION_DISABLED, no title leaks', () => {
    seedNode('secret-node', { title: 'do not leak this title' });
    setAiGlobalContext(WORKSPACE, false);

    let thrown: unknown;
    try {
      list(caller(), baseRequest());
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof PaneInspectionError);
    assert.equal((thrown as PaneInspectionError).code, 'NAVIGATION_DISABLED');
    assert.ok(!(thrown as PaneInspectionError).message.includes('do not leak this title'));
  });

  test('9. presenceCoverage is reported when at least one row has a live view', () => {
    seedNode('presence-node');
    panePresenceRegistry.submitPresence(
      { ownerUserId: OWNER, workspaceId: WORKSPACE, connectionId: 'conn-1' },
      {
        viewRevision: 1,
        windowId: 'window-a',
        views: [{
          paneId: 'node:presence-node', windowId: 'window-a', uiPaneId: 'ui-presence-node',
          treeId: null, visible: true, openedAtClient: null, surfaceTitle: null,
        }],
      },
    );
    const result = list(caller(), baseRequest());
    assert.equal(result.presenceCoverage, 'reported');
  });

  test('10. another owner\'s workspace returns nothing rather than an error revealing existence', () => {
    process.env.MICHI_CLOUD = '1';
    try {
      getDb().prepare('UPDATE workspaces SET owner_user_id = ? WHERE id = ?').run(OWNER, WORKSPACE);
      seedNode('owned-node');

      const other = caller({ ownerUserId: 'someone-else' });
      assert.throws(
        () => list(other, baseRequest()),
        (err: unknown) => {
          assert.ok(err instanceof PaneInspectionError);
          return (err as PaneInspectionError).code === 'NOT_FOUND';
        },
      );
    } finally {
      delete process.env.MICHI_CLOUD;
    }
  });
});
