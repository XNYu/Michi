/**
 * Integration smoke test for ClaudeRuntime.
 *
 * Spawns a real `claude` binary, sends a prompt, asserts PONG is returned,
 * and verifies --resume works on the second pass.
 *
 * Gated by env var so it never runs in the normal CI pass:
 *   MICHI_CLAUDE_SMOKE=1  npm test -- --test-name-pattern smoke
 *
 * Cost: ~cents per run (two API round-trips).
 * Timeout: 60 s per test, 120 s total.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

// ── Guard: skip entirely unless opted-in ────────────────────────────────────

const ENABLED =
  process.env.MICHI_CLAUDE_SMOKE === '1' || process.argv.includes('--smoke');

if (!ENABLED) {
  // node:test's describe/test are still registered synchronously; use skip.
  describe('smoke (skipped — set MICHI_CLAUDE_SMOKE=1 to run)', () => {
    test.skip('ClaudeRuntime smoke — skipped', () => {});
  });
  // Nothing else runs in this file.
} else {
  runSmokeTests();
}

function runSmokeTests(): void {
  // ── Lazy imports (only when ENABLED so normal test pass never loads them) ──

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { McpSlotRegistry, mountMcp } = require('../src/services/mcpServer') as
    typeof import('../src/services/mcpServer');

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ClaudeRuntime } = require('../src/agents/claude/ClaudeRuntime') as
    typeof import('../src/agents/claude/ClaudeRuntime');

  // Helper: cast an AgentSession to the concrete ClaudeSession shape so we
  // can call dispose() and read child.pid without TypeScript errors.
  // (dispose is not on the AgentSession interface but is implemented by ClaudeSession.)
  type ClaudeSessionLike = {
    dispose(): Promise<void>;
    child: { pid?: number } | null;
  };

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const db = require('../src/services/db') as typeof import('../src/services/db');

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const repo = require('../src/services/dbRepository') as
    typeof import('../src/services/dbRepository');

  // ── Shared fixtures ─────────────────────────────────────────────────────────

  let tmpDir: string;
  let server: http.Server;
  let mcpPort: number;
  let mcpRegistry: InstanceType<typeof McpSlotRegistry>;
  let runtime: InstanceType<typeof ClaudeRuntime>;
  let workspaceId: string;

  before(async () => {
    // Isolated DB in a temp dir
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-smoke-'));
    process.env.MICHI_DATA_DIR = tmpDir;

    // Boot DB
    db.initDb();

    // Pre-seed workspace
    workspaceId = randomUUID();
    repo.saveWorkspace({
      id: workspaceId,
      name: 'smoke-test-workspace',
      cwd: tmpDir,
      active_tree_id: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      settings: null,
      deleted_at: null,
      archived_at: null,
      backend: 'claude',
    });

    // Build a minimal Express app + mount MCP
    mcpRegistry = new McpSlotRegistry();

    const app = express();
    app.use(express.json());

    const mcpRouter = express.Router();
    mountMcp(mcpRouter, mcpRegistry);
    app.use('/api', mcpRouter);

    // Listen on random port
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    mcpPort = (server.address() as { port: number }).port;

    // Stub AgentToolBridge
    const bridge = {
      async spawnBranches(args: { parentChatId: string; topics: Array<{ title: string; prompt: string }> }) {
        console.log('[smoke] spawnBranches stub called, topics:', args.topics.length);
        return args.topics.map((t) => ({ ...t, chatId: randomUUID() }));
      },
      saveContext(_args: { cwd: string; name: string; body: string }) {
        return null;
      },
      updateContext(_args: { cwd: string; name: string; body: string }) {
        return null;
      },
    };

    runtime = new ClaudeRuntime(bridge as never, mcpRegistry, mcpPort);
  });

  after(async () => {
    // Dispose runtime (kills all child processes)
    await runtime.shutdown().catch(() => {});
    // Close Express
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Close DB
    db.closeDb();
    // Clean up temp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // Reset env
    delete process.env.MICHI_DATA_DIR;
  });

  // ── Test 1: newSession + send → PONG ────────────────────────────────────────

  test(
    'ClaudeRuntime smoke — newSession spawns claude and returns PONG',
    { timeout: 60_000 },
    async () => {
      const nodeId = randomUUID();

      // Pre-seed a node row so setNodeExternalSessionId has something to UPDATE
      repo.saveNode({
        id: nodeId,
        workspace_id: workspaceId,
        tree_id: null,
        parent_node_id: null,
        kind: 'chat',
        title: null,
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
        acp_session_id: null,
        composer_draft: null,
        created_at: Date.now(),
      });

      // Spawn a fresh session
      const session = await runtime.newSession({
        sessionId: nodeId,
        workspaceId,
        cwd: tmpDir,
      });

      // Send a single-word prompt
      const events: Array<{ kind: string; text?: string; stopReason?: string }> = [];
      for await (const ev of session.send(
        "Reply with exactly the single word PONG and nothing else. Do not use any tools.",
      )) {
        events.push(ev as typeof events[number]);
        if (ev.kind === 'turn_end') break;
      }

      console.log('[smoke] events received:', events.map((e) => e.kind).join(', '));

      // Assert chunk(s) arrived
      const chunks = events.filter((e) => e.kind === 'chunk');
      assert.ok(chunks.length > 0, `Expected at least one chunk event, got: ${JSON.stringify(events)}`);

      // Assert PONG in concatenated text
      const fullText = chunks.map((e) => e.text ?? '').join('');
      console.log('[smoke] full response text:', JSON.stringify(fullText));
      assert.ok(
        fullText.toUpperCase().includes('PONG'),
        `Expected response to contain PONG, got: ${JSON.stringify(fullText)}`,
      );

      // Assert turn_end arrived
      const turnEnd = events.find((e) => e.kind === 'turn_end');
      assert.ok(turnEnd, 'Expected turn_end event');
      assert.ok(turnEnd.stopReason, `Expected turn_end.stopReason to be set, got: ${JSON.stringify(turnEnd)}`);
      console.log('[smoke] turn_end.stopReason:', turnEnd.stopReason);

      // Assert external_session_id was persisted
      const externalSessionId = repo.getNodeExternalSessionId(nodeId);
      assert.ok(
        externalSessionId,
        `Expected external_session_id to be persisted for node ${nodeId}`,
      );
      // Should look like a UUID (8-4-4-4-12 hex chars)
      assert.match(
        externalSessionId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        `external_session_id should be UUID-like, got: ${externalSessionId}`,
      );
      console.log('[smoke] external_session_id:', externalSessionId);

      // Check child pid is still alive (session not disposed yet)
      // We'll dispose and then verify it exited
      const sessionConcrete = session as unknown as ClaudeSessionLike;
      const childPid = sessionConcrete.child?.pid;
      assert.ok(childPid, 'Expected child.pid to be set');

      await sessionConcrete.dispose();

      // After dispose, the process should be gone (SIGTERM)
      let processGone = false;
      try {
        process.kill(childPid!, 0);
        // If we reach here, process is still alive — wait briefly and retry
        await new Promise((r) => setTimeout(r, 500));
        try {
          process.kill(childPid!, 0);
        } catch (e2) {
          if ((e2 as NodeJS.ErrnoException).code === 'ESRCH') processGone = true;
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') processGone = true;
        // EPERM means process exists but we can't signal it (different user) — treat as alive
      }
      assert.ok(processGone, `Expected child pid ${childPid} to have exited after dispose()`);
    },
  );

  // ── Test 2: loadSession (--resume) recalls prior context ────────────────────

  test(
    'ClaudeRuntime smoke — loadSession resumes and recalls PONG turn',
    { timeout: 60_000 },
    async () => {
      // We need a fresh node with an external_session_id set.
      // Re-run newSession to get one, send PONG, dispose, then resume.
      const nodeId = randomUUID();

      repo.saveNode({
        id: nodeId,
        workspace_id: workspaceId,
        tree_id: null,
        parent_node_id: null,
        kind: 'chat',
        title: null,
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
        acp_session_id: null,
        composer_draft: null,
        created_at: Date.now(),
      });

      // First session — establish PONG turn
      const session1 = await runtime.newSession({
        sessionId: nodeId,
        workspaceId,
        cwd: tmpDir,
      });
      for await (const ev of session1.send(
        "Reply with exactly the single word PONG and nothing else. Do not use any tools.",
      )) {
        if (ev.kind === 'turn_end') break;
      }
      await (session1 as unknown as ClaudeSessionLike).dispose();

      // Confirm external_session_id was stored
      const externalSessionId = repo.getNodeExternalSessionId(nodeId);
      assert.ok(externalSessionId, 'external_session_id must be set before resume test');
      console.log('[smoke] resume: external_session_id =', externalSessionId);

      // Second session — resume
      const session2 = await runtime.loadSession({
        sessionId: nodeId,
        workspaceId,
        cwd: tmpDir,
      });

      const resumeEvents: Array<{ kind: string; text?: string }> = [];
      for await (const ev of session2.send(
        "What was the single word I asked you to reply with in your previous turn?",
      )) {
        resumeEvents.push(ev as typeof resumeEvents[number]);
        if (ev.kind === 'turn_end') break;
      }

      const resumeText = resumeEvents
        .filter((e) => e.kind === 'chunk')
        .map((e) => e.text ?? '')
        .join('');
      console.log('[smoke] resume response text:', JSON.stringify(resumeText));

      // Model should recall "PONG"
      assert.ok(
        resumeText.toUpperCase().includes('PONG'),
        `Expected resumed session to reference PONG, got: ${JSON.stringify(resumeText)}`,
      );

      const resumeTurnEnd = resumeEvents.find((e) => e.kind === 'turn_end');
      assert.ok(resumeTurnEnd, 'Expected turn_end in resume turn');

      await (session2 as unknown as ClaudeSessionLike).dispose();
    },
  );
}
