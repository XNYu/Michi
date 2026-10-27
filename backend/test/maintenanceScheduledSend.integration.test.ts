import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentRuntime, AgentSession, AgentTurnInput, NewAgentSessionOptions } from '../src/agents/types';
import { registerRuntime } from '../src/agents/registry';
import { clearAllSessions, getSessionForOwner } from '../src/agents/sessionRegistry';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { ChatHub } from '../src/agents/chatHub';
import { closeDb, getDb, initDb } from '../src/services/db';
import { getNode, saveNode, saveWorkspace } from '../src/services/dbRepository';
import { ChatManager } from '../src/services/chatManager';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { ChatScheduledJobExecutor } from '../src/services/scheduledJobs/chatExecutor';
import type { ScheduledJobRecord, ScheduledJobRunRecord } from '../src/services/scheduledJobs/repository';
import { MAINTENANCE_BOOTSTRAP_INSTRUCTIONS, META_AGENT_MAINTENANCE_TOOL_NAMES } from '../src/agents/maintenancePolicy';

let tmpDir: string;
let optionsSeen: NewAgentSessionOptions | undefined;
let turnInputSeen: AgentTurnInput | undefined;
let runtime: AgentRuntime;
let sessionCreations = 0;

function maintenanceRuntime(): AgentRuntime {
  return {
    id: 'pi', label: 'Pi',
    descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
    capabilities: {
      modes: false, permissions: true, models: true, providerModels: false, reasoning: true,
      supportedReasoningLevels: ['low', 'medium', 'high'], apiKeys: false, warmSessions: false,
      saveContext: false, spawnBranches: false, nativeResume: false,
    },
    async warm() {},
    async listModels() { return [{ id: 'auto', isDefault: true, supportsReasoning: false }]; },
    async newSession(opts) {
      sessionCreations += 1;
      optionsSeen = opts;
      const session: AgentSession = {
        id: opts.sessionId!, runtimeId: 'pi', runtimeProfileHash: opts.profileHash ?? null,
        currentModelId: opts.model ?? null, getHistory: () => [], getPendingAssistant: () => undefined,
        send(_text, input) {
          turnInputSeen = input;
          return (async function* (): AsyncIterableIterator<NormalizedEvent> {
            yield { kind: 'turn_end', stopReason: 'end_turn' };
          })();
        },
        async cancel() {},
      };
      return session;
    },
    async releaseSession() {},
    async shutdown() {},
  };
}

const scheduledJob = {
  id: 'job-maintenance', ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: 'ws-maintenance',
  name: 'Page maintenance', prompt: 'Update relevant Spaces', schedule: { kind: 'every', everySeconds: 3600 },
  runtimeId: 'pi', providerId: null, modelId: 'auto', reasoning: null, permissionMode: 'trust',
  sessionMode: 'fresh', persistentNodeId: null, notify: false, enabled: true, autoPaused: false,
  consecutiveFailures: 0, timeoutSeconds: 600, nextRunAt: null, lastRunAt: null, lastStatus: null,
  lastError: null, createdAt: 1, updatedAt: 1,
} as ScheduledJobRecord;
const scheduledRun = { id: 'run-maintenance' } as ScheduledJobRunRecord;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-maintenance-send-'));
  process.env.MICHI_DATA_DIR = tmpDir;
  closeDb();
  initDb();
  saveWorkspace({ id: 'ws-maintenance', name: 'Maintenance', cwd: tmpDir, created_at: 1, updated_at: 1 });
  getDb().prepare(`INSERT INTO scheduled_jobs(id,workspace_id,name,prompt,schedule,created_at,updated_at)
    VALUES(?,?,?,?,?,1,1)`).run(scheduledJob.id, scheduledJob.workspaceId, scheduledJob.name, scheduledJob.prompt,
      JSON.stringify(scheduledJob.schedule));
  getDb().prepare(`INSERT INTO page_maintenance_configs(workspace_id,owner_user_id,job_id,completion_cursor,updated_at)
    VALUES(?,?,?,0,1)`).run(scheduledJob.workspaceId, LOCAL_AGENT_OWNER_ID, scheduledJob.id);
  optionsSeen = undefined;
  turnInputSeen = undefined;
  sessionCreations = 0;
  runtime = maintenanceRuntime();
  registerRuntime(runtime);
});

