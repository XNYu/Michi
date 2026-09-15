/**
 * Tests for `readOutput` (backend/src/services/paneInspectionOutput.ts) — the P1-7 acceptance
 * criteria. Mirrors paneInspection.test.ts's fixture style (fresh temp-SQLite MICHI_DATA_DIR per
 * test, real ChatHub + AgentRunsRepository, no fake agent CLI) — see that file's own header note
 * for why a real ChatHub/repository is cheap enough to use directly here too.
 *
 * Cursor TTL is exercised with a fake clock (Date.now stub), never a real sleep.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AgentPolicyCategory,
  AgentPolicyDecision,
  AgentRunEventType,
  AgentRunStatus,
  applyTurnEvent,
  createDurableTurn,
  PaneInspectionError,
  type ChatStreamEvent,
  type EffectiveAgentDefinitionV1,
  type ResultBundleV1,
} from 'michi-shared';
import { closeDb, initDb, getDb } from '../src/services/db';
import {
  beginTurn,
  finalizeTurn,
  saveMessage,
  saveNode,
  saveWorkspace,
  type MessageRow,
  type NodeRow,
} from '../src/services/dbRepository';
import { AgentRunsRepository } from '../src/services/agentRunsRepository';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { readOutput, type ReadPaneOutputInput } from '../src/services/paneInspectionOutput';
import type { PaneInspectionCaller } from '../src/services/paneInspection';

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'michi-pane-inspection-output-'));
}

const OWNER = LOCAL_AGENT_OWNER_ID;
const WORKSPACE = 'ws-1';

function caller(overrides: Partial<PaneInspectionCaller> = {}): PaneInspectionCaller {
  return { ownerUserId: OWNER, workspaceId: WORKSPACE, backendConnectionId: 'conn-1', ...overrides };
}

function event(name: ChatStreamEvent['event'], data: Record<string, unknown>): ChatStreamEvent {
  return { event: name, data } as ChatStreamEvent;
}

function seedWorkspace(id = WORKSPACE): void {
  saveWorkspace({
    id, name: 'Workspace', created_at: 1, updated_at: 1,
    active_tree_id: null, cwd: null, settings: null,
    deleted_at: null, archived_at: null,
  });
}

function seedNode(id: string, opts: Partial<NodeRow> = {}): NodeRow {
  const row: NodeRow = {
    id, workspace_id: WORKSPACE,
    tree_id: null, parent_node_id: null,
    kind: 'chat', title: null, branch_overview: null,
    status: 'idle',
    position_x: null, position_y: null, minimized: 0, deleted_at: null,
    deletion_group_id: null, spawned_by_agent: 0, current_mode_id: null,
    pane_width: null, digest: null, follow_ups: null, follow_ups_source_message_id: null,
    acp_session_id: null, runtime_id: null, provider_id: null,
    model_id: null, reasoning: null, resume_fingerprint: null,
    composer_draft: null, external_session_id: null, trim_snapshot: null,
    created_at: 1,
    ...opts,
  };
  saveNode(row);
  return row;
}

/** Drives begin -> chunk(s) -> done -> finalize so a real completed turn + persisted message
 *  row exist (message.content is written by finalizeTurn via finalizeTurnContent, the same
 *  visible-text derivation the chat projection module applies to a live snapshot). */
function seedCompletedTurn(nodeId: string, turnId: string, text: string, startedAt = 100): void {
  let snapshot = createDurableTurn({ turnId, assistantId: `a-${turnId}`, nodeId, workspaceId: WORKSPACE, displayUserText: 'hi', startedAt });
  beginTurn(snapshot);
  snapshot = applyTurnEvent(snapshot, event('chunk', { text, seq: 1 }));
  snapshot = applyTurnEvent(snapshot, event('done', { stopReason: 'end_turn', seq: 2, completedAt: startedAt + 10 }));
  finalizeTurn(snapshot);
}

/** Drives begin -> chunk -> error -> finalize so a real FAILED turn + its partial persisted
 *  message row exist (execution mode must still be able to read this). */
function seedFailedTurn(nodeId: string, turnId: string, partialText: string, startedAt = 100): void {
  let snapshot = createDurableTurn({ turnId, assistantId: `a-${turnId}`, nodeId, workspaceId: WORKSPACE, displayUserText: 'hi', startedAt });
  beginTurn(snapshot);
  snapshot = applyTurnEvent(snapshot, event('chunk', { text: partialText, seq: 1 }));
  snapshot = applyTurnEvent(snapshot, event('error', { message: 'boom', seq: 2, completedAt: startedAt + 10 }));
  finalizeTurn(snapshot);
}

