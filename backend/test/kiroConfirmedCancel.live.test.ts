/**
 * Real kiro-cli through Michi's adapter (AcpAgentRuntime, AcpAgentSession, ChatHub):
 * Stop on a streaming turn is acknowledged natively (the prompt settles with
 * stopReason "cancelled"), the same session answers the next prompt, and
 * that turn reports Kiro's own metering (credits and context %), no tokens.
 *
 * Explicit opt-in only: an authenticated kiro-cli, provider credits, two
 * small turns per engine. Isolate Michi's directories as for any live run:
 *   MICHI_KIRO_CANCEL_SMOKE=v2,v3 npm exec -w backend -- node --require ts-node/register \
 *     --require ./test/helpers/isolateUserDirs.cjs --test --test-concurrency=1 \
 *     --test-timeout=300000 test/kiroConfirmedCancel.live.test.ts
 * MICHI_KIRO_SMOKE_MODEL picks the model (default claude-haiku-5.5).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatStreamEvent } from 'michi-shared';
import type { AcpAgentRuntime } from 'michi-runtime/internal/adapters/kiro/AcpAgentRuntime';
import type { AgentSession } from '../src/agents/types';

const enabled = (process.env.MICHI_KIRO_CANCEL_SMOKE ?? '').split(',');

async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

for (const engine of ['v2', 'v3'] as const) {
  test(`real Kiro ${engine}: native cancel ack, reusable session, native metering`, {
    skip: !enabled.includes(engine), timeout: 300_000,
  }, async () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `michi-kiro-cancel-${engine}-`)));
    const previous = { MICHI_DATA_DIR: process.env.MICHI_DATA_DIR, MICHI_TITLE_MODEL_KIRO: process.env.MICHI_TITLE_MODEL_KIRO };
    Object.assign(process.env, { MICHI_DATA_DIR: directory, MICHI_TITLE_MODEL_KIRO: 'off' });
    const { closeDb, initDb } = require('../src/services/db') as typeof import('../src/services/db');
    const repo = require('../src/services/dbRepository') as typeof import('../src/services/dbRepository');
    const { configureRuntimeDeps, __resetRuntimeDeps } = require('../src/agents/runtimeDeps') as typeof import('../src/agents/runtimeDeps');
    const { clearAllSessions } = require('../src/agents/sessionRegistry') as typeof import('../src/agents/sessionRegistry');
    const config = require('../src/services/agentConfig') as typeof import('../src/services/agentConfig');
    const { ChatHub } = require('../src/agents/chatHub') as typeof import('../src/agents/chatHub');
    const { michiTestHost } = require('./helpers/michiTestHost') as typeof import('./helpers/michiTestHost');
    const { kiroEnvOptions } = require('../src/agents/michiKiroOptions') as typeof import('../src/agents/michiKiroOptions');
    closeDb(); initDb();
    configureRuntimeDeps({ historyStore: { getNode: repo.getNode, listMessages: repo.listMessages,
      getWorkspace: repo.getWorkspace, getWorkspaceInstructions: repo.getWorkspaceInstructions }, dataDir: directory,
      providerKeys: { getProviderApiKey: () => null },
      agentConfig: { getAgentConfig: config.getAgentConfig, resolveModel: config.resolveModel, resolveReasoning: config.resolveReasoning } });
    let runtime: AcpAgentRuntime | undefined;
    try {
      runtime = new (require('michi-runtime/internal/adapters/kiro/AcpAgentRuntime').AcpAgentRuntime)({
        bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
        defaultCwd: directory, ...kiroEnvOptions(), host: michiTestHost(), engine,
      }) as AcpAgentRuntime;
      const nodeId = randomUUID();
      const session: AgentSession = await runtime.newSession({
        cwd: directory, sessionId: nodeId, enableFollowUps: false,
        model: process.env.MICHI_KIRO_SMOKE_MODEL ?? 'claude-haiku-5.5',
      });
      assert.equal(runtime.descriptor.harness.interruptAck.availability, 'native');
      assert.equal(runtime.descriptor.topology.cancel, 'native-ack');
      assert.equal(runtime.descriptor.harness.usage.availability, 'native');

      // 1. Stop a streaming turn through the hub, as POST /cancel does.
      const hub = new ChatHub({ retentionMs: 1_000, workspaceIdForNode: () => 'kiro-cancel-smoke',
        persistence: { begin: () => {}, checkpoint: () => {}, finalize: () => {} } });
      const events: ChatStreamEvent[] = [];
      hub.subscribe(nodeId, { send: (event: ChatStreamEvent) => events.push(event), close: () => {} } as never);
      const { done } = await hub.startTurn({ chatId: nodeId, nodeId, session, turnId: 'cancel-1',
        text: 'Count from 1 to 400, writing each number as an English word on its own line. Do not use any tools.' });
      await until(() => events.some((e) => e.event === 'chunk'), 120_000, 'the first chunk');
      const cancelAt = Date.now();
      assert.equal(hub.cancel(nodeId, 'cancel-1'), true);
      await done;
      const endedMs = Date.now() - cancelAt;
      const phases = events.filter((e) => e.event === 'cancel_phase').map((e) => e.data as { phase: string; source?: string; nativeMethod?: string });
      console.info(`${engine}: cancel → done in ${endedMs} ms; phases ${JSON.stringify(phases.map((p) => `${p.phase}:${p.source}`))}`);
      assert.deepEqual(phases.map((p) => p.phase), ['requested', 'acknowledged', 'settled']);
      assert.equal(phases[1].source, 'native', 'Kiro itself confirmed the stop');
      assert.equal(phases[1].nativeMethod, 'session/cancel + stopReason cancelled');
      assert.equal((events.find((e) => e.event === 'done')!.data as { stopReason?: string }).stopReason, 'cancelled');
      assert.ok(endedMs < 5_000, `the turn ended within the cancel deadline (${endedMs} ms)`);

      // 2. The same native session answers the next prompt.
      const next: any[] = [];
      for await (const event of session.send('Reply with exactly the two letters OK and nothing else. Do not use any tools.')) {
        next.push(event);
        if (event.kind === 'permission_request') session.cancelPermission?.(event.requestId);
      }
      const text = next.filter((e) => e.kind === 'chunk').map((e) => e.text).join('');
      console.info(`${engine}: follow-up ${JSON.stringify(text.slice(0, 200))}`);
      assert.match(text, /\bOK\b/);
      assert.ok(!/four|five|three hundred/i.test(text), 'nothing of the cancelled turn leaks into the next one');
      assert.equal(next.at(-1)?.kind, 'turn_end');
      assert.equal(next.at(-1)?.stopReason, 'end_turn');

      // 3. Kiro's metering: credits and context %, no token counts.
      const usage = next.find((e) => e.kind === 'usage_summary');
      console.info(`${engine}: usage ${JSON.stringify(usage)}`);
      assert.ok(usage, 'the completed turn reports usage');
      assert.equal(usage.charge?.unit, 'credits');
      assert.equal(usage.charge?.provenance, 'native_metering');
      assert.ok(usage.charge.amount > 0, 'Kiro charged credits for the turn');
      assert.ok(Number.isFinite(usage.contextUsagePercentage) && usage.contextUsagePercentage > 0);
      assert.equal('inputTokens' in usage || 'outputTokens' in usage || 'tokens' in usage, false, 'no token counts are invented');
    } finally {
      await runtime?.shutdown().catch(() => {});
      clearAllSessions();
      __resetRuntimeDeps();
      closeDb();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