afterEach(() => {
  clearAllSessions();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('scheduled maintenance opens a restricted ChatManager session and sends its trusted source manifest', async () => {
  const chatHub = new ChatHub({ retentionMs: 100 });
  const manager = new ChatManager(undefined, tmpDir);
  manager.resolvePrimaryAgentBinding = async () => { throw new Error('maintenance must not consult the primary agent binding'); };
  const executor = new ChatScheduledJobExecutor({
    chatHub,
    getRuntime: (id) => id === 'pi' ? runtime : undefined,
    ensureSession: (input) => manager.ensureParentSession(input),
    clock: () => 10,
  });
  const context = {
    workspaceId: 'ws-maintenance', ownerUserId: LOCAL_AGENT_OWNER_ID, jobId: scheduledJob.id,
    runId: scheduledRun.id, claimedBy: 'worker-1', configRevision: 4, planId: 'plan-1',
    sources: [{ sourceTurnId: 'source-turn', evidence: { nodeId: 'source-node', turnId: 'source-turn', assistantId: 'source-assistant' },
      manifest: [{ kind: 'page' as const, id: 'page-1', revision: 7, pageIds: ['page-1'] }] }],
  };
  const handle = await executor.start(scheduledJob, scheduledRun, { onAttention: () => {}, maintenanceContext: context });
  const outcome = await handle.done;

  assert.equal(outcome.status, 'succeeded');
  assert.equal(optionsSeen?.toolProfile?.maintenance, true);
  assert.deepEqual(optionsSeen?.toolProfile?.allowedToolNames, META_AGENT_MAINTENANCE_TOOL_NAMES);
  assert.equal(optionsSeen?.bootstrapInstructions, MAINTENANCE_BOOTSTRAP_INSTRUCTIONS);
  assert.equal(optionsSeen?.provider, null);
  assert.equal(optionsSeen?.model, 'auto');
  assert.equal(sessionCreations, 1, 'the maintenance session must be created with its restricted profile');
  assert.equal(turnInputSeen?.maintenanceContext?.planId, 'plan-1');
  assert.deepEqual(turnInputSeen?.maintenanceContext?.sources[0]?.manifest, context.sources[0].manifest);
  const nodeId = optionsSeen?.sessionId;
  assert.ok(nodeId);
  assert.equal(getNode(nodeId)?.maintenance_job_id, scheduledJob.id);
  saveNode({ id: nodeId, workspace_id: 'ws-maintenance', kind: 'chat', status: 'idle', minimized: 0,
    spawned_by_agent: 0, created_at: 10, maintenance_job_id: null });
  assert.equal(getNode(nodeId)?.maintenance_job_id, scheduledJob.id, 'client-style graph sync cannot clear the marker');
  const clonedNodeId = `${nodeId}-clone`;
  saveNode({ id: clonedNodeId, workspace_id: 'ws-maintenance', parent_node_id: nodeId, kind: 'chat', status: 'idle',
    minimized: 0, spawned_by_agent: 0, created_at: 11 });
  assert.equal(getNode(clonedNodeId)?.maintenance_job_id, scheduledJob.id, 'cloned maintenance transcripts inherit the restriction');
  await assert.rejects(manager.ensureParentSession({ ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: 'ws-maintenance', nodeId }),
    /only be opened by their managed job/);
  const live = getSessionForOwner(nodeId, { mode: 'interactive', key: nodeId }, LOCAL_AGENT_OWNER_ID);
  assert.ok(live);
  live.runtimeProfileHash = 'wrong-profile';
  await assert.rejects(manager.ensureParentSession({ ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: 'ws-maintenance', nodeId, maintenance: true }),
    /different runtime profile/);
});