const HASH = 'a'.repeat(64);
const RUNTIME_PROFILE = { version: 1 as const, runtimeId: 'pi' };

function effectiveDefinition(): EffectiveAgentDefinitionV1 {
  return {
    version: 1, name: 'Worker', description: 'Works', instructions: 'Work',
    runtimeProfile: RUNTIME_PROFILE, fallbackChain: [],
    capabilitySnapshot: { version: 1, entries: [] },
    permissionPolicy: {
      version: 1, preset: 'research', categories: { [AgentPolicyCategory.Read]: AgentPolicyDecision.Allow },
      maxDelegationDepth: 1, maxConcurrentRuns: 1, maxWallTimeMs: 60_000, maxAttempts: 1,
    },
    contextPolicy: {
      version: 1, includeWorkspaceInstructions: false, allowMessageContext: true,
      allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 1_000,
    },
  };
}

function createRun(repo: AgentRunsRepository, id: string) {
  return repo.createRun({
    operationId: `op-${id}`, ownerUserId: OWNER, workspaceId: WORKSPACE,
    definitionId: null, definitionRevision: null,
    effectiveDefinition: effectiveDefinition(),
    invocationMode: 'manual', completionMode: 'detach' as any,
    parentRunId: null, parentAttemptId: null, parentNodeId: null, parentTurnId: null,
    parentMessageId: null, parentToolCallId: null,
    task: 'do the thing',
    contextManifest: { version: 1, entries: [], assembledAt: 1, estimatedChars: 0 },
    expectedResult: null,
    executionEnvironment: { version: 1, kind: 'shared_workspace', cwd: '/tmp', sourceWorkspaceId: WORKSPACE, snapshotHash: HASH, createdAt: 1 },
    expiresAt: null,
    initialEvent: { type: AgentRunEventType.RunStatusChanged, payload: { version: 1, from: null, to: AgentRunStatus.Queued } },
  });
}

function resultBundle(overrides: Partial<ResultBundleV1> = {}): ResultBundleV1 {
  return {
    version: 1, status: 'completed', source: 'submitted',
    handoff: { conclusion: 'All done', artifactsOrChanges: 'Changed X, Y', unresolvedIssues: '' },
    artifacts: [], resourceMutations: [], externalActions: [],
    ...overrides,
  };
}

describe('readOutput', () => {
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Selection modes
  // -------------------------------------------------------------------------

  test('latest selection returns the current turn\'s text', () => {
    seedNode('n1');
    seedCompletedTurn('n1', 't1', 'hello world');
    const result = readOutput(caller(), { locator: { nodeId: 'n1' }, selection: 'latest', limitBytes: 1024 });
    assert.equal(result.text, 'hello world');
    assert.equal(result.kind, 'answer');
    assert.equal(result.partial, false);
    assert.deepEqual(result.execution, { kind: 'chat_turn', nodeId: 'n1', turnId: 't1' });
  });

  test('last_completed skips a failed execution but execution mode reaches its partial output', () => {
    seedNode('n2');
    seedCompletedTurn('n2', 't-ok', 'the good answer', 100);
    seedFailedTurn('n2', 't-bad', 'partial before crash', 200);

    const lastCompleted = readOutput(caller(), { locator: { nodeId: 'n2' }, selection: 'last_completed', limitBytes: 1024 });
    assert.equal(lastCompleted.text, 'the good answer');
    assert.deepEqual(lastCompleted.execution, { kind: 'chat_turn', nodeId: 'n2', turnId: 't-ok' });

    const viaExecution = readOutput(caller(), {
      locator: { nodeId: 'n2' }, selection: 'execution', limitBytes: 1024,
      executionRef: { kind: 'chat_turn', nodeId: 'n2', turnId: 't-bad' },
    });
    assert.equal(viaExecution.text, 'partial before crash');
    assert.deepEqual(viaExecution.execution, { kind: 'chat_turn', nodeId: 'n2', turnId: 't-bad' });
  });

  test('execution mode rejects an executionRef that does not belong to the target node', () => {
    seedNode('n3');
    seedNode('n4');
    seedCompletedTurn('n4', 't-other', 'other node text');
    assert.throws(
      () => readOutput(caller(), {
        locator: { nodeId: 'n3' }, selection: 'execution', limitBytes: 1024,
        executionRef: { kind: 'chat_turn', nodeId: 'n4', turnId: 't-other' },
      }),
      (err: unknown) => err instanceof PaneInspectionError && err.code === 'INVALID_ARGUMENT',
    );
  });

  test('execution selection without an executionRef is INVALID_ARGUMENT', () => {
    seedNode('n5');
    assert.throws(
      () => readOutput(caller(), { locator: { nodeId: 'n5' }, selection: 'execution', limitBytes: 1024 }),
      (err: unknown) => err instanceof PaneInspectionError && err.code === 'INVALID_ARGUMENT',
    );
  });

  // -------------------------------------------------------------------------
  // Pagination — content-snapshot protocol
  // -------------------------------------------------------------------------

  test('paginating a large output returns every byte exactly once, in order, across pages', () => {
    // finalizeTurnContent (shared/src/turnProjection.ts) .trim()s the finalized answer, so the
    // fixture's own expectation must match that trimmed form rather than the raw joined string.
    const fullText = Array.from({ length: 500 }, (_, i) => `line-${i} `).join('').trim();
    seedNode('n6');
    seedCompletedTurn('n6', 't6', fullText);

    let cursor: string | null = null;
    let reassembled = '';
    let pages = 0;
    do {
      const req: ReadPaneOutputInput = { locator: { nodeId: 'n6' }, selection: 'latest', limitBytes: 64, ...(cursor ? { pageCursor: cursor } : {}) };
      const page = readOutput(caller(), req);
      reassembled += page.text;
      cursor = page.nextPageCursor;
      pages += 1;
      assert.ok(pages < 1000, 'safety valve against an infinite loop');
    } while (cursor);

    assert.equal(reassembled, fullText);
    assert.ok(pages > 1, 'expected more than one page at limitBytes=64 for a long text');
  });

  test('mid-stream change between two page reads returns OUTPUT_CHANGED, and the caller can restart cleanly', () => {
    // Exercised via the durable (execution-mode) path rather than a live ChatHub observation: the
    // same outputId (one turnId) but its persisted content changes between the two page reads —
    // this is exactly what a re-finalize (e.g. a resumed/corrected write) or a concurrent second
    // reader observing a checkpoint update would look like from readOutput's perspective, and it
    // is the same OUTPUT_CHANGED branch a live-streaming `latest` read takes when outputRevision
    // moves between reads (see the module's pageCursor-vs-resolved.outputRevision comparison,
    // which does not care which resolution path produced either revision).
    seedNode('n7');
    seedCompletedTurn('n7', 't7', 'a'.repeat(100), 100);

    const page1 = readOutput(caller(), {
      locator: { nodeId: 'n7' }, selection: 'execution', limitBytes: 40,
      executionRef: { kind: 'chat_turn', nodeId: 'n7', turnId: 't7' },
    });
    assert.ok(page1.nextPageCursor);

    // The message's persisted content changes under the SAME turn/message id (outputId is stable
    // — it is keyed by turnId, not by content) before the caller reads page 2.
    saveMessage({ id: 'a-t7', node_id: 'n7', role: 'assistant', content: 'b'.repeat(100), seq: 1, created_at: 100 } as MessageRow);

    assert.throws(
      () => readOutput(caller(), {
        locator: { nodeId: 'n7' }, selection: 'execution', limitBytes: 40, pageCursor: page1.nextPageCursor!,
        executionRef: { kind: 'chat_turn', nodeId: 'n7', turnId: 't7' },
      }),
      (err: unknown) => err instanceof PaneInspectionError && err.code === 'OUTPUT_CHANGED',
    );

    // Restarting cleanly (no pageCursor) succeeds and reads the NEW content from page 1.
    const restarted = readOutput(caller(), {
      locator: { nodeId: 'n7' }, selection: 'execution', limitBytes: 40,
      executionRef: { kind: 'chat_turn', nodeId: 'n7', turnId: 't7' },
    });
    assert.equal(restarted.text, 'b'.repeat(40));
  });

  test('a new turn starting between pages does not splice its text into the old page', () => {
    seedNode('n8');
    seedCompletedTurn('n8', 't8-old', 'x'.repeat(100), 100);

    const page1 = readOutput(caller(), { locator: { nodeId: 'n8' }, selection: 'latest', limitBytes: 40 });
    assert.equal(page1.text, 'x'.repeat(40));
    assert.ok(page1.nextPageCursor);

    // A NEW turn starts and completes on the same node before the caller reads page 2.
    seedCompletedTurn('n8', 't8-new', 'y'.repeat(100), 200);

    // The old page's cursor is bound to t8-old's outputId — the "latest" outputId is now t8-new,
    // so this must not resolve to page 2 of the OLD text at all.
    assert.throws(
      () => readOutput(caller(), { locator: { nodeId: 'n8' }, selection: 'latest', limitBytes: 40, pageCursor: page1.nextPageCursor! }),
      (err: unknown) => err instanceof PaneInspectionError && err.code === 'OUTPUT_UNAVAILABLE',
    );

    // The OLD turn's own content is still readable in full via `execution`, uncorrupted by the
    // new turn — proving no splice happened.
    const oldViaExecution = readOutput(caller(), {
      locator: { nodeId: 'n8' }, selection: 'execution', limitBytes: 1024,
      executionRef: { kind: 'chat_turn', nodeId: 'n8', turnId: 't8-old' },
    });
    assert.equal(oldViaExecution.text, 'x'.repeat(100));
  });

  test('an expired cursor returns OUTPUT_UNAVAILABLE', () => {
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      seedNode('n9');
      seedCompletedTurn('n9', 't9', 'a'.repeat(100));
      const page1 = readOutput(caller(), { locator: { nodeId: 'n9' }, selection: 'latest', limitBytes: 40 });
      assert.ok(page1.nextPageCursor);

      now += 30_001; // past the 30s page-cursor TTL

      assert.throws(
        () => readOutput(caller(), { locator: { nodeId: 'n9' }, selection: 'latest', limitBytes: 40, pageCursor: page1.nextPageCursor! }),
        (err: unknown) => err instanceof PaneInspectionError && err.code === 'OUTPUT_UNAVAILABLE',
      );
    } finally {
      Date.now = realNow;
    }
  });

  test('a cursor issued for one caller/scope is not honoured for another', () => {
    seedNode('n10');
    seedCompletedTurn('n10', 't10', 'a'.repeat(100));
    const page1 = readOutput(caller(), { locator: { nodeId: 'n10' }, selection: 'latest', limitBytes: 40 });
    assert.ok(page1.nextPageCursor);

    const otherCaller = caller({ backendConnectionId: 'conn-2' });
    assert.throws(
      () => readOutput(otherCaller, { locator: { nodeId: 'n10' }, selection: 'latest', limitBytes: 40, pageCursor: page1.nextPageCursor! }),
      (err: unknown) => err instanceof PaneInspectionError && err.code === 'OUTPUT_UNAVAILABLE',
    );
  });

  // -------------------------------------------------------------------------
  // limitBytes / truncation
  // -------------------------------------------------------------------------

  test('limitBytes above the max clamps to the max, and a non-integer is INVALID_ARGUMENT via the shared parser', () => {
    const { parseReadOutputLimitBytes, PANE_INSPECTION_LIMITS } = require('michi-shared') as typeof import('michi-shared');
    // readOutput itself clamps defensively too (never trusts the caller — see module comment),
    // but the untrusted-input parsing/rejection contract belongs to the shared parser P1-1 wrote;
    // this proves the two agree rather than duplicating a second rejection path here.
    assert.equal(parseReadOutputLimitBytes(999_999), PANE_INSPECTION_LIMITS.readOutputMaxBytes);
    assert.throws(() => parseReadOutputLimitBytes(12.5), (err: unknown) => err instanceof Error);

    seedNode('n11');
    seedCompletedTurn('n11', 't11', 'z'.repeat(100));
    const result = readOutput(caller(), { locator: { nodeId: 'n11' }, selection: 'latest', limitBytes: 999_999 });
    // Clamped internally to readOutputMaxBytes, which comfortably fits this 100-byte fixture in
    // one page — proving the clamp did not reject the call outright.
    assert.equal(result.text, 'z'.repeat(100));
    assert.equal(result.nextPageCursor, null);
  });

  test('truncation on a multi-byte/emoji boundary produces no broken code point', () => {
    // Each 👍 is a 4-byte UTF-8 astral code point (surrogate pair in UTF-16). Pick a limitBytes
    // that lands mid-emoji if truncation were byte-naive.
    const text = '👍'.repeat(20); // 80 bytes total
    seedNode('n12');
    seedCompletedTurn('n12', 't12', text);

    const page1 = readOutput(caller(), { locator: { nodeId: 'n12' }, selection: 'latest', limitBytes: 10 }); // not a multiple of 4
    // Every code point in the returned text must be a complete 👍 — Array.from re-splits by code
    // point, so a broken surrogate half would either throw or produce a replacement/mismatched
    // character; assert every code point in the page is exactly '👍'.
    for (const cp of Array.from(page1.text)) assert.equal(cp, '👍');
    assert.ok(Buffer.byteLength(page1.text, 'utf8') <= 10);
    assert.ok(page1.nextPageCursor);
  });

  // -------------------------------------------------------------------------
  // AgentRun
  // -------------------------------------------------------------------------

  test('AgentRun: attempt 2\'s text is not concatenated with attempt 1\'s', () => {
    const runs = new AgentRunsRepository();
    const run = createRun(runs, 'run-1');

    const attempt1 = runs.createAttempt({
      operationId: 'attempt-op-1', ownerUserId: OWNER, runId: run.id,
      profileIndex: 0, runtimeProfile: RUNTIME_PROFILE, publicSessionId: 'sess-1', recoveryEnvelope: null,
    });
    runs.appendEventAndProject(OWNER, run.id, 0, {
      type: AgentRunEventType.Assistant, payload: { version: 1, text: 'attempt one text' }, attemptId: attempt1.id,
    });

    const attempt2 = runs.createAttempt({
      operationId: 'attempt-op-2', ownerUserId: OWNER, runId: run.id,
      profileIndex: 0, runtimeProfile: RUNTIME_PROFILE, publicSessionId: 'sess-2', recoveryEnvelope: null,
    });
    runs.appendEventAndProject(OWNER, run.id, 1, {
      type: AgentRunEventType.Assistant, payload: { version: 1, text: 'attempt two text' }, attemptId: attempt2.id,
    });

    const result = readOutput(caller(), { locator: { runId: run.id }, selection: 'latest', limitBytes: 1024 });
    assert.equal(result.text, 'attempt two text');
    assert.ok(!result.text.includes('attempt one'));
  });

  test('AgentRun: terminal + resultBundle previews handoff', () => {
    const runs = new AgentRunsRepository();
    const run = createRun(runs, 'run-2');
    const attempt = runs.createAttempt({
      operationId: 'attempt-op-3', ownerUserId: OWNER, runId: run.id,
      profileIndex: 0, runtimeProfile: RUNTIME_PROFILE, publicSessionId: 'sess-3', recoveryEnvelope: null,
    });
    runs.appendEventAndProject(OWNER, run.id, 0, {
      type: AgentRunEventType.Assistant, payload: { version: 1, text: 'raw assistant text' }, attemptId: attempt.id,
    });
    runs.appendEventAndProject(OWNER, run.id, 1, {
      type: AgentRunEventType.RunStatusChanged, payload: { version: 1, from: AgentRunStatus.Running, to: AgentRunStatus.Completed },
    }, { status: AgentRunStatus.Completed, completedAt: 5_000, resultBundle: resultBundle() });

    const result = readOutput(caller(), { locator: { runId: run.id }, selection: 'latest', limitBytes: 1024 });
    assert.equal(result.kind, 'handoff');
    assert.match(result.text, /All done/);
  });

  // -------------------------------------------------------------------------
  // Content rules — no sentinels/thoughts/tool logs/permission payloads leak through
  // -------------------------------------------------------------------------

  test('output text contains no sentinel, thought, tool log or permission payload', () => {
    seedNode('n13');
    let snapshot = createDurableTurn({ turnId: 't13', assistantId: 'a-t13', nodeId: 'n13', workspaceId: WORKSPACE, displayUserText: 'hi', startedAt: 100 });
    beginTurn(snapshot);
    snapshot = applyTurnEvent(snapshot, event('thought', { text: 'thinking about secret plan', seq: 1 }));
    snapshot = applyTurnEvent(snapshot, event('tool_call', {
      toolCallId: 'tool-1', title: 'run_shell', status: 'running', kind: 'exec',
      detail: 'internal detail', inputJson: '{"cmd":"rm -rf /secret"}', seq: 2,
    }));
    snapshot = applyTurnEvent(snapshot, event('chunk', { text: 'The visible answer text.', seq: 3 }));
    snapshot = applyTurnEvent(snapshot, event('chunk', { text: ' [TITLE: hidden title]', seq: 4 }));
    snapshot = applyTurnEvent(snapshot, event('done', { stopReason: 'end_turn', seq: 5, completedAt: 110 }));
    finalizeTurn(snapshot);

    const result = readOutput(caller(), { locator: { nodeId: 'n13' }, selection: 'latest', limitBytes: 4096 });
    assert.equal(result.text, 'The visible answer text.');
    assert.doesNotMatch(result.text, /secret plan/);
    assert.doesNotMatch(result.text, /run_shell|rm -rf|internal detail/);
    assert.doesNotMatch(result.text, /\[TITLE:/i);
  });

  test('an empty (never-started) target returns empty text, not an error', () => {
    seedNode('n14');
    const result = readOutput(caller(), { locator: { nodeId: 'n14' }, selection: 'latest', limitBytes: 1024 });
    assert.equal(result.text, '');
    assert.equal(result.execution, null);
    assert.equal(result.nextPageCursor, null);
  });
});
